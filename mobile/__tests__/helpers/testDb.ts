import { DatabaseSync } from 'node:sqlite';
import type { DbAdapter, DbExecutor, DbValue } from '../../src/db/adapter';
import { runMigrations } from '../../src/db/migrations';
import { LOCAL_USER_ID } from '../../src/db/schema';

export interface TestDb {
  raw: DatabaseSync;
  db: DbAdapter;
  close: () => void;
}

export function createAdapter(raw: DatabaseSync): DbAdapter {
  const executor: DbExecutor = {
    async execute(sql, params) {
      const result = raw.prepare(sql).run(...((params ?? []) as never[]));
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    async queryAll<T>(sql: string, params?: DbValue[]): Promise<T[]> {
      return raw.prepare(sql).all(...((params ?? []) as never[])) as unknown as T[];
    },
    async queryOne<T>(sql: string, params?: DbValue[]): Promise<T | null> {
      const row = raw.prepare(sql).get(...((params ?? []) as never[]));
      return (row as unknown as T | undefined) ?? null;
    },
  };

  return {
    ...executor,
    async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      raw.exec('BEGIN');
      try {
        const result = await fn(executor);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      raw.close();
    },
  };
}

export async function createTestDb(): Promise<TestDb> {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const db = createAdapter(raw);
  await runMigrations(db);
  return { raw, db, close: () => raw.close() };
}

export async function insertBook(
  db: DbAdapter,
  params: { id: string; title: string; format?: 'txt' | 'epub' },
): Promise<void> {
  await db.execute(
    `INSERT INTO books_meta
      (id, user_id, title, filename, original_name, format, size, size_formatted, index_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      params.id,
      LOCAL_USER_ID,
      params.title,
      `${params.id}.${params.format ?? 'txt'}`,
      `${params.title}.${params.format ?? 'txt'}`,
      params.format ?? 'txt',
      1000,
      '1 KB',
    ],
  );
}
