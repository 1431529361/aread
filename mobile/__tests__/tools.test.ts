import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOLS,
  executeToolByName,
  getToolSchemas,
} from '../src/core/agent/registry';
import { searchInBookTool } from '../src/core/agent/tools/searchInBook';
import { getChapterInfoTool } from '../src/core/agent/tools/getChapterInfo';
import { lookupCharacterTool } from '../src/core/agent/tools/lookupCharacter';
import type { AgentToolContext } from '../src/core/agent/types';
import type { RetrievalHit } from '../src/core/types';

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
    ]);
    expect(schemas[0].type).toBe('function');
  });

  it('未知工具返回错误', async () => {
    expect(await executeToolByName(DEFAULT_TOOLS, 'missing', {}, context())).toEqual({
      error: '未知工具: missing',
    });
  });
});
