// 数据库迁移系统
// 每个迁移是一个幂等的 SQL 函数，迁移按版本号顺序执行
// 版本号必须单调递增，新增迁移只需在末尾追加

const logger = require('./logger');
const log = logger.child('migrations');

// 当前 schema 版本号；新增迁移时同步更新 SCHEMA_VERSION
const SCHEMA_VERSION = 1;

// 迁移列表：每个迁移为 { version, name, up(db) }
// up 接收 sqlJsDb 实例（裸 sql.js，不是包装对象）
const MIGRATIONS = [
    {
        version: 1,
        name: 'initial_schema',
        up: (db) => {
            db.run(`
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
                CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
                CREATE INDEX IF NOT EXISTS idx_custom_prov_user ON custom_providers(user_id);
                CREATE INDEX IF NOT EXISTS idx_books_meta_user ON books_meta(user_id);
                CREATE INDEX IF NOT EXISTS idx_history_user_date ON history(user_id, created_at DESC);
            `);
        }
    }
    // 未来迁移示例：
    // {
    //     version: 2,
    //     name: 'add_user_preferences',
    //     up: (db) => {
    //         db.run(`ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'`);
    //     }
    // }
];

function runMigrations(sqlJsDb) {
    // 创建迁移记录表
    sqlJsDb.run(`
        CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT DEFAULT (datetime('now'))
        )
    `);

    const appliedRows = [];
    const stmt = sqlJsDb.prepare('SELECT version FROM _migrations');
    while (stmt.step()) appliedRows.push(stmt.getAsObject().version);
    stmt.free();
    const applied = new Set(appliedRows);

    const pending = MIGRATIONS.filter(m => !applied.has(m.version)).sort((a, b) => a.version - b.version);

    if (pending.length === 0) {
        log.debug('所有迁移已是最新', { currentVersion: SCHEMA_VERSION });
        return;
    }

    for (const migration of pending) {
        if (migration.version > SCHEMA_VERSION) {
            throw new Error(`迁移版本 ${migration.version} 高于 SCHEMA_VERSION ${SCHEMA_VERSION}`);
        }
        log.info('应用迁移', { version: migration.version, name: migration.name });
        try {
            sqlJsDb.run('BEGIN');
            migration.up(sqlJsDb);
            sqlJsDb.run('INSERT INTO _migrations (version, name) VALUES (?, ?)', [migration.version, migration.name]);
            sqlJsDb.run('COMMIT');
            log.info('迁移完成', { version: migration.version });
        } catch (err) {
            sqlJsDb.run('ROLLBACK');
            log.error('迁移失败，已回滚', { version: migration.version, error: err.message });
            throw err;
        }
    }

    log.info('数据库迁移完成', { from: applied.size, to: SCHEMA_VERSION });
}

module.exports = { runMigrations, SCHEMA_VERSION, MIGRATIONS };
