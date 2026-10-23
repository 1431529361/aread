import { describe, expect, it } from 'vitest';
import { LOCAL_USER_ID } from '../src/db/schema';
import { writeLexicalIndex } from '../src/db/repositories/chunks';
import { retrieveInBook } from '../src/services/retrieval';
import { expandRetrievalHits } from '../src/services/parentExpansion';
import type { RetrievalHit } from '../src/core/types';
import { createTestDb, insertBook } from './helpers/testDb';

async function seedParents() {
  const { db, close } = await createTestDb();
  await insertBook(db, { id: 'b1', title: '测试书' });

  const ids = await writeLexicalIndex(db, {
    userId: LOCAL_USER_ID,
    bookId: 'b1',
    chunks: [
      {
        index: 0,
        chapter: '第一章',
        text: '第一段：自由是重要的价值。',
        loc: { kind: 'txt', href: null, start: 0, end: 14 },
        parentIndex: 0,
      },
      {
        index: 1,
        chapter: '第一章',
        text: '第二段：自由需要制度保障。',
        loc: { kind: 'txt', href: null, start: 15, end: 29 },
        parentIndex: 0,
      },
      {
        index: 2,
        chapter: '第二章',
        text: '第三段：这是一个爱情故事。',
        loc: { kind: 'txt', href: null, start: 30, end: 44 },
        parentIndex: 1,
      },
    ],
  });

  return { db, close, ids };
}

describe('expandRetrievalHits', () => {
  it('同一父块的多个子命中合并为一条，locator 仍指向子块', async () => {
    const { db, close, ids } = await seedParents();

    const hits: RetrievalHit[] = [
      {
        chunkId: ids[0],
        bookId: 'b1',
        bookTitle: '测试书',
        chapter: '第一章',
        text: '第一段：自由是重要的价值。',
        loc: { kind: 'txt', href: null, start: 0, end: 14 },
        score: 1,
        sources: ['fts'],
        parentIndex: 0,
      },
      {
        chunkId: ids[1],
        bookId: 'b1',
        bookTitle: '测试书',
        chapter: '第一章',
        text: '第二段：自由需要制度保障。',
        loc: { kind: 'txt', href: null, start: 15, end: 29 },
        score: 0.8,
        sources: ['fts'],
        parentIndex: 0,
      },
    ];

    const expanded = await expandRetrievalHits(db, hits);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].text).toBe(hits[0].text);
    expect(expanded[0].parentText).toContain('第一段');
    expect(expanded[0].parentText).toContain('第二段');
    expect(expanded[0].childHits).toHaveLength(2);
    expect(expanded[0].loc).toEqual(hits[0].loc);
    close();
  });

  it('不同父块保持独立，旧索引无 parent_index 时回退子块文本', async () => {
    const { db, close, ids } = await seedParents();

    const hits: RetrievalHit[] = [
      {
        chunkId: ids[0],
        bookId: 'b1',
        chapter: '第一章',
        text: '第一段',
        loc: { kind: 'txt', href: null, start: 0, end: 14 },
        score: 1,
        sources: ['fts'],
        parentIndex: 0,
      },
      {
        chunkId: ids[2],
        bookId: 'b1',
        chapter: '第二章',
        text: '第三段',
        loc: { kind: 'txt', href: null, start: 30, end: 44 },
        score: 0.5,
        sources: ['fts'],
        parentIndex: 1,
      },
      {
        chunkId: 999,
        bookId: 'b1',
        chapter: '旧块',
        text: '旧索引文本',
        loc: { kind: 'txt', href: null, start: 100, end: 105 },
        score: 0.1,
        sources: ['fts'],
        parentIndex: null,
      },
    ];

    const expanded = await expandRetrievalHits(db, hits);
    expect(expanded).toHaveLength(3);
    expect(expanded[2].parentText).toBe('旧索引文本');
    expect(expanded[2].childHits).toHaveLength(1);
    close();
  });

  it('检索后开启 expandParents 自动扩展父块', async () => {
    const { db, close } = await seedParents();

    const hits = await retrieveInBook('b1', {
      db,
      query: '自由',
      topK: 5,
      expandParents: true,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].parentText).toContain('第一段');
    expect(hits[0].parentText).toContain('第二段');
    expect(hits[0].childHits?.length).toBe(2);
    expect(hits[0].loc.start).toBe(0);
    close();
  });
});
