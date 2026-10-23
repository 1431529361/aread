import { describe, expect, it } from 'vitest';
import {
  buildEvidenceBlocks,
  buildEvidenceMessage,
  evidenceIds,
  formatLocator,
  parseCitationIds,
  sanitizeCitations,
} from '../src/core/citation';
import type { RetrievalHit } from '../src/core/types';

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    chunkId: 1,
    bookId: 'book-1',
    bookTitle: '测试书',
    chapter: '第三章',
    text: '这是第三章的原文内容，用于测试引用。',
    loc: { kind: 'txt', href: null, start: 100, end: 130 },
    score: 1,
    sources: ['fts'],
    ...overrides,
  };
}

describe('formatLocator', () => {
  it('格式化 TXT 与 EPUB locator', () => {
    expect(formatLocator({ kind: 'txt', href: null, start: 10, end: 20 })).toBe('txt:10-20');
    expect(
      formatLocator({ kind: 'epub', href: 'text/chapter1.xhtml', start: 5, end: 9 }),
    ).toBe('text/chapter1.xhtml:5-9');
  });
});

describe('buildEvidenceBlocks', () => {
  it('生成连续编号并保留 locator', () => {
    const evidence = buildEvidenceBlocks([
      hit(),
      hit({ chunkId: 2, chapter: '第四章', text: '第四章内容' }),
    ]);

    expect(evidence).toHaveLength(2);
    expect(evidenceIds(evidence)).toEqual([1, 2]);
    expect(evidence[0].hit.loc).toEqual({ kind: 'txt', href: null, start: 100, end: 130 });
    expect(evidence[1].hit.chapter).toBe('第四章');
  });

  it('总长度不超过预算，最后一条可截断', () => {
    const evidence = buildEvidenceBlocks(
      Array.from({ length: 10 }, (_, index) =>
        hit({ chunkId: index + 1, text: '长文本'.repeat(200) }),
      ),
      { maxChars: 300, maxItems: 10 },
    );

    expect(evidence.length).toBeGreaterThan(0);
    const message = buildEvidenceMessage(evidence);
    expect(message.length).toBeLessThan(600);
    for (const item of evidence) {
      expect(item.hit.text.length).toBeGreaterThan(0);
    }
  });

  it('最多注入 5 条', () => {
    const evidence = buildEvidenceBlocks(
      Array.from({ length: 8 }, (_, index) => hit({ chunkId: index + 1 })),
    );
    expect(evidence).toHaveLength(5);
  });
});

describe('buildEvidenceMessage', () => {
  it('包含引用规则和证据编号', () => {
    const message = buildEvidenceMessage(buildEvidenceBlocks([hit()]));
    expect(message).toContain('[C1]');
    expect(message).toContain('《测试书/第三章');
    expect(message).toContain('不要编造');
  });

  it('无证据返回空串', () => {
    expect(buildEvidenceMessage([])).toBe('');
  });
});

describe('parseCitationIds', () => {
  it('解析并去重，保持出现顺序', () => {
    expect(parseCitationIds('结论[C2]，补充[c1]，再次[C2]，无效[C0]。')).toEqual([2, 1, 0]);
  });

  it('无引用返回空数组', () => {
    expect(parseCitationIds('没有引用')).toEqual([]);
  });
});

describe('sanitizeCitations', () => {
  it('删除不存在的引用并保留合法引用', () => {
    const result = sanitizeCitations('有效[C1]，无效[C9]，大小写[c2]。', [1, 2]);
    expect(result.answer).toBe('有效[C1]，无效，大小写[C2]。');
    expect(result.removedIds).toEqual([9]);
  });

  it('没有合法引用时全部删除', () => {
    const result = sanitizeCitations('全部[C3][C4]', []);
    expect(result.answer).toBe('全部');
    expect(result.removedIds).toEqual([3, 4]);
  });
});
