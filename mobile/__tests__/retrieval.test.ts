import { describe, expect, it } from 'vitest';
import { LOCAL_USER_ID } from '../src/db/schema';
import { writeLexicalIndex } from '../src/db/repositories/chunks';
import { upsertVectors } from '../src/db/repositories/vectors';
import { retrieveInBook, retrieveInLibrary } from '../src/services/retrieval';
import { createTestDb, insertBook } from './helpers/testDb';

async function seedLibrary() {
  const { db, raw, close } = await createTestDb();
  await insertBook(db, { id: 'b1', title: '书一' });
  await insertBook(db, { id: 'b2', title: '书二' });

  const b1Ids = await writeLexicalIndex(db, {
    userId: LOCAL_USER_ID,
    bookId: 'b1',
    chunks: [
      {
        index: 0,
        chapter: '第一章',
        text: '自由是重要的价值，自由需要制度保障。',
        loc: { kind: 'txt', href: null, start: 0, end: 20 },
      },
      {
        index: 1,
        chapter: '第二章',
        text: '这是一个关于爱情的故事。',
        loc: { kind: 'txt', href: null, start: 21, end: 34 },
      },
      {
        index: 2,
        chapter: '第三章',
        text: '无关的天气描述。',
        loc: { kind: 'txt', href: null, start: 35, end: 43 },
      },
    ],
  });

  const b2Ids = await writeLexicalIndex(db, {
    userId: LOCAL_USER_ID,
    bookId: 'b2',
    chunks: [
      {
        index: 0,
        chapter: '第一章',
        text: '自由与责任必须同时讨论。',
        loc: { kind: 'txt', href: null, start: 0, end: 13 },
      },
    ],
  });

  await upsertVectors(db, {
    bookId: 'b1',
    embedSig: 'sig1',
    dims: 4,
    items: [
      { chunkId: b1Ids[0], vector: [1, 0, 0, 0] },
      { chunkId: b1Ids[1], vector: [0, 1, 0, 0] },
      { chunkId: b1Ids[2], vector: [0, 0, 1, 0] },
    ],
  });
  await upsertVectors(db, {
    bookId: 'b2',
    embedSig: 'sig1',
    dims: 4,
    items: [{ chunkId: b2Ids[0], vector: [0.9, 0.1, 0, 0] }],
  });

  await db.execute(
    `UPDATE books_meta SET index_status = 'ready', embed_sig = 'sig1', embed_dims = 4
     WHERE id IN ('b1', 'b2')`,
  );

  return { db, raw, close, b1Ids, b2Ids };
}

const queryFree = async () => [1, 0, 0, 0];

describe('retrieveInBook', () => {
  it('返回单书命中，携带 locator 与双路来源', async () => {
    const { db, b1Ids, close } = await seedLibrary();

    const hits = await retrieveInBook('b1', {
      db,
      query: '自由',
      embedQuery: queryFree,
      activeSig: 'sig1',
      dims: 4,
      topK: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunkId).toBe(b1Ids[0]);
    expect(hits[0].sources).toContain('fts');
    expect(hits[0].sources).toContain('vector');
    expect(hits[0].loc).toEqual({ kind: 'txt', href: null, start: 0, end: 20 });
    expect(hits[0].bookTitle).toBe('书一');
    expect(new Set(hits.map((hit) => hit.bookId))).toEqual(new Set(['b1']));
    close();
  });

  it('embedding 失败时降级为 FTS', async () => {
    const { db, close } = await seedLibrary();

    const hits = await retrieveInBook('b1', {
      db,
      query: '自由',
      embedQuery: async () => {
        throw new Error('embedding offline');
      },
      activeSig: 'sig1',
      dims: 4,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.sources.join(',') === 'fts')).toBe(true);
    close();
  });

  it('active sig 不匹配时跳过向量路', async () => {
    const { db, close } = await seedLibrary();

    const hits = await retrieveInBook('b1', {
      db,
      query: '自由',
      embedQuery: queryFree,
      activeSig: 'sig-other',
      dims: 4,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => !hit.sources.includes('vector'))).toBe(true);
    close();
  });

  it('FTS 特殊字符不会导致检索报错', async () => {
    const { db, close } = await seedLibrary();

    const hits = await retrieveInBook('b1', {
      db,
      query: '自由"* -',
      embedQuery: queryFree,
      activeSig: 'sig1',
      dims: 4,
    });

    expect(Array.isArray(hits)).toBe(true);
    close();
  });

  it('启用 rerank 后按重排结果截取 Top-K', async () => {
    const { db, b1Ids, close } = await seedLibrary();

    const hits = await retrieveInBook('b1', {
      db,
      query: '自由',
      embedQuery: queryFree,
      activeSig: 'sig1',
      dims: 4,
      topK: 2,
      rerank: async (_query, candidates) =>
        [...candidates].sort((a, b) => b.chunkId - a.chunkId),
    });

    expect(hits.map((hit) => hit.chunkId)).toEqual([b1Ids[2], b1Ids[1]]);
    close();
  });

  it('rerank 失败时回退原排序且不影响检索', async () => {
    const { db, close } = await seedLibrary();

    const hits = await retrieveInBook('b1', {
      db,
      query: '自由',
      embedQuery: queryFree,
      activeSig: 'sig1',
      dims: 4,
      topK: 2,
      rerank: async () => {
        throw new Error('rerank offline');
      },
    });

    expect(hits.length).toBeGreaterThan(0);
    close();
  });
});

describe('retrieveInLibrary', () => {
  it('FTS 粗筛后按书加载向量精排，返回跨书结果', async () => {
    const { db, b1Ids, b2Ids, close } = await seedLibrary();

    const hits = await retrieveInLibrary({
      db,
      query: '自由',
      embedQuery: queryFree,
      activeSig: 'sig1',
      dims: 4,
      topK: 5,
    });

    const ids = hits.map((hit) => hit.chunkId);
    expect(ids).toContain(b1Ids[0]);
    expect(ids).toContain(b2Ids[0]);
    expect(ids).not.toContain(b1Ids[1]);

    const b2Hit = hits.find((hit) => hit.bookId === 'b2');
    expect(b2Hit?.bookTitle).toBe('书二');
    expect(b2Hit?.loc).toEqual({ kind: 'txt', href: null, start: 0, end: 13 });
    close();
  });

  it('配置切换期间只使用已激活当前 sig 的书籍向量', async () => {
    const { db, close } = await seedLibrary();
    await db.execute(
      "UPDATE books_meta SET index_status = 'partial', embed_sig = 'old-sig' WHERE id = 'b2'",
    );

    const hits = await retrieveInLibrary({
      db,
      query: '自由',
      embedQuery: queryFree,
      activeSig: 'sig1',
      dims: 4,
      topK: 5,
    });
    const b2 = hits.find((hit) => hit.bookId === 'b2');
    expect(b2?.sources).toEqual(['fts']);
    close();
  });

  it('没有 FTS 候选时不做全库向量扫描', async () => {
    const { db, close } = await seedLibrary();

    const hits = await retrieveInLibrary({
      db,
      query: '量子纠缠',
      embedQuery: queryFree,
      activeSig: 'sig1',
      dims: 4,
    });

    expect(hits).toEqual([]);
    close();
  });

  it('向量加载计划使用 (book_id, embed_sig) 索引', async () => {
    const { raw, close } = await seedLibrary();

    const plan = raw
      .prepare(
        'EXPLAIN QUERY PLAN SELECT chunk_id, vector FROM rag_vectors WHERE book_id = ? AND embed_sig = ?',
      )
      .all('b1', 'sig1') as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(' ');

    expect(detail).toContain('idx_rag_vectors_book_sig');
    close();
  });
});
