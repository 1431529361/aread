import type { AgentTool } from '../types';
import { truncateText } from '../toolResult';

export const searchLibraryTool: AgentTool = {
  name: 'searchLibrary',
  description:
    '在整个书库中跨书检索相关段落。用于比较不同书籍、查找跨书参考或书库会话。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索查询词或问题' },
    },
    required: ['query'],
  },
  async execute(args, context) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'query 不能为空' };
    if (!context.searchLibrary) {
      return { error: '当前未启用书库检索' };
    }

    const hits = await context.searchLibrary(query);
    if (hits.length === 0) {
      return { source: 'library', results: [], message: '书库中未找到相关内容' };
    }

    return {
      source: 'library',
      results: hits.map((hit) => ({
        bookId: hit.bookId,
        bookTitle: hit.bookTitle,
        chapter: hit.chapter,
        loc: hit.loc,
        score: Number(hit.score.toFixed(4)),
        sources: hit.sources,
        text: truncateText(hit.parentText ?? hit.text, 500),
      })),
    };
  },
};
