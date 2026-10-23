import { findChapter, splitChapters } from '../../rag/chapters';
import type { AgentTool } from '../types';
import { truncateText } from '../toolResult';

export const getChapterInfoTool: AgentTool = {
  name: 'getChapterInfo',
  description:
    '获取书中指定章节的内容摘要与开头文本。可通过章节标题关键词或章节序号（从1开始）定位。',
  parameters: {
    type: 'object',
    properties: {
      chapterTitle: { type: 'string', description: '章节标题关键词' },
      chapterIndex: { type: 'integer', description: '章节序号（从1开始）' },
    },
  },
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

    return {
      title: target.title,
      chapterIndex: target.index + 1,
      totalChapters: chapters.length,
      length: target.text.length,
      loc: { kind: 'txt', href: null, start: target.start, end: target.end },
      preview: truncateText(target.text, 1500),
    };
  },
};
