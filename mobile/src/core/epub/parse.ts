import JSZip from 'jszip';
import { decodeXmlBytes } from '../text/bytes';
import {
  childElements,
  findElement,
  findElements,
  parseXml,
  textOf,
  type XmlElement,
} from './xml';
import { dirname, entryKey, resolvePath, stripFragment, extname } from './resource';

export type EpubErrorCode = 'NOT_EPUB' | 'DRM' | 'CORRUPT' | 'EMPTY';

export class EpubError extends Error {
  readonly code: EpubErrorCode;

  constructor(code: EpubErrorCode, message: string) {
    super(message);
    this.name = 'EpubError';
    this.code = code;
  }
}

export interface EpubManifestItem {
  id: string;
  /** ZIP 内的绝对路径（已归一化） */
  href: string;
  mediaType: string;
  properties: string[];
}

export interface EpubMetadata {
  title: string;
  author: string;
  language: string;
  identifier: string;
  publisher: string;
}

export interface ParsedEpub {
  metadata: EpubMetadata;
  opfPath: string;
  opfDir: string;
  manifest: Map<string, EpubManifestItem>;
  /** 阅读顺序的 spine 文档（绝对路径） */
  spine: string[];
  spineItems: EpubManifestItem[];
  /** EPUB3 的 nav 文档 */
  navHref: string | null;
  /** EPUB2 的 toc.ncx */
  ncxHref: string | null;
}

export interface EpubArchive {
  zip: JSZip;
  index: Map<string, JSZip.JSZipObject>;
  parsed: ParsedEpub;
}

function buildIndex(zip: JSZip): Map<string, JSZip.JSZipObject> {
  const index = new Map<string, JSZip.JSZipObject>();
  for (const [name, object] of Object.entries(zip.files)) {
    if (!object || object.dir) continue;
    const key = entryKey(name);
    if (!index.has(key)) index.set(key, object);
  }
  return index;
}

async function readEntryBytes(
  index: Map<string, JSZip.JSZipObject>,
  path: string,
): Promise<Uint8Array | null> {
  const object = index.get(entryKey(path));
  if (!object) return null;
  const data = await object.async('uint8array');
  return data;
}

export async function readArchiveBytes(
  archive: EpubArchive,
  path: string,
): Promise<Uint8Array | null> {
  return readEntryBytes(archive.index, path);
}

export async function readArchiveText(archive: EpubArchive, path: string): Promise<string | null> {
  const bytes = await readEntryBytes(archive.index, path);
  if (!bytes) return null;
  return decodeXmlBytes(bytes).text;
}

/** 检测 DRM：Adobe 加密或受保护的正文文档，字体混淆（IDPF/Adobe）不算 DRM。 */
async function drmReason(index: Map<string, JSZip.JSZipObject>): Promise<string | null> {
  if (index.has(entryKey('META-INF/rights.xml'))) {
    return '文件包含 META-INF/rights.xml，属于 Adobe DRM 加密电子书';
  }

  const bytes = await readEntryBytes(index, 'META-INF/encryption.xml');
  if (!bytes) return null;

  const root = parseXml(decodeXmlBytes(bytes).text);
  const encrypted = findElements(root, (element) => element.tag === 'encrypteddata');
  if (encrypted.length === 0) return null;

  for (const data of encrypted) {
    const reference = findElement(data, (element) => element.tag === 'cipherreference');
    const uri = reference?.attrs['uri'] ?? '';
    const method = findElement(data, (element) => element.tag === 'encryptionmethod');
    const algorithm = (method?.attrs['algorithm'] ?? '').toLowerCase();
    const ext = extname(stripFragment(uri));

    const fontAlgorithm =
      algorithm.includes('idpf.org/2008/embedding') ||
      algorithm.includes('ns.adobe.com/pdf/enc');
    const fontFile = ['ttf', 'otf', 'ttc', 'woff', 'woff2'].includes(ext);
    if (fontAlgorithm && fontFile) continue;

    return uri
      ? `书中有受 DRM 保护的资源：${stripFragment(uri)}`
      : '书中包含 DRM 加密资源';
  }

  return null;
}

function pickMetadata(metadata: XmlElement | null, tag: string): string[] {
  if (!metadata) return [];
  return childElements(metadata, tag)
    .map((element) => textOf(element).trim())
    .filter((value) => value.length > 0);
}

function parseOpf(opfText: string, opfPath: string): ParsedEpub {
  const root = parseXml(opfText);
  const pkg = findElement(root, (element) => element.tag === 'package');
  if (!pkg) throw new EpubError('CORRUPT', 'EPUB 的 OPF 文件缺少 package 元素');

  const opfDir = dirname(opfPath);
  const metadataElement = findElement(pkg, (element) => element.tag === 'metadata');
  const creators = pickMetadata(metadataElement, 'creator');
  const titles = pickMetadata(metadataElement, 'title');
  const languages = pickMetadata(metadataElement, 'language');
  const identifiers = pickMetadata(metadataElement, 'identifier');
  const publishers = pickMetadata(metadataElement, 'publisher');

  const manifest = new Map<string, EpubManifestItem>();
  const manifestElement = findElement(pkg, (element) => element.tag === 'manifest');
  if (manifestElement) {
    for (const item of childElements(manifestElement, 'item')) {
      const id = item.attrs['id'] ?? '';
      const href = item.attrs['href'] ?? '';
      if (!id || !href) continue;
      manifest.set(id, {
        id,
        href: resolvePath(opfDir, href),
        mediaType: item.attrs['media-type'] ?? '',
        properties: (item.attrs['properties'] ?? '').split(/\s+/).filter(Boolean),
      });
    }
  }
  if (manifest.size === 0) throw new EpubError('CORRUPT', 'EPUB 的 OPF 文件没有 manifest 条目');

  const spineElement = findElement(pkg, (element) => element.tag === 'spine');
  if (!spineElement) throw new EpubError('CORRUPT', 'EPUB 的 OPF 文件缺少 spine');
  const tocId = spineElement.attrs['toc'] ?? '';

  const spineItems: EpubManifestItem[] = [];
  for (const itemref of childElements(spineElement, 'itemref')) {
    if ((itemref.attrs['linear'] ?? '').toLowerCase() === 'no') continue;
    const idref = itemref.attrs['idref'] ?? '';
    const item = manifest.get(idref);
    if (item) spineItems.push(item);
  }

  let navHref: string | null = null;
  let ncxHref: string | null = null;
  for (const item of manifest.values()) {
    if (item.properties.includes('nav') && !navHref) navHref = item.href;
    if (item.mediaType === 'application/x-dtbncx+xml' && !ncxHref) ncxHref = item.href;
  }
  if (!ncxHref && tocId) ncxHref = manifest.get(tocId)?.href ?? null;

  return {
    metadata: {
      title: titles[0] ?? '',
      author: creators[0] ?? '',
      language: languages[0] ?? '',
      identifier: identifiers[0] ?? '',
      publisher: publishers[0] ?? '',
    },
    opfPath,
    opfDir,
    manifest,
    spine: spineItems.map((item) => item.href),
    spineItems,
    navHref,
    ncxHref,
  };
}

/** container.xml 缺失或没写 full-path 时的兜底：直接找压缩包里的 .opf。 */
function findOpfPath(index: Map<string, JSZip.JSZipObject>): string | null {
  for (const [key, object] of index) {
    if (key.endsWith('.opf')) return object.name;
  }
  return null;
}

/**
 * 打开 EPUB：解析 container.xml → OPF → manifest/spine，并做 DRM 检测。
 * 不做正文消毒（见 services/epubContent.ts）。
 */
export async function openEpub(bytes: Uint8Array): Promise<EpubArchive> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new EpubError('NOT_EPUB', '无法解析文件内容，可能不是 EPUB 或文件已损坏');
  }

  const index = buildIndex(zip);
  if (index.size === 0) throw new EpubError('NOT_EPUB', 'EPUB 压缩包是空的');

  const reason = await drmReason(index);
  if (reason) throw new EpubError('DRM', `这本书带有 DRM 保护，无法在本地阅读：${reason}`);

  let opfPath: string | null = null;
  const containerBytes = await readEntryBytes(index, 'META-INF/container.xml');
  if (containerBytes) {
    const containerRoot = parseXml(decodeXmlBytes(containerBytes).text);
    const rootfile = findElement(containerRoot, (element) => element.tag === 'rootfile');
    const fullPath = rootfile?.attrs['full-path'] ?? rootfile?.attrs['fullpath'] ?? '';
    if (fullPath) opfPath = resolvePath('', fullPath);
  }
  if (!opfPath) opfPath = findOpfPath(index);
  if (!opfPath) throw new EpubError('NOT_EPUB', '找不到 EPUB 的 OPF 主文件');

  const opfBytes = await readEntryBytes(index, opfPath);
  if (!opfBytes) throw new EpubError('CORRUPT', `OPF 文件缺失：${opfPath}`);

  const parsed = parseOpf(decodeXmlBytes(opfBytes).text, opfPath);
  if (parsed.spine.length === 0) throw new EpubError('EMPTY', 'EPUB 的 spine 为空，没有可阅读的正文');

  return { zip, index, parsed };
}