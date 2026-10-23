import { describe, expect, it } from 'vitest';
import {
  MAX_INJECTED_MEMORY_CHARS,
  dedupeMemories,
  formatMemoriesBlock,
  normalizeMemoryContent,
  parseMemoryExtractionResult,
  retrieveMemories,
  selectMemoriesForInjection,
} from '../src/core/conversation/memory';

describe('normalizeMemoryContent', () => {
  it('忽略大小写、空白和标点', () => {
    expect(normalizeMemoryContent('  Hello，World！ ')).toBe('helloworld');
    expect(normalizeMemoryContent('用户喜欢：简洁回答。')).toBe('用户喜欢简洁回答');
  });
});

describe('dedupeMemories', () => {
  it('归一化后内容相同的记忆只保留 salience 更高的一条', () => {
    const result = dedupeMemories([
      { kind: 'fact', content: '用户喜欢简洁回答', salience: 0.5 },
      { kind: 'preference', content: '用户喜欢 简洁回答！', salience: 0.9 },
      { kind: 'interest', content: '用户关注明清史', salience: 0.7 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: 'preference', salience: 0.9 });
    expect(result[1].content).toBe('用户关注明清史');
  });

  it('空内容被丢弃', () => {
    expect(dedupeMemories([{ kind: 'fact', content: ' ，。 ' }])).toEqual([]);
  });
});

describe('selectMemoriesForInjection', () => {
  it('最多注入 8 条且总长不超过 500 字', () => {
    const memories = Array.from({ length: 10 }, (_, index) => ({
      kind: 'fact',
      content: `记忆${index}`.padEnd(60, '啊'),
      salience: 1,
    }));

    const selected = selectMemoriesForInjection(memories);
    const totalChars =
      selected.reduce((sum, memory) => sum + memory.content.length, 0) +
      Math.max(0, selected.length - 1);

    expect(selected).toHaveLength(8);
    expect(totalChars).toBeLessThanOrEqual(MAX_INJECTED_MEMORY_CHARS);
  });

  it('单条超长记忆被截断到上限', () => {
    const selected = selectMemoriesForInjection([
      { kind: 'fact', content: 'x'.repeat(600), salience: 1 },
    ]);

    expect(selected).toHaveLength(1);
    expect(selected[0].content).toHaveLength(MAX_INJECTED_MEMORY_CHARS);
  });

  it('按 salience 降序选择', () => {
    const selected = selectMemoriesForInjection([
      { kind: 'fact', content: '低', salience: 0.2 },
      { kind: 'fact', content: '高', salience: 0.9 },
    ]);

    expect(selected.map((memory) => memory.content)).toEqual(['高', '低']);
  });
});

describe('retrieveMemories', () => {
  it('关键词重叠越多越靠前', () => {
    const result = retrieveMemories(
      [
        { kind: 'preference', content: '用户偏好简洁回答', salience: 1 },
        { kind: 'interest', content: '用户关注明清史与明代政治', salience: 0.8 },
      ],
      '明清史',
      2,
    );

    expect(result[0].content).toContain('明清史');
  });
});

describe('formatMemoriesBlock', () => {
  it('每个记忆一行', () => {
    expect(formatMemoriesBlock([{ kind: 'fact', content: 'A' }, { kind: 'fact', content: 'B' }])).toBe(
      '- A\n- B',
    );
  });
});

describe('parseMemoryExtractionResult', () => {
  it('容忍代码块包裹并限制 salience 范围', () => {
    const items = parseMemoryExtractionResult(
      '```json\n[{"kind":"preference","content":"用户偏好简洁回答","salience":2}]\n```',
    );

    expect(items).toEqual([
      { kind: 'preference', content: '用户偏好简洁回答', salience: 1 },
    ]);
  });

  it('非法 JSON 返回空数组', () => {
    expect(parseMemoryExtractionResult('not json')).toEqual([]);
  });
});
