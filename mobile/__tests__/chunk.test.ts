import { describe, expect, it } from 'vitest';
import { chunkText, normalizeText } from '../src/core/rag/chunk';

describe('normalizeText', () => {
  it('去掉 BOM 并统一换行符', () => {
    expect(normalizeText('\uFEFF第一行\r\n第二行\r第三行')).toBe('第一行\n第二行\n第三行');
  });
});

describe('chunkText', () => {
  it('空白文本返回空数组', () => {
    expect(chunkText(' \n\n ')).toEqual([]);
  });

  it('短文本整段成块，默认章节为前言', () => {
    const content = '第一段。\n\n第二段。';
    const chunks = chunkText(content, { chunkSize: 100 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chapter).toBe('前言');
    expect(chunks[0].text).toBe(content);
    expect(chunks[0].loc_start).toBe(0);
    expect(chunks[0].loc_end).toBe(content.length);
  });

  it('按章节标题切块并保留章节名', () => {
    const content = '第一章 开端\n正文一。\n第二章 发展\n正文二。';
    const chunks = chunkText(content, { chunkSize: 500 });

    expect(chunks.map((chunk) => chunk.chapter)).toEqual(['第一章 开端', '第二章 发展']);
    expect(chunks[0].text).toContain('正文一');
    expect(chunks[1].text).toContain('正文二');
  });

  it('超长段落使用滑动窗口，带重叠', () => {
    const content = '字'.repeat(120);
    const chunks = chunkText(content, { chunkSize: 50, overlap: 10 });

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.loc_start)).toEqual([0, 40, 80]);
    expect(chunks.map((chunk) => chunk.loc_end)).toEqual([50, 90, 120]);
    expect(chunks[0].text).toHaveLength(50);
    expect(content.slice(40, 50)).toBe(chunks[1].text.slice(0, 10));
  });

  it('所有块 locator 都能精确切回原文', () => {
    const raw = '\uFEFF第一段\r\n\r\n第二段\r\n第三段';
    const normalized = normalizeText(raw);
    const chunks = chunkText(raw, { chunkSize: 100 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(normalized.slice(chunk.loc_start, chunk.loc_end)).toBe(chunk.text);
    }
  });

  it('EPUB 模式记录 href 与文档内 offset', () => {
    const chunks = chunkText('这是第一章的内容。', {
      chunkSize: 100,
      locKind: 'epub',
      href: 'chapter1.xhtml',
    });

    expect(chunks[0]).toMatchObject({
      loc_kind: 'epub',
      loc_href: 'chapter1.xhtml',
      loc_start: 0,
      loc_end: 9,
    });
  });

  it('chunkIndex 从 0 连续递增', () => {
    const chunks = chunkText('第一章 A\n内容。\n第二章 B\n内容。', { chunkSize: 500 });
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
  });
});
