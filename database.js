const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');

let db = null;

function initDB() {
    db = new Database(DB_PATH);
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

        CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_custom_prov_user ON custom_providers(user_id);
        CREATE INDEX IF NOT EXISTS idx_books_meta_user ON books_meta(user_id);
        CREATE INDEX IF NOT EXISTS idx_history_user_date ON history(user_id, created_at DESC);
    `);

    return db;
}

function getDB() {
    if (!db) {
        throw new Error('Database not initialized. Call initDB() first.');
    }
    return db;
}

module.exports = { initDB, getDB };
