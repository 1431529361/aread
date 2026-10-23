import { splitChapters } from '../../rag/chapters';
import type { AgentTool } from '../types';

const MAX_CHAPTERS = 60;

export const listChaptersTool: AgentTool = {
  name: 'listChapters',
  description:
    '列出全书章节标题、序号与位置。用于了解书籍结构、定位章节或制定阅读/总结计划。',
  parameters: { type: 'object', properties: {} },
  resultLimits: { maxArrayItems: MAX_CHAPTERS, maxStringLength: 200 },
  async execute(_args, context) {
    if (!context.content) return { error: '当前书籍没有可读取的全文' };

    const chapters = splitChapters(context.content);
    return {
      total: chapters.length,
      chapters: chapters.slice(0, MAX_CHAPTERS).map((chapter) => ({
        index: chapter.index + 1,
        title: chapter.title,
        length: chapter.text.length,
      })),
      truncated: chapters.length > MAX_CHAPTERS,
    };
  },
};
