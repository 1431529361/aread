import { describe, expect, it } from 'vitest';
import { normalizeText } from '../src/core/rag/chunk';
import {
  chunkParentChild,
  mergeOverlappingTexts,
  truncateToBudget,
} from '../src/core/rag/parentChild';

describe('chunkParentChild', () => {
  it('生成子块并标记 parent_index，offset 可切回原文', () => {
    const content = Array.from(
      { length: 20 },
      (_, index) => `段落${index}：${'内容'.repeat(30)}`,
    ).join('\n');
    const normalized = normalizeText(content);
    const chunks = chunkParentChild(content, {
      parentSize: 300,
      parentOverlap: 0,
      childSize: 100,
      childOverlap: 20,
    });

    expect(chunks.length).toBeGreaterThan(2);
    const parentIndices = new Set(chunks.map((chunk) => chunk.parent_index));
    expect(parentIndices.size).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(150);
      expect(normalized.slice(chunk.loc_start, chunk.loc_end)).toBe(chunk.text);
      expect(chunk.parent_index).not.toBeNull();
    }
  });

  it('同一 parent_index 的子块连续编号', () => {
    const content = '内容。'.repeat(300);
    const chunks = chunkParentChild(content, {
      parentSize: 200,
      childSize: 60,
      childOverlap: 10,
    });

    const groups = new Map<number, number[]>();
    for (const chunk of chunks) {
      const parent = chunk.parent_index!;
      const indices = groups.get(parent) ?? [];
      indices.push(chunk.index);
      groups.set(parent, indices);
    }

    for (const indices of groups.values()) {
      expect(indices).toEqual(
        Array.from({ length: indices.length }, (_, i) => indices[0] + i),
      );
    }
  });

  it('EPUB 子块保留 href 且 offset 相对文档', () => {
    const chunks = chunkParentChild('第一章 开始\n正文内容。', {
      parentSize: 200,
      childSize: 50,
      locKind: 'epub',
      href: 'text/ch1.xhtml',
    });

    expect(chunks[0]).toMatchObject({
      loc_kind: 'epub',
      loc_href: 'text/ch1.xhtml',
      parent_index: 0,
    });
    expect(chunks[0].loc_start).toBeGreaterThanOrEqual(0);
  });
});

describe('mergeOverlappingTexts', () => {
  it('去掉最长重叠前缀', () => {
    expect(
      mergeOverlappingTexts(['0123456789', '2345678901']),
    ).toBe('012345678901');
  });

  it('无重叠时换行分隔', () => {
    expect(mergeOverlappingTexts(['第一段', '第二段'])).toBe('第一段\n第二段');
  });

  it('忽略空文本', () => {
    expect(mergeOverlappingTexts(['', '内容', '  '])).toBe('内容');
  });
});

describe('truncateToBudget', () => {
  it('超出预算时截断并加省略号', () => {
    expect(truncateToBudget('abcdef', 3)).toBe('abc…');
    expect(truncateToBudget('abc', 3)).toBe('abc');
  });
});
