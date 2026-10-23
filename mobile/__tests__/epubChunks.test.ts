import { describe, expect, it } from 'vitest';
import { chunkEpubDocuments } from '../src/core/rag/epubChunks';

describe('chunkEpubDocuments', () => {
  it('按 spine 文档逐篇分块，不跨文档合并', () => {
    const chunks = chunkEpubDocuments(
      [
        { href: 'text/ch1.xhtml', text: '第一章 开端\n这是第一章的内容。' },
        { href: 'text/ch2.xhtml', text: '第二章 发展\n这是第二章的内容。' },
      ],
      { chunkSize: 500 },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      index: 0,
      chapter: '第一章 开端',
      loc_kind: 'epub',
      loc_href: 'text/ch1.xhtml',
      loc_start: 0,
    });
    expect(chunks[1]).toMatchObject({
      index: 1,
      chapter: '第二章 发展',
      loc_kind: 'epub',
      loc_href: 'text/ch2.xhtml',
      loc_start: 0,
    });
    expect(chunks[0].text).not.toContain('第二章');
    expect(chunks[1].text).not.toContain('第一章');
  });

  it('chunkIndex 在整个 EPUB 内连续递增', () => {
    const chunks = chunkEpubDocuments([
      { href: 'a.xhtml', text: 'a'.repeat(120) },
      { href: 'b.xhtml', text: 'b'.repeat(120) },
    ], { chunkSize: 50, overlap: 10 });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((chunk) => chunk.index)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  it('跳过空 href 的文档', () => {
    expect(
      chunkEpubDocuments([
        { href: '  ', text: '内容' },
        { href: 'ok.xhtml', text: '内容' },
      ]),
    ).toHaveLength(1);
  });
});
