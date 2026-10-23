import { findChapter, splitChapters } from '../../rag/chapters';
import type { AgentTool } from '../types';
import { truncateText } from '../toolResult';

export const getChapterTool: AgentTool = {
  name: 'getChapter',
  description:
    '读取指定章节的正文（默认最多 2500 字）。可按章节序号（从1开始）或标题关键词定位。',
  parameters: {
    type: 'object',
    properties: {
      chapterTitle: { type: 'string', description: '章节标题关键词' },
      chapterIndex: { type: 'integer', description: '章节序号（从1开始）' },
      maxChars: {
        type: 'integer',
        description: '返回的最大字符数，500~4000，默认 2500',
      },
    },
  },
  resultLimits: { maxStringLength: 3000 },
  async execute(args, context) {
    if (!context.content) return { error: '当前书籍没有可读取的全文' };

    const chapters = splitChapters(context.content);
    const chapterIndex =
      typeof args.chapterIndex === 'number' ? args.chapterIndex : null;
    const chapterTitle =
      typeof args.chapterTitle === 'string' ? args.chapterTitle : null;
    const target = findChapter(chapters, { chapterIndex, chapterTitle });
    if (!target) {
      return { error: '未找到匹配章节', totalChapters: chapters.length };
    }

    const requested =
      typeof args.maxChars === 'number' ? Math.floor(args.maxChars) : 2500;
    const maxChars = Math.max(500, Math.min(4000, requested));

    return {
      title: target.title,
      chapterIndex: target.index + 1,
      totalChapters: chapters.length,
      length: target.text.length,
      loc: { kind: 'txt', href: null, start: target.start, end: target.end },
      text: truncateText(target.text, maxChars),
    };
  },
};
