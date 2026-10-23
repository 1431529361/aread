import { afterEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../src/core/types';
import { isFts5Available, setFts5Available } from '../src/db/fts5';
import { LOCAL_USER_ID } from '../src/db/schema';
import {
  createBook,
  deleteBookRecord,
  findBookByHash,
  getBook,
  listBooks,
  saveReadingProgress,
  updateBookIndexState,
} from '../src/db/repositories/books';
import {
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  getOrCreateBookConversation,
  listConversationsForBook,
  listMessages,
  updateMessageCitations,
} from '../src/db/repositories/conversations';
import { addHighlight, deleteHighlight, listHighlights } from '../src/db/repositories/highlights';
import { queryFts, writeLexicalIndex } from '../src/db/repositories/chunks';
import {
  deleteSetting,
  getJsonSetting,
  getSetting,
  setJsonSetting,
  setSetting,
} from '../src/db/repositories/settings';
import { createTestDb, insertBook } from './helpers/testDb';

afterEach(() => {
  setFts5Available(true);
});

describe('books repository', () => {
  it('创建、按最近阅读排序、保存 locator 进度', async () => {
    const { db, close } = await createTestDb();
    try {
      await createBook(db, {
        id: 'b1',
        userId: LOCAL_USER_ID,
        title: '书一',
        format: 'txt',
        filename: 'b1.txt',
        originalName: '书一.txt',
        fileUri: 'file:///books/b1.txt',
        fileHash: 'hash-1',
        size: 1024,
        sizeFormatted: '1.0 KB',
        charCount: 1200,
        now: '2026-01-01T00:00:00.000Z',
      });
      await createBook(db, {
        id: 'b2',
        userId: LOCAL_USER_ID,
        title: '书二',
        format: 'txt',
        filename: 'b2.txt',
        originalName: '书二.txt',
        fileUri: 'file:///books/b2.txt',
        fileHash: 'hash-2',
        size: 2048,
        sizeFormatted: '2.0 KB',
        charCount: 2400,
        now: '2026-01-02T00:00:00.000Z',
      });

      const initial = await listBooks(db, LOCAL_USER_ID);
      expect(initial.map((book) => book.id)).toEqual(['b2', 'b1']);
      expect(initial[0].author).toBe('未知');
      expect(initial[0].indexStatus).toBe('pending');
      expect(initial[0].lastLocator).toBeNull();

      const byHash = await findBookByHash(db, {
        userId: LOCAL_USER_ID,
        fileHash: 'hash-1',
      });
      expect(byHash?.id).toBe('b1');

      await saveReadingProgress(db, {
        userId: LOCAL_USER_ID,
        bookId: 'b1',
        progress: 0.5,
        locator: { kind: 'txt', href: null, start: 600, end: 620 },
        now: '2026-01-03T00:00:00.000Z',
      });

      const updated = await getBook(db, { userId: LOCAL_USER_ID, bookId: 'b1' });
      expect(updated?.readProgress).toBe(0.5);
      expect(updated?.lastRead).toBe('2026-01-03T00:00:00.000Z');
      expect(updated?.lastLocator).toEqual({ kind: 'txt', href: null, start: 600, end: 620 });

      const reordered = await listBooks(db, LOCAL_USER_ID);
      expect(reordered.map((book) => book.id)).toEqual(['b1', 'b2']);

      await saveReadingProgress(db, {
        userId: LOCAL_USER_ID,
        bookId: 'b1',
        progress: 9,
        locator: { kind: 'txt', href: null, start: 1200, end: 1200 },
      });
      expect((await getBook(db, { userId: LOCAL_USER_ID, bookId: 'b1' }))?.readProgress).toBe(1);

      await updateBookIndexState(db, {
        userId: LOCAL_USER_ID,
        bookId: 'b1',
        status: 'lexical_ready',
        progress: 100,
      });
      const indexed = await getBook(db, { userId: LOCAL_USER_ID, bookId: 'b1' });
      expect(indexed?.indexStatus).toBe('lexical_ready');
      expect(indexed?.indexProgress).toBe(100);

      await deleteBookRecord(db, { userId: LOCAL_USER_ID, bookId: 'b2' });
      expect(await getBook(db, { userId: LOCAL_USER_ID, bookId: 'b2' })).toBeNull();
    } finally {
      close();
    }
  });
});

describe('conversations repository', () => {
  it('自动归档旧会话、生成标题并保留引用快照', async () => {
    const { db, close } = await createTestDb();
    try {
      const first = await createConversation(db, {
        userId: LOCAL_USER_ID,
        bookId: 'b1',
        now: '2026-02-01T00:00:00.000Z',
      });
      expect(first.title).toBe('新对话');
      expect(first.scope).toBe('book');

      const userMessage = await appendMessage(db, {
        conversationId: first.id,
        role: 'user',
        content: '  帮我\n总结这一段  ',
      });
      expect(userMessage.seq).toBe(1);
      const titled = await getConversation(db, {
        userId: LOCAL_USER_ID,
        conversationId: first.id,
      });
      expect(titled?.title).toBe('帮我 总结这一段');

      const evidence: Evidence[] = [
        {
          citationId: 1,
          hit: {
            chunkId: 11,
            bookId: 'b1',
            bookTitle: '书一',
            chapter: '第一章',
            text: '被引用的原文',
            loc: { kind: 'txt', href: null, start: 10, end: 20 },
            score: 0.75,
            sources: ['fts'],
          },
        },
      ];
      const assistant = await appendMessage(db, {
        conversationId: first.id,
        role: 'assistant',
        content: '这是回答 [C1]',
        citations: evidence,
      });
      expect(assistant.seq).toBe(2);
      expect(assistant.citations).toEqual(evidence);

      await updateMessageCitations(db, {
        messageId: assistant.id,
        citations: [{ ...evidence[0], citationId: 2 }],
      });
      const messages = await listMessages(db, first.id);
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[1].citations?.[0]?.citationId).toBe(2);

      expect((await getOrCreateBookConversation(db, { userId: LOCAL_USER_ID, bookId: 'b1' })).id).toBe(
        first.id,
      );

      const second = await createConversation(db, {
        userId: LOCAL_USER_ID,
        bookId: 'b1',
        now: '2026-02-02T00:00:00.000Z',
      });
      expect(second.id).not.toBe(first.id);
      expect(
        (
          await getConversation(db, {
            userId: LOCAL_USER_ID,
            conversationId: first.id,
          })
        )?.status,
      ).toBe('archived');
      expect(
        (await getOrCreateBookConversation(db, { userId: LOCAL_USER_ID, bookId: 'b1' })).id,
      ).toBe(second.id);

      const all = await listConversationsForBook(db, {
        userId: LOCAL_USER_ID,
        bookId: 'b1',
      });
      expect(all.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());

      await deleteConversation(db, { userId: LOCAL_USER_ID, conversationId: second.id });
      expect(
        await getConversation(db, { userId: LOCAL_USER_ID, conversationId: second.id }),
      ).toBeNull();
      expect(await listMessages(db, second.id)).toEqual([]);
    } finally {
      close();
    }
  });
});

describe('highlights repository', () => {
  it('写入、按位置排序并删除划线', async () => {
    const { db, close } = await createTestDb();
    try {
      const late = await addHighlight(db, {
        bookId: 'b1',
        loc: { kind: 'txt', href: null, start: 30, end: 35 },
        selectedText: '后面的句子',
        color: 'green',
      });
      const early = await addHighlight(db, {
        bookId: 'b1',
        loc: { kind: 'txt', href: null, start: 5, end: 9 },
        selectedText: '前面的句子',
        note: '备注',
      });

      const list = await listHighlights(db, 'b1');
      expect(list.map((item) => item.id)).toEqual([early.id, late.id]);
      expect(list[0].loc).toEqual({ kind: 'txt', href: null, start: 5, end: 9 });
      expect(list[0].note).toBe('备注');
      expect(list[1].color).toBe('green');

      await deleteHighlight(db, { bookId: 'b1', highlightId: early.id });
      const after = await listHighlights(db, 'b1');
      expect(after.map((item) => item.id)).toEqual([late.id]);
    } finally {
      close();
    }
  });
});

describe('settings repository', () => {
  it('字符串与 JSON 设置可读写、覆盖和删除', async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await getSetting(db, 'missing')).toBeNull();

      await setSetting(db, { key: 'onboarding_done', value: '1' });
      expect(await getSetting(db, 'onboarding_done')).toBe('1');
      await setSetting(db, { key: 'onboarding_done', value: '0' });
      expect(await getSetting(db, 'onboarding_done')).toBe('0');

      await setJsonSetting(db, 'reader_prefs', { theme: 'dark', fontSize: 20 });
      expect(await getJsonSetting(db, 'reader_prefs', {})).toEqual({
        theme: 'dark',
        fontSize: 20,
      });

      await setSetting(db, { key: 'reader_prefs', value: '{bad json' });
      expect(await getJsonSetting(db, 'reader_prefs', { theme: 'light' })).toEqual({
        theme: 'light',
      });

      await deleteSetting(db, 'onboarding_done');
      expect(await getSetting(db, 'onboarding_done')).toBeNull();
    } finally {
      close();
    }
  });
});

describe('migration v7 与 FTS 降级', () => {
  it('包含阅读位置、引用与 rag_lexical 结构', async () => {
    const { raw, close } = await createTestDb();
    try {
      const bookColumns = (
        raw.prepare('PRAGMA table_info(books_meta)').all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(bookColumns).toContain('last_locator');

      const messageColumns = (
        raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(messageColumns).toContain('citations');

      const objects = new Set(
        (
          raw
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
            .all() as Array<{ name: string }>
        ).map((row) => row.name),
      );
      expect(objects.has('rag_lexical')).toBe(true);
      expect(objects.has('idx_rag_lexical_book')).toBe(true);
    } finally {
      close();
    }
  });

  it('FTS5 不可用时写入 rag_lexical 并返回 BM25 命中', async () => {
    const { db, raw, close } = await createTestDb();
    try {
      await insertBook(db, { id: 'b1', title: '书一' });
      setFts5Available(false);
      expect(isFts5Available()).toBe(false);

      const chunks = [
        {
          index: 0,
          chapter: '第一章',
          text: '阅读是随身携带的避难所',
          loc: { kind: 'txt', href: null, start: 0, end: 11 } as const,
        },
        {
          index: 1,
          chapter: '第二章',
          text: '今天的天气很好',
          loc: { kind: 'txt', href: null, start: 12, end: 20 } as const,
        },
      ];
      const ids = await writeLexicalIndex(db, {
        userId: LOCAL_USER_ID,
        bookId: 'b1',
        chunks,
      });
      expect(ids).toHaveLength(2);

      const lexicalCount = raw
        .prepare('SELECT COUNT(*) AS c FROM rag_lexical')
        .get() as { c: number };
      expect(lexicalCount.c).toBe(2);
      const ftsCount = raw.prepare('SELECT COUNT(*) AS c FROM rag_fts').get() as {
        c: number;
      };
      expect(ftsCount.c).toBe(0);

      const hits = await queryFts(db, { query: '阅读', bookId: 'b1', limit: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0].chunk.text).toContain('阅读');
      expect(hits[0].score).toBeGreaterThan(0);

      expect(await queryFts(db, { query: '骆驼祥子', bookId: 'b1', limit: 5 })).toEqual([]);

      setFts5Available(true);
      await writeLexicalIndex(db, {
        userId: LOCAL_USER_ID,
        bookId: 'b1',
        chunks,
      });
      const ftsCountAfter = raw.prepare('SELECT COUNT(*) AS c FROM rag_fts').get() as {
        c: number;
      };
      expect(ftsCountAfter.c).toBe(2);
      const lexicalAfter = raw
        .prepare('SELECT COUNT(*) AS c FROM rag_lexical')
        .get() as { c: number };
      expect(lexicalAfter.c).toBe(0);

      const ftsHits = await queryFts(db, { query: '阅读', bookId: 'b1', limit: 5 });
      expect(ftsHits[0]?.chunk.text).toContain('阅读');
      expect(ftsHits[0]?.score).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});
