import { readArchiveText, type EpubArchive } from './parse';
import { childElements, findElement, parseXml, textOf, type XmlElement } from './xml';
import { dirname, fragmentOf, resolvePath } from './resource';

export interface EpubTocEntry {
  title: string;
  /** spine 文档的 ZIP 内绝对路径（已去掉片段） */
  href: string;
  /** 原始锚点片段，M1 暂不用于精确滚动 */
  fragment: string;
  /** 目录层级，从 0 开始 */
  level: number;
}

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function walkNavList(
  list: XmlElement,
  level: number,
  baseDir: string,
  out: EpubTocEntry[],
): void {
  for (const item of childElements(list, 'li')) {
    let anchor: XmlElement | null = null;
    for (const child of childElements(item)) {
      if (child.tag === 'a') {
        anchor = child;
        break;
      }
      if (child.tag === 'span') {
        anchor = findElement(child, (element) => element.tag === 'a');
        if (anchor) break;
      }
    }

    if (anchor) {
      const rawHref = anchor.attrs['href'] ?? '';
      const title = cleanTitle(textOf(anchor));
      if (rawHref && title) {
        out.push({
          title,
          href: resolvePath(baseDir, rawHref),
          fragment: fragmentOf(rawHref),
          level,
        });
      }
    }

    for (const nested of childElements(item, 'ol')) {
      walkNavList(nested, level + 1, baseDir, out);
    }
  }
}

function parseNavDocument(navText: string, baseDir: string): EpubTocEntry[] {
  const root = parseXml(navText);
  const allNavs: XmlElement[] = [];
  const collect = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.tag === 'nav') allNavs.push(child);
      collect(child);
    }
  };
  collect(root);

  // 优先取 epub:type="toc" 的 nav，否则取第一个含 <ol> 的 nav
  const preferred =
    allNavs.find((nav) => {
      const type = nav.attrs['epub:type'] ?? nav.attrs['type'] ?? '';
      return type.split(/\s+/).includes('toc');
    }) ?? allNavs.find((nav) => findElement(nav, (element) => element.tag === 'ol') != null);

  if (!preferred) return [];
  const out: EpubTocEntry[] = [];
  for (const list of childElements(preferred, 'ol')) {
    walkNavList(list, 0, baseDir, out);
  }
  return out;
}

function walkNavPoints(
  parent: XmlElement,
  level: number,
  baseDir: string,
  out: EpubTocEntry[],
): void {
  for (const point of childElements(parent, 'navpoint')) {
    const label = findElement(point, (element) => element.tag === 'navlabel');
    const labelText = label ? findElement(label, (element) => element.tag === 'text') : null;
    const content = findElement(point, (element) => element.tag === 'content');
    const src = content?.attrs['src'] ?? '';
    const title = labelText ? cleanTitle(textOf(labelText)) : '';
    if (src && title) {
      out.push({
        title,
        href: resolvePath(baseDir, src),
        fragment: fragmentOf(src),
        level,
      });
    }
    walkNavPoints(point, level + 1, baseDir, out);
  }
}

function parseNcxDocument(ncxText: string, baseDir: string): EpubTocEntry[] {
  const root = parseXml(ncxText);
  const navMap = findElement(root, (element) => element.tag === 'navmap');
  if (!navMap) return [];
  const out: EpubTocEntry[] = [];
  walkNavPoints(navMap, 0, baseDir, out);
  return out;
}

/** 读取 EPUB 目录：EPUB3 nav 文档优先，回退到 EPUB2 的 toc.ncx。 */
export async function loadEpubToc(archive: EpubArchive): Promise<EpubTocEntry[]> {
  const { parsed } = archive;

  if (parsed.navHref) {
    const navText = await readArchiveText(archive, parsed.navHref);
    if (navText) {
      const entries = parseNavDocument(navText, dirname(parsed.navHref));
      if (entries.length > 0) return entries;
    }
  }

  if (parsed.ncxHref) {
    const ncxText = await readArchiveText(archive, parsed.ncxHref);
    if (ncxText) {
      const entries = parseNcxDocument(ncxText, dirname(parsed.ncxHref));
      if (entries.length > 0) return entries;
    }
  }

  return [];
}

/** 没有目录时按 spine 顺序生成占位条目，保证阅读器始终能翻章。 */
export function fallbackToc(spine: readonly string[]): EpubTocEntry[] {
  return spine.map((href, index) => ({
    title: `第 ${index + 1} 节`,
    href,
    fragment: '',
    level: 0,
  }));
}