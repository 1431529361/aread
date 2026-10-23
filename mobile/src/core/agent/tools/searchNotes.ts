import type { AgentTool } from '../types';
import { truncateText } from '../toolResult';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export const searchNotesTool: AgentTool = {
  name: 'searchNotes',
  description:
    '在已生成的读书笔记和人物关系分析中检索。用于回答“我之前整理的笔记里怎么说”等问题。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词' },
      limit: {
        type: 'integer',
        description: '最多返回条数，1~10，默认 5',
      },
    },
    required: ['query'],
  },
  resultLimits: { maxArrayItems: 10, maxStringLength: 800 },
  async execute(args, context) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { error: 'query 不能为空' };

    const requested =
      typeof args.limit === 'number' ? Math.floor(args.limit) : 5;
    const limit = Math.max(1, Math.min(10, requested));

    const rows = await context.db.queryAll<{
      bookId: string;
      bookTitle: string | null;
      taskType: string;
      content: string;
      updatedAt: string;
    }>(
      `SELECT t.book_id AS bookId, b.title AS bookTitle,
              t.task_type AS taskType, t.content, t.updated_at AS updatedAt
       FROM task_results t
       LEFT JOIN books_meta b ON b.id = t.book_id AND b.user_id = t.user_id
       WHERE t.user_id = ? AND t.content LIKE ? ESCAPE '\\'
       ORDER BY t.updated_at DESC
       LIMIT ?`,
      [context.userId, `%${escapeLike(query)}%`, limit],
    );

    return {
      matches: rows.map((row) => ({
        bookId: row.bookId,
        bookTitle: row.bookTitle,
        taskType: row.taskType,
        updatedAt: row.updatedAt,
        text: truncateText(row.content, 500),
      })),
    };
  },
};
