import { open, type DB } from '@op-engineering/op-sqlite';
import { createDbAdapter, type DbAdapter } from './adapter';
import { runMigrations } from './migrations';
import { detectFts5, getFts5Status, type Fts5Status } from './fts5';

let adapter: DbAdapter | null = null;

export interface DatabaseInitResult {
  db: DbAdapter;
  fts5: Fts5Status;
}

/**
 * 打开 op-sqlite 数据库并执行迁移；同时探测 FTS5。
 * 探测必须在写入任何索引之前完成，决定写 rag_fts 还是 rag_lexical。
 */
export async function initDatabase(name = 'reading.db'): Promise<DatabaseInitResult> {
  if (adapter) return { db: adapter, fts5: getFts5Status() };

  const raw: DB = open({ name });
  const db = createDbAdapter(raw);

  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON');
  const fts5 = await detectFts5(db);
  await runMigrations(db);

  adapter = db;
  return { db: adapter, fts5 };
}

/** 诊断页用：重新跑一次 FTS5 探针。 */
export async function recheckFts5(): Promise<Fts5Status> {
  if (!adapter) throw new Error('数据库尚未初始化');
  return detectFts5(adapter);
}

export function getDatabase(): DbAdapter {
  if (!adapter) throw new Error('数据库尚未初始化，请先调用 initDatabase()');
  return adapter;
}

export function closeDatabase(): void {
  adapter?.close();
  adapter = null;
}
