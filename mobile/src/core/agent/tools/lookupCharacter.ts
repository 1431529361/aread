import type { AgentTool } from '../types';
import { truncateText } from '../toolResult';

const MAX_SAMPLES = 6;

export const lookupCharacterTool: AgentTool = {
  name: 'lookupCharacter',
  description:
    '在书中查找某个人物/角色名的所有出现位置及上下文片段，用于分析人物形象、关系或剧情线。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '人物姓名或称呼' },
    },
    required: ['name'],
  },
  async execute(args, context) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { error: 'name 不能为空' };

    const content = context.content ?? '';
    if (!content) return { error: '当前书籍没有可读取的全文' };

    const samples: Array<{
      loc: { kind: 'txt'; href: null; start: number; end: number };
      snippet: string;
    }> = [];
    let position = 0;
    let total = 0;

    while ((position = content.indexOf(name, position)) !== -1) {
      total++;
      if (samples.length < MAX_SAMPLES) {
        const start = Math.max(0, position - 80);
        const end = Math.min(content.length, position + name.length + 120);
        samples.push({
          loc: { kind: 'txt', href: null, start, end },
          snippet: truncateText(content.slice(start, end).replace(/\n+/g, ' '), 240),
        });
      }
      position += name.length;
    }

    return {
      name,
      total,
      occurrences: samples.length,
      samples,
    };
  },
};
