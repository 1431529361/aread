import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkEpubDocuments } from '../src/core/rag/epubChunks';
import { openEpub } from '../src/core/epub/parse';
import type { LoadedEpub } from '../src/services/epubContent';
import { buildEpubFixture } from './helpers/epubFixture';

// epubContent 顶层 import 了 expo-file-system；这里只需它的类型存在即可（本测试不读文件）
vi.mock('expo-file-system', () => ({
  File: class {
    exists = false;
    uri = '';
    bytes = async (): Promise<Uint8Array> => new Uint8Array();
    text = async (): Promise<string> => '';
  },
  Paths: { document: '/tmp' },
}));

async function loadFixture(): Promise<LoadedEpub> {
  const { loadEpubFromArchive } = await import('../src/services/epubContent');
  const archive = await openEpub(await buildEpubFixture());
  return loadEpubFromArchive('b_test', archive);
}

describe('loadEpubFromArchive / loadEpubDocuments', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('构建阅读上下文：spine、目录与元数据', async () => {
    const loaded = await loadFixture();
    expect(loaded.bookId).toBe('b_test');
    expect(loaded.spine).toEqual(['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml']);
    expect(loaded.title).toBe('示例书');
    expect(loaded.author).toBe('作者甲');
    expect(loaded.toc[0].title).toBe('第一章 开端');
  });

  it('按 spine 顺序输出每章纯文本', async () => {
    const { loadEpubDocuments } = await import('../src/services/epubContent');
    const loaded = await loadFixture();
    const documents = await loadEpubDocuments(loaded);

    expect(documents.map((doc) => doc.href)).toEqual(loaded.spine);
    expect(documents[0].text).toContain('这是第一章的正文，包含强调与图片。');
    expect(documents[1].text).toBe('第二章正文');
  });

  it('章节里的图片被读成 data URI，且图片块不占字符', async () => {
    const { loadEpubChapter } = await import('../src/services/epubContent');
    const loaded = await loadFixture();
    const chapter = await loadEpubChapter(loaded, 'OEBPS/text/ch1.xhtml');

    const media = chapter.blocks.find((block) => block.text.length === 0);
    expect(media).toBeDefined();
    expect(media!.start).toBe(media!.end);
    expect(media!.html).toContain('data:image/png;base64,');
    expect(media!.html).toContain('alt="插图"');
  });
});

describe('chunkEpubDocuments 与阅读器 offset 对齐', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('分块带 epub locator，且 offset 与章节文本严格对齐', async () => {
    const { loadEpubDocuments } = await import('../src/services/epubContent');
    const loaded = await loadFixture();
    const documents = await loadEpubDocuments(loaded);
    const chunks = chunkEpubDocuments(documents);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.loc_kind === 'epub')).toBe(true);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));

    for (const chunk of chunks) {
      const document = documents.find((doc) => doc.href === chunk.loc_href);
      expect(document).toBeDefined();
      expect(document!.text.slice(chunk.loc_start, chunk.loc_end)).toBe(chunk.text);
    }
  });

  it('第一章的分块归属正确的章节标题', async () => {
    const { loadEpubDocuments } = await import('../src/services/epubContent');
    const loaded = await loadFixture();
    const chunks = chunkEpubDocuments(await loadEpubDocuments(loaded));
    const first = chunks.find((chunk) => chunk.loc_href === 'OEBPS/text/ch1.xhtml');
    expect(first?.chapter).toBe('第一章 开端');
  });
});