import type { DbAdapter, DbExecutor } from './adapter';
import {
  LATEST_SCHEMA_VERSION,
  SCHEMA_STATEMENTS,
  SEED_STATEMENTS,
} from './schema';
import { isFts5Available } from './fts5';

export interface Migration {
  version: number;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [...SCHEMA_STATEMENTS, ...SEED_STATEMENTS],
  },
  {
    version: 2,
    statements: [
      // 允许同一 chunk 同时保留旧/新 embed_sig 向量：重建失败时旧向量仍可检索
      `CREATE TABLE rag_vectors_v2 (
        chunk_id INTEGER NOT NULL REFERENCES rag_chunks(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL,
        embed_sig TEXT NOT NULL,
        dims INTEGER NOT NULL DEFAULT 1024,
        vector BLOB NOT NULL,
        PRIMARY KEY (chunk_id, embed_sig)
      )`,
      `INSERT INTO rag_vectors_v2 (chunk_id, book_id, embed_sig, dims, vector)
        SELECT chunk_id, book_id, embed_sig, dims, vector FROM rag_vectors`,
      `DROP TABLE rag_vectors`,
      `ALTER TABLE rag_vectors_v2 RENAME TO rag_vectors`,
      `CREATE INDEX IF NOT EXISTS idx_rag_vectors_book_sig ON rag_vectors(book_id, embed_sig)`,
    ],
  },
  {
    version: 3,
    statements: [
      `ALTER TABLE user_memories ADD COLUMN layer TEXT NOT NULL DEFAULT 'profile'`,
      `ALTER TABLE user_memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE user_memories ADD COLUMN source_message_id INTEGER`,
      `ALTER TABLE user_memories ADD COLUMN valid_from TEXT`,
      `ALTER TABLE user_memories ADD COLUMN superseded_by INTEGER`,
      `ALTER TABLE user_memories ADD COLUMN last_used_at TEXT`,
      `ALTER TABLE user_memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_mem_user_layer ON user_memories(user_id, layer, status)`,
    ],
  },
  {
    version: 4,
    statements: [
      `ALTER TABLE rag_chunks ADD COLUMN parent_index INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_rag_chunks_book_parent ON rag_chunks(book_id, parent_index)`,
    ],
  },
  {
    version: 5,
    statements: [`ALTER TABLE provider_config ADD COLUMN rerank_model TEXT`],
  },
  {
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        total_nodes INTEGER NOT NULL DEFAULT 0,
        completed_nodes INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_task_runs_book_task
        ON task_runs(book_id, task_type, started_at DESC)`,
      `CREATE TABLE IF NOT EXISTS task_node_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        unit_key TEXT NOT NULL,
        unit_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        model_sig TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(book_id, task_type, unit_key, prompt_version, model_sig)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_task_node_cache_lookup
        ON task_node_cache(book_id, task_type, unit_key, prompt_version, model_sig)`,
      `ALTER TABLE provider_config ADD COLUMN context_window INTEGER NOT NULL DEFAULT 200000`,
    ],
  },
  {
    version: 7,
    statements: [
      // M0-B：阅读位置、助手消息引用快照
      `ALTER TABLE books_meta ADD COLUMN last_locator TEXT`,
      `ALTER TABLE messages ADD COLUMN citations TEXT`,
      // FTS5 不可用时的降级索引（M0-B 设备能力验证的兜底路径）
      `CREATE TABLE IF NOT EXISTS rag_lexical (
        chunk_id INTEGER PRIMARY KEY REFERENCES rag_chunks(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL,
        tokens TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rag_lexical_book ON rag_lexical(book_id)`,
    ],
  },
  {
    version: 8,
    statements: [
      `CREATE TABLE IF NOT EXISTS rag_book_vectors (
        book_id TEXT NOT NULL,
        embed_sig TEXT NOT NULL,
        dims INTEGER NOT NULL DEFAULT 1024,
        vector BLOB NOT NULL,
        PRIMARY KEY (book_id, embed_sig)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_rag_book_vectors_sig
        ON rag_book_vectors(embed_sig, book_id)`,
    ],
  },
];

export async function getSchemaVersion(db: DbExecutor): Promise<number> {
  const row = await db.queryOne<{ user_version: number }>('PRAGMA user_version');
  return Number(row?.user_version ?? 0);
}

/**
 * 顺序执行未应用的 migration。每个 migration 与其 user_version 更新在同一事务内。
 * 库版本高于当前 App 时直接报错，避免旧代码写坏新 schema。
 */
export async function runMigrations(db: DbAdapter): Promise<number> {
  let current = await getSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `数据库版本（${current}）高于当前 App 支持的版本（${LATEST_SCHEMA_VERSION}）`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    await db.transaction(async (tx) => {
      for (const statement of migration.statements) {
        // FTS5 不可用时不创建虚拟表，留一个同名的普通表占位，
        // 词法检索统一走 rag_lexical + JS BM25。
        if (!isFts5Available() && /CREATE\s+VIRTUAL\s+TABLE[^;]*rag_fts/i.test(statement)) {
          await tx.execute(
            `CREATE TABLE IF NOT EXISTS rag_fts (
               chunk_id INTEGER,
               book_id TEXT,
               tokens TEXT
             )`,
          );
          continue;
        }
        await tx.execute(statement);
      }
      await tx.execute(`PRAGMA user_version = ${Math.floor(migration.version)}`);
    });

    current = migration.version;
  }

  return current;
}
