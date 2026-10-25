import JSZip from 'jszip';

export const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

export const STANDARD_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>示例书</dc:title>
    <dc:creator>作者甲</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="bookid">urn:uuid:1234</dc:identifier>
    <dc:publisher>示例出版社</dc:publisher>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover.png" media-type="image/png"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

export const NAV_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="text/ch1.xhtml">第一章 开端</a></li>
        <li><a href="text/ch2.xhtml#part2">第二章 发展</a>
          <ol><li><a href="text/ch2.xhtml#part3">第三节</a></li></ol>
        </li>
      </ol>
    </nav>
  </body>
</html>`;

export const NCX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>第一章</text></navLabel>
      <content src="text/ch1.xhtml"/>
    </navPoint>
    <navPoint id="n2" playOrder="2">
      <navLabel><text>第二章</text></navLabel>
      <content src="text/ch2.xhtml"/>
      <navPoint id="n2-1" playOrder="3">
        <navLabel><text>第二章第一节</text></navLabel>
        <content src="text/ch2.xhtml#s1"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`;

export const CHAPTER_1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>第一章</title></head>
  <body>
    <h1>第一章 开端</h1>
    <p>这是第一章的正文，包含<strong>强调</strong>与图片。</p>
    <p><img src="../images/cover.png" alt="插图"/></p>
  </body>
</html>`;

export const CHAPTER_2 = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第二章正文</p></body></html>`;

export interface EpubFixtureOptions {
  opf?: string;
  container?: string | null;
  nav?: string | null;
  ncx?: string | null;
  chapters?: Record<string, string>;
  images?: Record<string, Uint8Array>;
  encryptionXml?: string | null;
  extraFiles?: Record<string, string>;
}

/** 用 JSZip 在内存里拼一个最小可用 EPUB（默认无 DRM、双章节）。 */
export async function buildEpubFixture(options: EpubFixtureOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', options.container ?? CONTAINER_XML);
  zip.file('OEBPS/content.opf', options.opf ?? STANDARD_OPF);

  if (options.nav !== null) zip.file('OEBPS/nav.xhtml', options.nav ?? NAV_XHTML);
  if (options.ncx !== null) zip.file('OEBPS/toc.ncx', options.ncx ?? NCX_XML);

  const chapters = options.chapters ?? {
    'OEBPS/text/ch1.xhtml': CHAPTER_1,
    'OEBPS/text/ch2.xhtml': CHAPTER_2,
  };
  for (const [path, content] of Object.entries(chapters)) zip.file(path, content);

  const images = options.images ?? {
    'OEBPS/images/cover.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };
  for (const [path, bytes] of Object.entries(images)) zip.file(path, bytes);

  if (options.encryptionXml) {
    zip.file('META-INF/encryption.xml', options.encryptionXml);
  }
  for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
    zip.file(path, content);
  }

  return zip.generateAsync({ type: 'uint8array' });
}

export const ENCRYPTED_CONTENT_XML = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <CipherData><CipherReference URI="OEBPS/text/ch1.xhtml"/></CipherData>
  </EncryptedData>
</encryption>`;

export const OBFUSCATED_FONT_XML = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <CipherData><CipherReference URI="OEBPS/fonts/body.otf"/></CipherData>
  </EncryptedData>
</encryption>`;