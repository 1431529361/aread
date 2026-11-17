const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = __dirname;

// 进程级数据根：默认业务路径不变；设置 READER_DATA_ROOT 后，
// data.db / books / rag_index 全部跟随该根目录，供隔离测试使用。
function normalizeForCompare(p) {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsidePath(child, parent) {
    const c = normalizeForCompare(child);
    const par = normalizeForCompare(parent);
    return c === par || c.startsWith(par + path.sep);
}

function getDataRoot() {
    const raw = process.env.READER_DATA_ROOT;
    if (!raw || !raw.trim()) return REPO_ROOT;
    const root = path.resolve(raw.trim());
    // 安全护栏：数据根不得覆盖或落入业务数据目录，防止测试写操作触及真实数据
    const protectedPaths = [
        path.join(REPO_ROOT, 'books'),
        path.join(REPO_ROOT, 'rag_index'),
        path.join(REPO_ROOT, 'data.db')
    ];
    for (const p of protectedPaths) {
        if (isInsidePath(p, root) || isInsidePath(root, p)) {
            throw new Error(`READER_DATA_ROOT 与业务数据目录冲突，拒绝启动: ${root}（保护路径: ${p}）`);
        }
    }
    return root;
}

function getDbPath() {
    return path.join(getDataRoot(), 'data.db');
}

function getBooksDir() {
    return path.join(getDataRoot(), 'books');
}

function getRagIndexDir() {
    return path.join(getDataRoot(), 'rag_index');
}

let db = null;
let vecAvailable = false; // sqlite-vec 扩展是否加载成功（失败时 RAG 自动降级为纯 BM25）

/**
 * 使用 better-sqlite3 作为底层驱动（方案 A）。
 * - 同步 API、真正的增量写入与事务，消除 sql.js 的"每次写入全库落盘"写放大问题
 * - 对上层保持与旧封装一致的接口：prepare(sql) -> { get, all, run }、exec、pragma、close
 *   因此 server.js / auth.js 无需改动调用方式
 */
function createDbWrapper(sqliteDb) {
    return {
        // 直接复用原生 statement（其 get/all/run 均支持位置参数），
        // 但用轻封装统一 run 的返回结构，保持与旧代码 { changes } 的兼容
        prepare: (sql) => {
            const stmt = sqliteDb.prepare(sql);
            return {
                get: (...params) => stmt.get(...params),
                all: (...params) => stmt.all(...params),
                run: (...params) => {
                    const info = stmt.run(...params);
                    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
                }
            };
        },
        exec: (sql) => sqliteDb.exec(sql),
        pragma: (setting) => {
            try { sqliteDb.pragma(setting); } catch (e) {}
        },
        transaction: (fn) => sqliteDb.transaction(fn),
        close: () => sqliteDb.close(),
        _raw: sqliteDb
    };
}

async function initDB() {
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqliteDb = new Database(dbPath);

    // 加载 sqlite-vec 向量扩展（用于 RAG 向量检索）；加载失败不阻塞启动
    try {
        sqliteVec.load(sqliteDb);
        vecAvailable = true;
    } catch (e) {
        console.warn('sqlite-vec 扩展加载失败，向量检索不可用（RAG 将使用纯 BM25）:', e.message);
    }

    db = createDbWrapper(sqliteDb);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            masked_key TEXT,
            last_updated TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, provider)
        );
        CREATE TABLE IF NOT EXISTS custom_providers (
            id TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            api_endpoint TEXT NOT NULL,
            default_model TEXT NOT NULL,
            models TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT,
            PRIMARY KEY (id, user_id)
        );
        CREATE TABLE IF NOT EXISTS books_meta (
            id TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            filename TEXT NOT NULL,
            original_name TEXT NOT NULL,
            format TEXT NOT NULL,
            size INTEGER NOT NULL,
            size_formatted TEXT NOT NULL,
            upload_time TEXT DEFAULT (datetime('now')),
            author TEXT DEFAULT '未知',
            last_read TEXT,
            read_progress REAL DEFAULT 0,
            PRIMARY KEY (id, user_id)
        );
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            selected_text TEXT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- ==================== 会话管理相关表 ====================

        -- 会话表：每本书可有多个会话，同一时刻仅一个 active
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            book_id TEXT,
            title TEXT DEFAULT '新对话',
            status TEXT DEFAULT 'active',           -- active / archived
            summary TEXT DEFAULT '',                -- 滚动摘要（短期记忆）
            summary_upto INTEGER DEFAULT 0,         -- 已被摘要覆盖到的最大 message seq
            token_estimate INTEGER DEFAULT 0,       -- 当前工作窗口 token 估算
            provider TEXT,
            model TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- 消息表：会话内所有消息（含 tool 消息）
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,                     -- system / user / assistant / tool
            content TEXT,
            tool_calls TEXT,                        -- JSON（assistant 的 tool_calls）
            tool_call_id TEXT,                      -- tool 消息回填
            token_estimate INTEGER DEFAULT 0,
            in_window INTEGER DEFAULT 1,            -- 1=在工作窗口 0=已被压缩移出
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- 长期记忆表：跨会话、跨书的用户画像/偏好/事实
        CREATE TABLE IF NOT EXISTS user_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind TEXT DEFAULT 'fact',               -- preference / fact / interest
            content TEXT NOT NULL,
            salience REAL DEFAULT 1.0,              -- 重要度/置信度
            source_conv TEXT,
            embedding TEXT,                         -- 可选：JSON 向量
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, content)
        );

        -- AI 任务结果表：读书笔记/人物分析等 Multi-Agent 任务的产出缓存（按书+任务类型唯一）
        CREATE TABLE IF NOT EXISTS task_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            book_id TEXT NOT NULL,
            task_type TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, book_id, task_type)
        );

        -- ==================== RAG 相关表 ====================

        -- 用户设置表（通用 KV，如 embedding_provider）
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, key)
        );

        -- RAG 分块表：每本书的文本切块
        CREATE TABLE IF NOT EXISTS rag_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            book_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            chapter TEXT,
            text TEXT NOT NULL
        );

        -- RAG 索引元信息：记录建库时的 embedding 模型，保证查询侧同模型
        CREATE TABLE IF NOT EXISTS rag_index_meta (
            user_id TEXT NOT NULL,
            book_id TEXT NOT NULL,
            mode TEXT NOT NULL,                     -- embedding+bm25 / bm25
            embed_provider TEXT,
            embed_model TEXT,
            dims INTEGER,
            chunk_count INTEGER DEFAULT 0,
            indexed_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, book_id)
        );

        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_custom_prov_user ON custom_providers(user_id);
        CREATE INDEX IF NOT EXISTS idx_books_meta_user ON books_meta(user_id);
        CREATE INDEX IF NOT EXISTS idx_history_user_date ON history(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_conv_user_book ON conversations(user_id, book_id, status);
        CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq);
        CREATE INDEX IF NOT EXISTS idx_mem_user ON user_memories(user_id, salience DESC);
        CREATE INDEX IF NOT EXISTS idx_taskres_user_book ON task_results(user_id, book_id);
        CREATE INDEX IF NOT EXISTS idx_rag_chunks_user_book ON rag_chunks(user_id, book_id);
    `);

    // 向量虚拟表（vec0 不支持 IF NOT EXISTS 之外的普通建表语法差异，单独建）
    if (vecAvailable) {
        try {
            db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS rag_vec USING vec0(embedding float[1024])');
        } catch (e) {
            console.warn('创建 rag_vec 虚拟表失败，向量检索不可用:', e.message);
            vecAvailable = false;
        }
    }

    applyMigrations(db);

    return db;
}

// ==================== _schema 迁移登记 ====================
// 顺序迁移，单一登记机制；每个迁移幂等（记录已应用则跳过）。
// 真实数据迁移须先在隔离副本验证并备份；此处只做加法，不删除用户数据。
const MIGRATIONS = [
    {
        id: 'web_001_request_contract',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS requests (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    conversation_id TEXT,
                    user_message_id INTEGER,
                    assistant_message_id INTEGER,
                    status TEXT NOT NULL DEFAULT 'running',
                    error TEXT,
                    post_processing TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now')),
                    PRIMARY KEY (user_id, request_id)
                );
                CREATE INDEX IF NOT EXISTS idx_requests_conv ON requests(conversation_id);
            `);
            // messages 增列（旧消息 status 默认 completed、metadata 为 NULL，UI 标旧版）
            const cols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
            if (!cols.includes('request_id')) db.exec('ALTER TABLE messages ADD COLUMN request_id TEXT');
            if (!cols.includes('status')) db.exec("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'completed'");
            if (!cols.includes('metadata')) db.exec('ALTER TABLE messages ADD COLUMN metadata TEXT');
            db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_conv_seq_unique ON messages(conversation_id, seq)');
        }
    },
    {
        // P1b R1：定位列 + 索引版本表。只做加法；旧块/旧向量保留，active_version=NULL 标旧版。
        id: 'web_002_rag_locator',
        up(db) {
            const cols = db.prepare('PRAGMA table_info(rag_chunks)').all().map(c => c.name);
            const addCol = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE rag_chunks ADD COLUMN ${ddl}`); };
            addCol('index_version', 'index_version TEXT');
            addCol('content_hash', 'content_hash TEXT');
            addCol('chapter_id', 'chapter_id TEXT');
            addCol('chapter_ordinal', 'chapter_ordinal INTEGER');
            addCol('start_offset', 'start_offset INTEGER');
            addCol('end_offset', 'end_offset INTEGER');
            const metaCols = db.prepare('PRAGMA table_info(rag_index_meta)').all().map(c => c.name);
            if (!metaCols.includes('active_version')) db.exec('ALTER TABLE rag_index_meta ADD COLUMN active_version TEXT');
            db.exec(`
                CREATE TABLE IF NOT EXISTS rag_index_versions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    book_id TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    normalization_version TEXT NOT NULL,
                    chunker_version TEXT NOT NULL,
                    chunker_config_json TEXT NOT NULL,
                    embed_provider TEXT,
                    embed_model TEXT,
                    embed_fingerprint TEXT,
                    dims INTEGER,
                    distance_metric TEXT,
                    mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    chunk_count INTEGER DEFAULT 0,
                    vector_count INTEGER DEFAULT 0,
                    error_code TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    finished_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_chunks_version_pos
                    ON rag_chunks(user_id, book_id, index_version, chunk_index) WHERE index_version IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_rag_chunks_version
                    ON rag_chunks(user_id, book_id, index_version);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_versions_building
                    ON rag_index_versions(user_id, book_id) WHERE status = 'building';
                CREATE INDEX IF NOT EXISTS idx_rag_versions_user_book
                    ON rag_index_versions(user_id, book_id, status);
            `);
        }
    },
    {
        // P2 M1：记忆生命周期。事务内重建 user_memories（旧 UNIQUE(user_id,content) 无法只靠加索引取消），
        // 旧行候选化并保留 ID/正文/创建时间；sqlite_sequence 高水位显式保留，防止历史 MemoryRef 串条。
        // 旧表整表备份到 user_memories_legacy_backup（含原 embedding/非法 kind），仅供回滚核对，业务不召回。
        id: 'web_003_memory_lifecycle',
        up(db) {
            const oldCols = db.prepare('PRAGMA table_info(user_memories)').all().map(c => c.name);
            if (oldCols.includes('status')) return; // 已是新结构（防御性幂等）

            db.exec('CREATE TABLE IF NOT EXISTS user_memories_legacy_backup AS SELECT * FROM user_memories WHERE 0');
            db.exec('INSERT INTO user_memories_legacy_backup SELECT * FROM user_memories WHERE id NOT IN (SELECT id FROM user_memories_legacy_backup)');

            const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'user_memories'").get();
            const oldSeq = seqRow ? Number(seqRow.seq) : null;
            const oldCount = db.prepare('SELECT COUNT(*) c FROM user_memories').get().c;

            db.exec(`
                CREATE TABLE user_memories_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL DEFAULT 'fact'
                        CHECK (kind IN ('preference','fact','interest','reading_goal','open_question')),
                    scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user','book')),
                    book_id TEXT,
                    key TEXT NOT NULL,
                    content TEXT NOT NULL,
                    normalized_value TEXT,
                    status TEXT NOT NULL DEFAULT 'candidate'
                        CHECK (status IN ('candidate','active','superseded','expired','completed')),
                    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
                    source_type TEXT NOT NULL DEFAULT 'legacy'
                        CHECK (source_type IN ('user_message','user_edit','user_confirmation','legacy')),
                    source_conv TEXT,
                    source_message_id INTEGER,
                    source_start INTEGER,
                    source_end INTEGER,
                    order_message_id INTEGER,
                    salience REAL DEFAULT 1.0,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now')),
                    last_seen_at TEXT,
                    expires_at TEXT,
                    CHECK ((scope = 'user' AND book_id IS NULL) OR (scope = 'book' AND book_id IS NOT NULL)),
                    CHECK ((source_start IS NULL AND source_end IS NULL)
                        OR (source_start IS NOT NULL AND source_end IS NOT NULL AND source_start >= 0 AND source_end > source_start)),
                    CHECK (kind NOT IN ('reading_goal','open_question') OR scope = 'book')
                );
            `);
            // 旧 kind 合法则保留，非法/空映射为占位 fact（原值仅在备份表）；不推断真实作用域
            db.exec(`
                INSERT INTO user_memories_new
                    (id, user_id, kind, scope, book_id, key, content, normalized_value, status, revision,
                     source_type, source_conv, source_message_id, source_start, source_end, order_message_id,
                     salience, created_at, updated_at, last_seen_at, expires_at)
                SELECT id, user_id,
                    CASE WHEN kind IN ('preference','fact','interest','reading_goal','open_question') THEN kind ELSE 'fact' END,
                    'user', NULL, 'legacy:' || id, content, NULL, 'candidate', 1,
                    'legacy', source_conv, NULL, NULL, NULL, NULL,
                    salience, created_at, updated_at, NULL, NULL
                FROM user_memories
            `);
            const newCount = db.prepare('SELECT COUNT(*) c FROM user_memories_new').get().c;
            if (newCount !== oldCount) throw new Error(`记忆迁移行数不一致: ${oldCount} -> ${newCount}`);

            db.exec('DROP TABLE user_memories');
            db.exec('ALTER TABLE user_memories_new RENAME TO user_memories');
            if (oldSeq !== null) {
                // sqlite_sequence 为内部表（name 无唯一约束），先删后插显式保留高水位
                db.prepare("DELETE FROM sqlite_sequence WHERE name = 'user_memories'").run();
                db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('user_memories', ?)").run(oldSeq);
            }
            db.exec(`
                CREATE UNIQUE INDEX idx_mem_user_active ON user_memories(user_id, key) WHERE scope = 'user' AND status = 'active';
                CREATE UNIQUE INDEX idx_mem_book_active ON user_memories(user_id, book_id, key) WHERE scope = 'book' AND status = 'active';
                CREATE INDEX idx_mem_user_status ON user_memories(user_id, status);
                CREATE INDEX idx_mem_user ON user_memories(user_id, salience DESC);

                CREATE TABLE memory_user_state (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    memory_epoch INTEGER NOT NULL DEFAULT 0,
                    blocked_through_message_id INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT DEFAULT (datetime('now'))
                );

                -- 来源处理记录：只存标识与状态，不存正文；不级联于 messages/conversations，
                -- 删除源消息后记录仍在（防回写屏障），删除用户时随用户级联清理。
                CREATE TABLE memory_sources (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    message_id INTEGER NOT NULL,
                    request_id TEXT,
                    conversation_id TEXT,
                    expected_epoch INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','processing','done','skipped','failed')),
                    error_code TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now')),
                    PRIMARY KEY (user_id, message_id)
                );
                CREATE INDEX idx_memory_sources_state ON memory_sources(user_id, state);
                CREATE INDEX idx_memory_sources_request ON memory_sources(user_id, request_id);
            `);
            // 每用户屏障初始化为已有用户消息最大ID，避免升级后自动回扫历史
            const users = db.prepare('SELECT id FROM users').all();
            const maxMsg = db.prepare(`
                SELECT COALESCE(MAX(m.id), 0) AS maxId FROM messages m
                JOIN conversations c ON m.conversation_id = c.id
                WHERE c.user_id = ? AND m.role = 'user'
            `);
            const insState = db.prepare('INSERT OR IGNORE INTO memory_user_state (user_id, blocked_through_message_id) VALUES (?, ?)');
            for (const u of users) insState.run(u.id, maxMsg.get(u.id).maxId);
        }
    },
    {
        // P3-记忆 M5：记忆作用域内的语义向量（不复用书籍 rag_vec，语义空间不同）。
        // 仅 active 记忆建向量；删除记忆随外键级联清理；Embedding 不可用时召回降级为纯词法。
        id: 'web_004_memory_vectors',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS memory_vectors (
                    memory_id INTEGER PRIMARY KEY REFERENCES user_memories(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL,
                    dims INTEGER NOT NULL,
                    vec TEXT NOT NULL,
                    fingerprint TEXT,
                    updated_at TEXT DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_memory_vectors_user ON memory_vectors(user_id);
            `);
        }
    }
];

function applyMigrations(db) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime(\'now\')))');
    const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
    for (const m of MIGRATIONS) {
        if (applied.has(m.id)) continue;
        const tx = db.transaction(() => {
            m.up(db);
            db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id);
        });
        tx();
    }
}

function getDB() {
    if (!db) throw new Error('Database not initialized. Call initDB() first.');
    return db;
}

function isVecAvailable() {
    return vecAvailable;
}

module.exports = { initDB, getDB, isVecAvailable, getDataRoot, getDbPath, getBooksDir, getRagIndexDir, MIGRATIONS, applyMigrations };
