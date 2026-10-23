import type { DbAdapter, DbExecutor } from './adapter';
import {
  LATEST_SCHEMA_VERSION,
  SCHEMA_STATEMENTS,
  SEED_STATEMENTS,
} from './schema';

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
        await tx.execute(statement);
      }
      await tx.execute(`PRAGMA user_version = ${Math.floor(migration.version)}`);
    });

    current = migration.version;
  }

  return current;
}
