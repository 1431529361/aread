import { describe, expect, it } from 'vitest';
import type { ChunkResult } from '../src/core/rag/chunk';
import { LOCAL_USER_ID } from '../src/db/schema';
import {
  IndexingCancelledError,
  getBookIndexStatus,
  indexBook,
} from '../src/services/indexing';
import { queryFts } from '../src/db/repositories/chunks';
import { countVectorsForBookSig } from '../src/db/repositories/vectors';
import { createTestDb, insertBook } from './helpers/testDb';

function makeChunks(count: number): ChunkResult[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    chapter: `第${index + 1}章`,
    text: `第${index + 1}块内容：自由与阅读 ${'补充内容'.repeat(10)}`,
    loc_kind: 'txt' as const,
    loc_href: null,
    loc_start: index * 100,
    loc_end: index * 100 + 60,
  }));
}

function vectorFor(text: string): number[] {
  const vector = new Array(1024).fill(0);
  vector[0] = 1;
  vector[1] = (text.length % 7) / 7;
  return vector;
}

function embedWithSig(
  sig: string,
  behavior: { failOnCall?: number; abort?: () => void } = {},
) {
  let calls = 0;
  return {
    embedSig: sig,
    dims: 1024,
    embedTexts: async (texts: readonly string[]) => {
      calls++;
      if (behavior.failOnCall === calls) throw new Error('模拟 embedding 失败');
      behavior.abort?.();
      return texts.map(vectorFor);
    },
    calls: () => calls,
  };
}

async function readMeta(db: Awaited<ReturnType<typeof createTestDb>>['db'], bookId: string) {
  return db.queryOne<{
    index_status: string;
    index_progress: number;
    embed_sig: string | null;
    embed_dims: number | null;
  }>('SELECT index_status, index_progress, embed_sig, embed_dims FROM books_meta WHERE id = ?', [
    bookId,
  ]);
}

describe('indexBook', () => {
  it('无 embedding 时完成 lexical_ready，FTS 可检索', async () => {
    const { db, close } = await createTestDb();
    await insertBook(db, { id: 'b1', title: '书一' });

    const result = await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      content: '占位全文',
      chunks: makeChunks(3),
    });

    expect(result).toMatchObject({ status: 'lexical_ready', chunks: 3, failed: 0 });
    const hits = await queryFts(db, { bookId: 'b1', query: '自由', limit: 10 });
    expect(hits).toHaveLength(3);
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'none' })).toBe(0);

    const status = await getBookIndexStatus(db, { bookId: 'b1', userId: LOCAL_USER_ID });
    expect(status.status).toBe('lexical_ready');
    expect(status.progress).toBeCloseTo(0.5);
    close();
  });

  it('未传 chunks 时默认使用 parent-child 分块', async () => {
    const { db, close } = await createTestDb();
    await insertBook(db, { id: 'b1', title: '书一' });

    const content = '内容段落。'.repeat(700);
    const result = await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      content,
    });

    expect(result.status).toBe('lexical_ready');
    const rows = await db.queryAll<{ parent_index: number | null }>(
      'SELECT parent_index FROM rag_chunks WHERE book_id = ?',
      ['b1'],
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((row) => row.parent_index)).size).toBeGreaterThan(1);
    expect(rows.every((row) => row.parent_index != null)).toBe(true);
    close();
  });

  it('full + embedding 完成后状态 ready，写入向量并清理旧 sig', async () => {
    const { db, close } = await createTestDb();
    await insertBook(db, { id: 'b1', title: '书一' });

    const first = embedWithSig('sig-a');
    const result = await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      chunks: makeChunks(3),
      embed: first,
    });

    expect(result).toMatchObject({ status: 'ready', chunks: 3, embedded: 3, failed: 0 });
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-a' })).toBe(3);
    expect(
      await db.queryOne<{ embed_sig: string }>(
        'SELECT embed_sig FROM rag_book_vectors WHERE book_id = ?',
        ['b1'],
      ),
    ).toEqual({ embed_sig: 'sig-a' });

    let meta = await readMeta(db, 'b1');
    expect(meta).toMatchObject({ index_status: 'ready', embed_sig: 'sig-a', embed_dims: 1024 });

    const second = embedWithSig('sig-b');
    const switched = await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      mode: 'embedding',
      embed: second,
    });

    expect(switched.status).toBe('ready');
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-b' })).toBe(3);
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-a' })).toBe(0);
    expect(
      await db.queryAll<{ embed_sig: string }>(
        'SELECT embed_sig FROM rag_book_vectors WHERE book_id = ?',
        ['b1'],
      ),
    ).toEqual([{ embed_sig: 'sig-b' }]);
    meta = await readMeta(db, 'b1');
    expect(meta?.embed_sig).toBe('sig-b');
    close();
  });

  it('embedding 部分失败时标记 partial，可只补失败块续跑', async () => {
    const { db, close } = await createTestDb();
    await insertBook(db, { id: 'b1', title: '书一' });

    const failing = embedWithSig('sig-a', { failOnCall: 2 });
    const partial = await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      chunks: makeChunks(25),
      embed: failing,
    });

    expect(partial.status).toBe('partial');
    expect(partial.failed).toBe(15);
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-a' })).toBe(10);

    const status = await getBookIndexStatus(db, { bookId: 'b1', userId: LOCAL_USER_ID });
    expect(status.status).toBe('partial');
    expect(status.error).toContain('模拟 embedding 失败');

    const hits = await queryFts(db, { bookId: 'b1', query: '自由', limit: 30 });
    expect(hits).toHaveLength(25);

    const retry = embedWithSig('sig-a');
    const progress: Array<{ done: number; total: number }> = [];
    const resumed = await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      mode: 'embedding',
      embed: retry,
      onProgress: (value) => progress.push(value),
    });

    expect(resumed.status).toBe('ready');
    expect(progress[0]).toMatchObject({ done: 10, total: 25 });
    expect(progress.at(-1)).toMatchObject({ done: 25, total: 25 });
    expect(progress.every((value) => value.done <= value.total)).toBe(true);
    expect(retry.calls()).toBe(2);
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-a' })).toBe(25);
    close();
  });

  it('换模型失败时保留旧 sig 向量和 books_meta 的 active sig', async () => {
    const { db, close } = await createTestDb();
    await insertBook(db, { id: 'b1', title: '书一' });

    await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      chunks: makeChunks(3),
      embed: embedWithSig('sig-a'),
    });

    const failing = embedWithSig('sig-b', { failOnCall: 1 });
    const result = await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      mode: 'embedding',
      embed: failing,
    });

    expect(result.status).toBe('partial');
    const meta = await readMeta(db, 'b1');
    expect(meta?.embed_sig).toBe('sig-a');
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-a' })).toBe(3);
    close();
  });

  it('最终切换前配置变化时保留旧 active sig 和旧向量', async () => {
    const { db, close } = await createTestDb();
    await insertBook(db, { id: 'b1', title: '书一' });

    await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      chunks: makeChunks(3),
      embed: embedWithSig('sig-a'),
    });

    let checks = 0;
    const result = await indexBook({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      mode: 'embedding',
      embed: embedWithSig('sig-b'),
      isEmbedSigCurrent: async () => ++checks === 1,
    });

    expect(result).toMatchObject({ status: 'partial', failed: 0 });
    expect(result.error).toContain('配置已改变');
    const meta = await readMeta(db, 'b1');
    expect(meta?.embed_sig).toBe('sig-a');
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-a' })).toBe(3);
    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-b' })).toBe(3);
    close();
  });

  it('取消索引后保留已完成部分并标记 partial', async () => {
    const { db, close } = await createTestDb();
    await insertBook(db, { id: 'b1', title: '书一' });

    const controller = new AbortController();
    const embed = embedWithSig('sig-a', { abort: () => controller.abort() });

    await expect(
      indexBook({
        db,
        userId: LOCAL_USER_ID,
        bookId: 'b1',
        chunks: makeChunks(25),
        embed,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(IndexingCancelledError);

    expect(await countVectorsForBookSig(db, { bookId: 'b1', embedSig: 'sig-a' })).toBe(10);
    const status = await getBookIndexStatus(db, { bookId: 'b1', userId: LOCAL_USER_ID });
    expect(status.status).toBe('partial');
    expect(status.error).toContain('取消');
    close();
  });
});
