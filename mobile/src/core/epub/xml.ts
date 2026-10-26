import { decodeEntities } from '../text/entities';

export interface XmlElement {
  type: 'element';
  /** 小写、已去命名空间前缀的标签名 */
  tag: string;
  /** 原始标签名（保留前缀，便于诊断） */
  raw: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  type: 'text';
  value: string;
}

export type XmlNode = XmlElement | XmlText;

/** 这些标签的内容是原始文本，不能当标记解析。 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea']);

function localName(raw: string): string {
  const colon = raw.indexOf(':');
  return (colon >= 0 ? raw.slice(colon + 1) : raw).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 找到起始标签的 '>' 位置，跳过引号内的内容。 */
function findTagEnd(source: string, from: number): number {
  let quote = '';
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function parseTag(body: string): { raw: string; tag: string; attrs: Record<string, string> } {
  const nameMatch = /^\s*([^\s/>]+)/.exec(body);
  const raw = nameMatch ? nameMatch[1] : '';
  const attrs: Record<string, string> = {};
  const rest = nameMatch ? body.slice(nameMatch[0].length) : '';

  const attrRe = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(rest)) !== null) {
    const name = match[1].toLowerCase();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeEntities(value);
  }

  return { raw, tag: localName(raw), attrs };
}

/**
 * 宽容的 XML/XHTML 解析器：EPUB 内容文档是良构 XML，但不保证有 DTD/命名空间声明。
 * 不引入依赖（Hermes 无 DOMParser），返回最小可用的树。
 */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { type: 'element', tag: '#root', raw: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];

  const current = (): XmlElement => stack[stack.length - 1];
  const addText = (value: string): void => {
    if (!value) return;
    current().children.push({ type: 'text', value: decodeEntities(value) });
  };

  let i = 0;
  const n = source.length;

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) addText(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      addText(source.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt < 0) break;
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith('/')) {
      const tag = localName(inner.slice(1).trim());
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const info = parseTag(selfClosing ? inner.slice(0, -1) : inner);
    if (!info.tag) continue;

    const element: XmlElement = {
      type: 'element',
      tag: info.tag,
      raw: info.raw,
      attrs: info.attrs,
      children: [],
    };
    current().children.push(element);

    if (selfClosing) continue;

    if (RAW_TEXT_TAGS.has(info.tag)) {
      const closeRe = new RegExp(`</\\s*${escapeRegExp(info.raw)}\\s*>`, 'i');
      const rest = source.slice(i);
      const match = closeRe.exec(rest);
      const end = match ? i + match.index : n;
      if (end > i) element.children.push({ type: 'text', value: source.slice(i, end) });
      i = match ? i + match.index + match[0].length : n;
      continue;
    }

    stack.push(element);
  }

  return root;
}

/** 深度优先查找第一个满足条件的元素。 */
export function findElement(
  node: XmlElement,
  predicate: (element: XmlElement) => boolean,
): XmlElement | null {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (predicate(child)) return child;
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

/** 深度优先收集所有满足条件的元素。 */
export function findElements(
  node: XmlElement,
  predicate: (element: XmlElement) => boolean,
  out: XmlElement[] = [],
): XmlElement[] {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (predicate(child)) out.push(child);
    findElements(child, predicate, out);
  }
  return out;
}

/** 直接子元素（不递归）。 */
export function childElements(node: XmlElement, tag?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (tag && child.tag !== tag) continue;
    out.push(child);
  }
  return out;
}

/** 拼接元素下所有文本（用于 dc:title 之类的取值）。 */
export function textOf(node: XmlElement): string {
  let out = '';
  for (const child of node.children) {
    out += child.type === 'text' ? child.value : textOf(child);
  }
  return out;
}