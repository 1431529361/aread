import { open } from '@op-engineering/op-sqlite';
import { createDbAdapter, type DbAdapter } from './adapter';
import { runMigrations } from './migrations';

let adapter: DbAdapter | null = null;

export async function initDatabase(name = 'reading.db'): Promise<DbAdapter> {
  if (adapter) return adapter;

  const raw = open({ name });
  const db = createDbAdapter(raw);

  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON');
  await runMigrations(db);

  adapter = db;
  return adapter;
}

export function getDatabase(): DbAdapter {
  if (!adapter) throw new Error('数据库尚未初始化，请先调用 initDatabase()');
  return adapter;
}

export function closeDatabase(): void {
  adapter?.close();
  adapter = null;
}
