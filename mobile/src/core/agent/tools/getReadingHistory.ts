import type { AgentTool } from '../types';

export const getReadingHistoryTool: AgentTool = {
  name: 'getReadingHistory',
  description:
    '读取最近的阅读记录（书名、格式、进度、最后阅读时间）。用于回答“我最近在读什么/读到哪了”。',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: '最多返回条数，1~20，默认 10',
      },
    },
  },
  resultLimits: { maxArrayItems: 20, maxObjectKeys: 10 },
  async execute(args, context) {
    const requested =
      typeof args.limit === 'number' ? Math.floor(args.limit) : 10;
    const limit = Math.max(1, Math.min(20, requested));

    const items = await context.db.queryAll<{
      bookId: string;
      title: string;
      format: string;
      progress: number;
      lastRead: string;
    }>(
      `SELECT id AS bookId, title, format,
              read_progress AS progress, last_read AS lastRead
       FROM books_meta
       WHERE user_id = ? AND last_read IS NOT NULL
       ORDER BY last_read DESC
       LIMIT ?`,
      [context.userId, limit],
    );

    return { items };
  },
};
