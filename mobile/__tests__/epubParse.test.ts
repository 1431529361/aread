import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { EpubError, openEpub, readArchiveBytes, readArchiveText } from '../src/core/epub/parse';
import { resolvePath, entryKey } from '../src/core/epub/resource';
import {
  CONTAINER_XML,
  ENCRYPTED_CONTENT_XML,
  OBFUSCATED_FONT_XML,
  STANDARD_OPF,
  buildEpubFixture,
} from './helpers/epubFixture';

async function expectEpubError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('应当抛出 EpubError');
  } catch (error) {
    expect(error).toBeInstanceOf(EpubError);
    expect((error as EpubError).code).toBe(code);
  }
}

describe('openEpub 正常路径', () => {
  it('解析 container / OPF / manifest / spine 与元数据', async () => {
    const archive = await openEpub(await buildEpubFixture());
    const { parsed } = archive;

    expect(parsed.opfPath).toBe('OEBPS/content.opf');
    expect(parsed.opfDir).toBe('OEBPS');
    expect(parsed.metadata.title).toBe('示例书');
    expect(parsed.metadata.author).toBe('作者甲');
    expect(parsed.metadata.language).toBe('zh-CN');
    expect(parsed.metadata.identifier).toBe('urn:uuid:1234');
    expect(parsed.metadata.publisher).toBe('示例出版社');

    expect(parsed.spine).toEqual(['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml']);
    expect(parsed.manifest.get('cover')?.mediaType).toBe('image/png');
    expect(parsed.navHref).toBe('OEBPS/nav.xhtml');
    expect(parsed.ncxHref).toBe('OEBPS/toc.ncx');
  });

  it('能读取章节文本与图片字节', async () => {
    const archive = await openEpub(await buildEpubFixture());
    const chapter = await readArchiveText(archive, 'OEBPS/text/ch2.xhtml');
    expect(chapter).toContain('第二章正文');

    const image = await readArchiveBytes(archive, 'OEBPS/images/cover.png');
    expect(image).not.toBeNull();
    expect(Array.from(image!)).toEqual([0x89, 0x50, 0x4e, 0x47]);

    expect(await readArchiveBytes(archive, 'OEBPS/missing.png')).toBeNull();
  });

  it('遵循 percent-encoding 与大小写差异查找条目', async () => {
    const archive = await openEpub(
      await buildEpubFixture({
        chapters: { 'OEBPS/Text/Ch1.xhtml': '<p>大写路径</p>' },
        opf: STANDARD_OPF.replace('text/ch1.xhtml', 'Text/Ch1.xhtml'),
      }),
    );
    const text = await readArchiveText(archive, 'OEBPS/Text/Ch1.xhtml');
    expect(text).toContain('大写路径');
  });

  it('缺少 container.xml 时回退扫描 .opf', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('content.opf', STANDARD_OPF);
    zip.file('text/ch1.xhtml', '<p>一</p>');
    zip.file('text/ch2.xhtml', '<p>二</p>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const archive = await openEpub(bytes);
    expect(archive.parsed.opfPath).toBe('content.opf');
    expect(archive.parsed.spine).toEqual(['text/ch1.xhtml', 'text/ch2.xhtml']);
  });

  it('spine 为空时判定为 EMPTY', async () => {
    const opf = STANDARD_OPF.replace(
      /<spine toc="ncx">[\s\S]*?<\/spine>/,
      '<spine toc="ncx"></spine>',
    );
    await expectEpubError(openEpub(await buildEpubFixture({ opf })), 'EMPTY');
  });
});

describe('openEpub 拒绝异常文件', () => {
  it('不是 ZIP 时判定为 NOT_EPUB', async () => {
    const notZip = new TextEncoder().encode('这不是一个 EPUB 文件');
    await expectEpubError(openEpub(notZip), 'NOT_EPUB');
  });

  it('没有 OPF 时判定为 NOT_EPUB', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('readme.txt', '空壳');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expectEpubError(openEpub(bytes), 'NOT_EPUB');
  });

  it('OPF 缺少 manifest 时判定为 CORRUPT', async () => {
    const opf = STANDARD_OPF.replace(/<manifest>[\s\S]*?<\/manifest>/, '<manifest/>');
    await expectEpubError(openEpub(await buildEpubFixture({ opf })), 'CORRUPT');
  });
});

describe('openEpub DRM 检测', () => {
  it('存在 META-INF/rights.xml 时判定为 DRM', async () => {
    const bytes = await buildEpubFixture({
      extraFiles: { 'META-INF/rights.xml': '<rights/>' },
    });
    await expectEpubError(openEpub(bytes), 'DRM');
  });

  it('正文被加密时判定为 DRM', async () => {
    const bytes = await buildEpubFixture({ encryptionXml: ENCRYPTED_CONTENT_XML });
    await expectEpubError(openEpub(bytes), 'DRM');
  });

  it('仅字体混淆（IDPF / Adobe）不算 DRM', async () => {
    const bytes = await buildEpubFixture({ encryptionXml: OBFUSCATED_FONT_XML });
    const archive = await openEpub(bytes);
    expect(archive.parsed.spine).toHaveLength(2);
  });
});

describe('路径工具', () => {
  it('解析相对路径与片段', () => {
    expect(resolvePath('OEBPS/text', '../images/a.png')).toBe('OEBPS/images/a.png');
    expect(resolvePath('OEBPS', 'text/ch1.xhtml#anchor')).toBe('OEBPS/text/ch1.xhtml');
    expect(resolvePath('OEBPS', '/root.png')).toBe('root.png');
    expect(resolvePath('OEBPS', 'a%20b.png')).toBe('OEBPS/a b.png');
  });

  it('entryKey 统一大小写与 ./ 前缀', () => {
    expect(entryKey('./OEBPS/Text/Ch1.xhtml')).toBe('oebps/text/ch1.xhtml');
    expect(entryKey('OEBPS/A%20B.PNG')).toBe('oebps/a b.png');
  });

  it('container.xml 常量与标准 OPF 自洽', () => {
    expect(CONTAINER_XML).toContain('OEBPS/content.opf');
    expect(STANDARD_OPF).toContain('application/x-dtbncx+xml');
  });
});