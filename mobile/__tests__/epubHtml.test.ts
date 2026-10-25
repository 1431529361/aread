import { describe, expect, it } from 'vitest';
import { sanitizeDocument, type SanitizedBlock } from '../src/core/epub/sanitize';
import { buildEpubChapterHtml } from '../src/reader/epubHtml';

function blocksOf(html: string): SanitizedBlock[] {
  return sanitizeDocument(html, {
    resolveImage: (src) => `data:image/png;base64,${src}`,
  }).blocks;
}

describe('buildEpubChapterHtml', () => {
  it('每个块渲染成一个带 data-s / data-e 的段落', () => {
    const blocks = blocksOf('<h1>标题</h1><p>正文一</p><p>正文二</p>');
    const html = buildEpubChapterHtml({
      bookTitle: '示例书',
      chapterTitle: '第一章',
      href: 'OEBPS/text/ch1.xhtml',
      blocks,
    });

    expect(html).toContain('<p class="blk-h1" data-s="0" data-e="2">标题</p>');
    expect(html).toContain('<p data-s="3" data-e="6">正文一</p>');
    expect(html).toContain('<p data-s="7" data-e="10">正文二</p>');
  });

  it('行内标签被保留，不会被二次转义', () => {
    const blocks = blocksOf('<p>前<strong>强调</strong>后 &amp; 与号</p>');
    const html = buildEpubChapterHtml({
      bookTitle: '书',
      chapterTitle: '章',
      href: 'ch.xhtml',
      blocks,
    });
    expect(html).toContain('<strong>强调</strong>');
    expect(html).toContain('后 &amp; 与号');
  });

  it('纯图片块带 blk-media 且 start === end', () => {
    const blocks = blocksOf('<p><img src="a.png"/></p>');
    const html = buildEpubChapterHtml({
      bookTitle: '书',
      chapterTitle: '章',
      href: 'ch.xhtml',
      blocks,
    });
    expect(blocks[0].start).toBe(blocks[0].end);
    expect(html).toContain('<p class="blk-media" data-s="0" data-e="0">');
    expect(html).toContain('data:image/png;base64,a.png');
  });

  it('初始化载荷带 epub kind 与 href', () => {
    const blocks = blocksOf('<p>正文</p>');
    const html = buildEpubChapterHtml({
      bookTitle: '书',
      chapterTitle: '章',
      href: 'OEBPS/text/ch9.xhtml',
      blocks,
      initialLocator: { kind: 'epub', href: 'OEBPS/text/ch9.xhtml', start: 0, end: 2 },
    });
    expect(html).toContain('"kind":"epub"');
    expect(html).toContain('"href":"OEBPS/text/ch9.xhtml"');
    expect(html).toContain('<title>书 · 章</title>');
  });

  it('没有正文时给出章节级空提示', () => {
    const html = buildEpubChapterHtml({
      bookTitle: '书',
      chapterTitle: '插图页',
      href: 'cover.xhtml',
      blocks: [],
    });
    expect(html).not.toContain('data-s=');
    expect(html).toContain('这一章没有可显示的正文');
    expect(html).toContain('"hasText":false');
  });

  it('书名与章节标题都会转义，避免注入', () => {
    const html = buildEpubChapterHtml({
      bookTitle: 'A<B>',
      chapterTitle: 'C&D',
      href: 'ch.xhtml',
      blocks: [],
    });
    expect(html).toContain('<title>A&lt;B&gt; · C&amp;D</title>');
    expect(html).not.toContain('<title>A<B>');
  });
});