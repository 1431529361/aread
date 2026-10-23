import { splitChapters } from '../../rag/chapters';
import type { RetrievalHit } from '../../types';
import type { AgentTool } from '../types';
import { truncateText } from '../toolResult';

function fulltextFallback(
  query: string,
  content: string,
): { chapter: string; loc: { kind: 'txt'; href: null; start: number; end: number }; text: string } | null {
  const position = content.indexOf(query);
  if (position < 0) return null;

  const start = Math.max(0, position - 200);
  const end = Math.min(content.length, position + 800);
  const chapter =
    splitChapters(content).find(
      (item) => position >= item.start && position <= item.end,
    )?.title ?? '全文';

  return {
    chapter,
    loc: { kind: 'txt', href: null, start, end },
    text: truncateText(content.slice(start, end), 800),
  };
}

export const searchInBookTool: AgentTool = {
  name: 'searchInBook',
  description:
    '在当前书籍全文中检索与查询最相关的段落（混合检索）。用于回答需要查阅书中其他部分、或超出选中文本范围的问题。',
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

    let hits: RetrievalHit[] = [];
    if (context.retrieve) {
      hits = await context.retrieve(query);
    }

    if (hits.length === 0) {
      const fallback = context.content
        ? fulltextFallback(query, context.content)
        : null;
      if (fallback) {
        return {
          source: 'fulltext',
          results: [
            {
              bookId: context.bookId,
              chapter: fallback.chapter,
              loc: fallback.loc,
              text: fallback.text,
            },
          ],
        };
      }
      return {
        source: 'empty',
        message: '未在书中检索到相关内容，建议基于检索证据或选中文本回答',
      };
    }

    return {
      source: 'hybrid',
      results: hits.map((hit) => ({
        bookId: hit.bookId,
        chapter: hit.chapter,
        loc: hit.loc,
        score: Number(hit.score.toFixed(4)),
        sources: hit.sources,
        text: truncateText(hit.text, 600),
      })),
    };
  },
};
