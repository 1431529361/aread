import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { DbAdapter, DbExecutor, DbValue } from '../src/db/adapter';
import { runMigrations } from '../src/db/migrations';
import { LATEST_SCHEMA_VERSION } from '../src/db/schema';

function createTestAdapter(raw: DatabaseSync): DbAdapter {
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

describe('runMigrations', () => {
  it('从空库建出全部表并写入 user_version', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = createTestAdapter(raw);

    const version = await runMigrations(db);
    expect(version).toBe(LATEST_SCHEMA_VERSION);

    const tables = new Set(
      (
        raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    for (const table of [
      'users',
      'books_meta',
      'rag_chunks',
      'rag_vectors',
      'rag_book_vectors',
      'rag_fts',
      'highlights',
      'conversations',
      'messages',
      'user_memories',
      'task_results',
      'user_settings',
      'index_jobs',
      'provider_config',
    ]) {
      expect(tables.has(table)).toBe(true);
    }

    const bookColumns = new Set(
      (
        raw.prepare('PRAGMA table_info(books_meta)').all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    for (const column of [
      'file_uri',
      'file_hash',
      'char_count',
      'index_status',
      'index_progress',
      'embed_sig',
      'embed_dims',
    ]) {
      expect(bookColumns.has(column)).toBe(true);
    }

    const chunkColumns = new Set(
      (
        raw.prepare('PRAGMA table_info(rag_chunks)').all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    for (const column of ['loc_kind', 'loc_href', 'loc_start', 'loc_end', 'parent_index']) {
      expect(chunkColumns.has(column)).toBe(true);
    }

    const conversationColumns = new Set(
      (
        raw.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    expect(conversationColumns.has('scope')).toBe(true);

    const memoryColumns = new Set(
      (
        raw.prepare('PRAGMA table_info(user_memories)').all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    for (const column of [
      'layer',
      'status',
      'embedding',
      'source_message_id',
      'valid_from',
      'superseded_by',
      'last_used_at',
      'use_count',
    ]) {
      expect(memoryColumns.has(column)).toBe(true);
    }

    const providerColumns = new Set(
      (
        raw.prepare('PRAGMA table_info(provider_config)').all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    expect(providerColumns.has('rerank_model')).toBe(true);
    expect(providerColumns.has('context_window')).toBe(true);

    const userVersion = raw.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    expect(userVersion.user_version).toBe(LATEST_SCHEMA_VERSION);

    const vectorPk = (
      raw.prepare('PRAGMA table_info(rag_vectors)').all() as Array<{
        name: string;
        pk: number;
      }>
    )
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    expect(vectorPk).toEqual(['chunk_id', 'embed_sig']);

    const user = raw.prepare('SELECT id FROM users').get() as { id: string };
    expect(user.id).toBe('local');

    await db.execute('INSERT INTO rag_fts (chunk_id, book_id, tokens) VALUES (?, ?, ?)', [
      1,
      'book-1',
      '你 好 你好',
    ]);
    const hits = raw
      .prepare('SELECT chunk_id FROM rag_fts WHERE rag_fts MATCH ?')
      .all('"你好"') as Array<{ chunk_id: number }>;
    expect(hits[0].chunk_id).toBe(1);

    db.close();
  });

  it('重复执行是幂等的', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = createTestAdapter(raw);

    await runMigrations(db);
    await runMigrations(db);

    const userVersion = raw.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    const count = raw.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    expect(userVersion.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(count.c).toBe(1);

    db.close();
  });

  it('数据库版本高于 App 时拒绝启动迁移', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = createTestAdapter(raw);

    await runMigrations(db);
    raw.exec('PRAGMA user_version = 99');

    await expect(runMigrations(db)).rejects.toThrow(/高于/);

    db.close();
  });
});
