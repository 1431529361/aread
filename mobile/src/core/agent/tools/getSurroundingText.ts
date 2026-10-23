import type { AgentTool } from '../types';
import { truncateText } from '../toolResult';

export const getSurroundingTextTool: AgentTool = {
  name: 'getSurroundingText',
  description:
    '根据引用/高亮的 start、end 位置读取前后文。用于确认原文语境或补全被截断的片段。',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'integer', description: '起始字符 offset' },
      end: { type: 'integer', description: '结束字符 offset' },
      radius: {
        type: 'integer',
        description: '前后扩展字符数，0~1000，默认 200',
      },
    },
    required: ['start', 'end'],
  },
  resultLimits: { maxStringLength: 3000 },
  async execute(args, context) {
    if (!context.content) return { error: '当前书籍没有可读取的全文' };
    if (typeof args.start !== 'number' || typeof args.end !== 'number') {
      return { error: 'start 和 end 必须是整数' };
    }

    const content = context.content;
    const start = Math.max(0, Math.min(content.length, Math.floor(args.start)));
    const end = Math.max(start, Math.min(content.length, Math.floor(args.end)));
    const requestedRadius =
      typeof args.radius === 'number' ? Math.floor(args.radius) : 200;
    const radius = Math.max(0, Math.min(1000, requestedRadius));

    const from = Math.max(0, start - radius);
    const to = Math.min(content.length, end + radius);
    const text = content.slice(from, to);

    return {
      loc: { kind: 'txt', href: null, start: from, end: to },
      text: truncateText(text, 2500),
      length: text.length,
    };
  },
};
