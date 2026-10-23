import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOLS,
  executeToolByName,
  getToolSchemas,
} from '../src/core/agent/registry';
import { searchInBookTool } from '../src/core/agent/tools/searchInBook';
import { getChapterInfoTool } from '../src/core/agent/tools/getChapterInfo';
import { lookupCharacterTool } from '../src/core/agent/tools/lookupCharacter';
import { listChaptersTool } from '../src/core/agent/tools/listChapters';
import { getChapterTool } from '../src/core/agent/tools/getChapter';
import { getSurroundingTextTool } from '../src/core/agent/tools/getSurroundingText';
import { searchLibraryTool } from '../src/core/agent/tools/searchLibrary';
import { searchNotesTool } from '../src/core/agent/tools/searchNotes';
import { getReadingHistoryTool } from '../src/core/agent/tools/getReadingHistory';
import type { AgentToolContext } from '../src/core/agent/types';
import type { RetrievalHit } from '../src/core/types';
import { LOCAL_USER_ID } from '../src/db/schema';
import { createTestDb, insertBook } from './helpers/testDb';

const hit: RetrievalHit = {
  chunkId: 7,
  bookId: 'b1',
  bookTitle: '测试书',
  chapter: '第二章',
  text: '自由是重要的价值。',
  loc: { kind: 'txt', href: null, start: 100, end: 110 },
  score: 0.5,
  sources: ['fts', 'vector'],
};

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    db: {} as AgentToolContext['db'],
    userId: 'local',
    bookId: 'b1',
    bookName: '测试书',
    content: '第一章 开端\n这是第一章。\n第二章 自由\n自由是重要的价值。',
    retrieve: async () => [hit],
    ...overrides,
  };
}

describe('searchInBook', () => {
  it('返回检索命中的 locator 与来源', async () => {
    const result = (await searchInBookTool.execute({ query: '自由' }, context())) as {
      source: string;
      results: Array<{ loc: unknown; text: string; sources: string[] }>;
    };

    expect(result.source).toBe('hybrid');
    expect(result.results[0].loc).toEqual({
      kind: 'txt',
      href: null,
      start: 100,
      end: 110,
    });
    expect(result.results[0].sources).toEqual(['fts', 'vector']);
  });

  it('无检索结果时回退全文子串并给出 locator', async () => {
    const result = (await searchInBookTool.execute(
      { query: '第二章' },
      context({ retrieve: async () => [] }),
    )) as {
      source: string;
      results: Array<{ chapter: string; loc: { start: number; end: number } }>;
    };

    expect(result.source).toBe('fulltext');
    expect(result.results[0].chapter).toBe('第二章 自由');
    expect(result.results[0].loc.start).toBeGreaterThanOrEqual(0);
  });

  it('空 query 返回错误', async () => {
    expect(await searchInBookTool.execute({}, context())).toEqual({
      error: 'query 不能为空',
    });
  });
});

describe('getChapterInfo', () => {
  it('按序号返回章节与 locator', async () => {
    const result = (await getChapterInfoTool.execute(
      { chapterIndex: 2 },
      context(),
    )) as {
      title: string;
      loc: { start: number; end: number };
      preview: string;
    };

    expect(result.title).toBe('第二章 自由');
    expect(result.loc.start).toBeGreaterThan(0);
    expect(result.preview).toContain('自由是重要的价值');
  });

  it('找不到章节返回错误', async () => {
    expect(
      await getChapterInfoTool.execute({ chapterTitle: '不存在' }, context()),
    ).toMatchObject({ error: '未找到匹配章节' });
  });
});

describe('listChapters / getChapter / getSurroundingText', () => {
  it('列出章节结构与位置', async () => {
    const result = (await listChaptersTool.execute({}, context())) as {
      total: number;
      chapters: Array<{ index: number; title: string; loc: { start: number } }>;
    };

    expect(result.total).toBe(2);
    expect(result.chapters[0]).toMatchObject({ index: 1, title: '第一章 开端' });
    expect(result.chapters[1].title).toBe('第二章 自由');
  });

  it('读取章节正文并限制长度', async () => {
    const result = (await getChapterTool.execute(
      { chapterIndex: 2, maxChars: 500 },
      context(),
    )) as { title: string; text: string; loc: { start: number } };

    expect(result.title).toBe('第二章 自由');
    expect(result.text).toContain('自由是重要的价值');
    expect(result.loc.start).toBeGreaterThan(0);
  });

  it('按 locator 读取前后文', async () => {
    const result = (await getSurroundingTextTool.execute(
      { start: 10, end: 20, radius: 5 },
      context(),
    )) as { loc: { start: number; end: number }; text: string };

    expect(result.loc.start).toBe(5);
    expect(result.loc.end).toBe(25);
    expect(result.text).toContain('第二章');
  });
});

describe('searchLibrary', () => {
  it('返回跨书检索结果与 locator', async () => {
    const result = (await searchLibraryTool.execute(
      { query: '自由' },
      context({ searchLibrary: async () => [hit] }),
    )) as { source: string; results: Array<{ bookTitle: string; loc: unknown }> };

    expect(result.source).toBe('library');
    expect(result.results[0].bookTitle).toBe('测试书');
    expect(result.results[0].loc).toEqual(hit.loc);
  });

  it('未注入跨书检索时返回错误', async () => {
    expect(await searchLibraryTool.execute({ query: '自由' }, context())).toEqual({
      error: '当前未启用书库检索',
    });
  });
});

describe('searchNotes / getReadingHistory', () => {
  it('检索记忆笔记并读取阅读记录', async () => {
    const { db, close } = await createTestDb();
    await insertBook(db, { id: 'b1', title: '测试书' });
    await db.execute(
      'UPDATE books_meta SET last_read = ?, read_progress = ? WHERE id = ?',
      ['2026-10-23T00:00:00.000Z', 0.5, 'b1'],
    );
    await db.execute(
      `INSERT INTO task_results (user_id, book_id, task_type, content)
       VALUES (?, ?, ?, ?)`,
      [LOCAL_USER_ID, 'b1', 'generate-notes', '笔记中提到自由与责任。'],
    );
    const notesContext = context({ db });

    const notes = (await searchNotesTool.execute(
      { query: '自由' },
      notesContext,
    )) as { matches: Array<{ bookTitle: string; text: string }> };
    expect(notes.matches).toHaveLength(1);
    expect(notes.matches[0].bookTitle).toBe('测试书');
    expect(notes.matches[0].text).toContain('自由');

    const history = (await getReadingHistoryTool.execute(
      {},
      notesContext,
    )) as { items: Array<{ bookId: string; progress: number }> };
    expect(history.items[0]).toMatchObject({ bookId: 'b1', progress: 0.5 });
    close();
  });
});

describe('lookupCharacter', () => {
  it('统计出现次数并返回带 locator 的上下文', async () => {
    const content = `${'啊'.repeat(100)}张三走进房间。${'呀'.repeat(100)}张三看着窗外。`;
    const result = (await lookupCharacterTool.execute(
      { name: '张三' },
      context({ content }),
    )) as {
      total: number;
      occurrences: number;
      samples: Array<{ loc: { start: number; end: number }; snippet: string }>;
    };

    expect(result.total).toBe(2);
    expect(result.occurrences).toBe(2);
    expect(result.samples[1].loc.start).toBeGreaterThan(result.samples[0].loc.start);
  });
});

describe('registry', () => {
  it('生成 OpenAI function schema', () => {
    const schemas = getToolSchemas();
    expect(schemas.map((schema) => schema.function.name)).toEqual([
      'searchInBook',
      'getChapterInfo',
      'lookupCharacter',
      'listChapters',
      'getChapter',
      'getSurroundingText',
      'searchLibrary',
      'searchNotes',
      'getReadingHistory',
    ]);
    expect(schemas[0].type).toBe('function');
  });

  it('未知工具返回错误', async () => {
    expect(await executeToolByName(DEFAULT_TOOLS, 'missing', {}, context())).toEqual({
      error: '未知工具: missing',
    });
  });
});
