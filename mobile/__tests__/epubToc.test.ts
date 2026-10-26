import { describe, expect, it } from 'vitest';
import { openEpub, type EpubArchive } from '../src/core/epub/parse';
import { fallbackToc, loadEpubToc } from '../src/core/epub/toc';
import { buildEpubFixture } from './helpers/epubFixture';

async function openFixture(
  options: Parameters<typeof buildEpubFixture>[0] = {},
): Promise<EpubArchive> {
  return openEpub(await buildEpubFixture(options));
}

describe('loadEpubToc', () => {
  it('优先使用 EPUB3 nav 文档，并保留层级与锚点', async () => {
    const archive = await openFixture();
    const toc = await loadEpubToc(archive);

    expect(toc).toHaveLength(3);
    expect(toc[0]).toMatchObject({
      title: '第一章 开端',
      href: 'OEBPS/text/ch1.xhtml',
      fragment: '',
      level: 0,
    });
    expect(toc[1]).toMatchObject({
      title: '第二章 发展',
      href: 'OEBPS/text/ch2.xhtml',
      fragment: 'part2',
      level: 0,
    });
    expect(toc[2]).toMatchObject({
      title: '第三节',
      href: 'OEBPS/text/ch2.xhtml',
      fragment: 'part3',
      level: 1,
    });
  });

  it('nav 文档缺失时回退到 toc.ncx', async () => {
    const archive = await openFixture({ nav: null });
    const toc = await loadEpubToc(archive);

    expect(toc.map((entry) => entry.title)).toEqual(['第一章', '第二章', '第二章第一节']);
    expect(toc[2].level).toBe(1);
    expect(toc[2].fragment).toBe('s1');
  });

  it('nav 文档没有目录列表时也会回退到 ncx', async () => {
    const archive = await openFixture({
      nav: '<html><body><nav epub:type="landmarks"><ol></ol></nav></body></html>',
    });
    const toc = await loadEpubToc(archive);
    expect(toc.map((entry) => entry.title)).toEqual(['第一章', '第二章', '第二章第一节']);
  });

  it('两种目录都没有时返回空数组，交给 fallbackToc 兜底', async () => {
    const archive = await openFixture({ nav: null, ncx: null });
    expect(await loadEpubToc(archive)).toEqual([]);

    const fallback = fallbackToc(archive.parsed.spine);
    expect(fallback.map((entry) => entry.title)).toEqual(['第 1 节', '第 2 节']);
    expect(fallback[1].href).toBe('OEBPS/text/ch2.xhtml');
  });

  it('目录标题里的空白会被折叠', async () => {
    const archive = await openFixture({
      nav: `<html><body><nav epub:type="toc"><ol>
        <li><a href="text/ch1.xhtml">  第一章
        开端  </a></li></ol></nav></body></html>`,
    });
    const toc = await loadEpubToc(archive);
    expect(toc).toHaveLength(1);
    expect(toc[0].title).toBe('第一章 开端');
  });
});