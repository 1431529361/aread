export const LOCAL_USER_ID = 'local';
export const LATEST_SCHEMA_VERSION = 2;

/**
 * 移动端 schema（v1）
 * - 不迁移 Web 数据，从空库开始
 * - 删除 api_keys / custom_providers，改为 provider_config + SecureStore
 * - rag_vectors 用普通表存 float32 BLOB；rag_fts 用 FTS5 存预分词结果
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS books_meta (
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
    file_uri TEXT,
    file_hash TEXT,
    char_count INTEGER DEFAULT 0,
    index_status TEXT NOT NULL DEFAULT 'pending',
    index_progress REAL NOT NULL DEFAULT 0,
    embed_sig TEXT,
    embed_dims INTEGER,
    PRIMARY KEY (id, user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS rag_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chapter TEXT,
    text TEXT NOT NULL,
    loc_kind TEXT NOT NULL DEFAULT 'txt',
    loc_href TEXT,
    loc_start INTEGER NOT NULL DEFAULT 0,
    loc_end INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS rag_vectors (
    chunk_id INTEGER PRIMARY KEY REFERENCES rag_chunks(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL,
    embed_sig TEXT NOT NULL,
    dims INTEGER NOT NULL DEFAULT 1024,
    vector BLOB NOT NULL
  )`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
    chunk_id UNINDEXED,
    book_id UNINDEXED,
    tokens,
    tokenize = 'unicode61'
  )`,

  `CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    loc_kind TEXT NOT NULL DEFAULT 'txt',
    loc_href TEXT,
    loc_start INTEGER NOT NULL,
    loc_end INTEGER NOT NULL,
    selected_text TEXT NOT NULL,
    note TEXT,
    color TEXT NOT NULL DEFAULT 'yellow',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT,
    scope TEXT NOT NULL DEFAULT 'book',
    title TEXT DEFAULT '新对话',
    status TEXT DEFAULT 'active',
    summary TEXT DEFAULT '',
    summary_upto INTEGER DEFAULT 0,
    token_estimate INTEGER DEFAULT 0,
    provider TEXT,
    model TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    token_estimate INTEGER DEFAULT 0,
    in_window INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT DEFAULT 'fact',
    content TEXT NOT NULL,
    salience REAL DEFAULT 1.0,
    source_conv TEXT,
    embedding TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, content)
  )`,

  `CREATE TABLE IF NOT EXISTS task_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, book_id, task_type)
  )`,

  `CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
  )`,

  `CREATE TABLE IF NOT EXISTS index_jobs (
    book_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL DEFAULT 'pending',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS provider_config (
    kind TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    dims INTEGER,
    dimensions_param INTEGER,
    masked_key TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_books_meta_user ON books_meta(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rag_chunks_user_book ON rag_chunks(user_id, book_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rag_chunks_book_order ON rag_chunks(book_id, chunk_index)`,
  `CREATE INDEX IF NOT EXISTS idx_rag_vectors_book_sig ON rag_vectors(book_id, embed_sig)`,
  `CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conv_user_book ON conversations(user_id, book_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_conv_scope ON conversations(scope, status)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_mem_user ON user_memories(user_id, salience DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_taskres_user_book ON task_results(user_id, book_id)`,
];

export const SEED_STATEMENTS: readonly string[] = [
  `INSERT OR IGNORE INTO users (id, username, password_hash) VALUES ('${LOCAL_USER_ID}', 'local', '')`,
];
