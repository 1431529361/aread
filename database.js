const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data.db');

let db = null;

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
    const sqliteDb = new Database(DB_PATH);
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

        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_custom_prov_user ON custom_providers(user_id);
        CREATE INDEX IF NOT EXISTS idx_books_meta_user ON books_meta(user_id);
        CREATE INDEX IF NOT EXISTS idx_history_user_date ON history(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_conv_user_book ON conversations(user_id, book_id, status);
        CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq);
        CREATE INDEX IF NOT EXISTS idx_mem_user ON user_memories(user_id, salience DESC);
        CREATE INDEX IF NOT EXISTS idx_taskres_user_book ON task_results(user_id, book_id);
    `);

    return db;
}

function getDB() {
    if (!db) throw new Error('Database not initialized. Call initDB() first.');
    return db;
}

module.exports = { initDB, getDB };
