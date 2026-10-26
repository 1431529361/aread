import { escapeHtml } from '../text/entities';
import { parseXml, type XmlElement } from './xml';

/**
 * 块级容器：自身不产生段落，只用来递归收集子块。
 * （例如 <div><p>a</p><p>b</p></div> → 两个段落块）
 */
const BLOCK_CONTAINERS = new Set([
  'html', 'body', 'div', 'section', 'article', 'aside', 'header', 'footer',
  'main', 'nav', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'figure', 'form', 'fieldset', 'details', 'hgroup', 'dir', 'menu',
]);

/** 叶子块：子节点按行内内容处理，整体成为一个段落块。 */
const BLOCK_LEAVES = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dd', 'dt', 'td', 'th',
  'figcaption', 'caption', 'pre', 'blockquote', 'address', 'center', 'summary',
]);

/** 保留的行内标签（去属性）。其余行内标签透明处理：丢标签留文字。 */
const INLINE_KEEP = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'sup',
  'sub', 'small', 'big', 'code', 'kbd', 'samp', 'var', 'cite', 'q', 'abbr',
  'span', 'tt', 'font', 'ruby', 'rt', 'rp', 'rb', 'bdi', 'bdo',
]);

/** 整棵子树丢弃：脚本、样式、内嵌对象等。 */
const SKIP_SUBTREE = new Set([
  'script', 'style', 'head', 'title', 'link', 'meta', 'base', 'math',
  'object', 'embed', 'iframe', 'audio', 'video', 'canvas', 'noscript',
  'template', 'map', 'area', 'param', 'source', 'track',
]);

interface TextToken {
  kind: 'text';
  value: string;
}
interface MarkupToken {
  kind: 'open' | 'close' | 'void';
  html: string;
}
type InlineToken = TextToken | MarkupToken;

export interface SanitizedBlock {
  /** 源块级标签，用于渲染成标题/引用等样式 */
  tag: string;
  /** 已消毒的行内 HTML（可能为空，例如纯图片块） */
  html: string;
  /** 纯文本；与 HTML 渲染后的 textContent 逐一对应 */
  text: string;
  /** 相对本文档纯文本的字符 offset */
  start: number;
  end: number;
}

export interface SanitizedDocument {
  /** 全文纯文本；offset 与 blocks 共享同一坐标系 */
  text: string;
  blocks: SanitizedBlock[];
}

export interface SanitizeOptions {
  /** 把图片 src 解析成可直接嵌入的 data URI；返回 null 表示丢弃该图 */
  resolveImage?: (src: string) => string | null;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/** 收集文档中所有图片引用（用于提前把资源读成 data URI）。 */
export function collectImageSources(html: string): string[] {
  const root = parseXml(html);
  const out: string[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.tag === 'img' || child.tag === 'image') {
        const src = child.attrs['src'] ?? child.attrs['xlink:href'];
        if (src && !out.includes(src)) out.push(src);
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

function imageToken(element: XmlElement, options: SanitizeOptions): MarkupToken | null {
  const src = element.attrs['src'] ?? element.attrs['xlink:href'];
  if (!src) return null;
  if (src.startsWith('data:')) {
    return { kind: 'void', html: `<img src="${escapeHtml(src)}">` };
  }
  const resolved = options.resolveImage?.(src);
  if (!resolved) return null;
  const alt = element.attrs['alt'] ?? '';
  const altAttr = alt ? ` alt="${escapeHtml(alt)}"` : '';
  return { kind: 'void', html: `<img src="${escapeHtml(resolved)}"${altAttr}>` };
}

function wrapInline(element: XmlElement, options: SanitizeOptions): InlineToken[] {
  const inner = inlineChildren(element, options);
  if (INLINE_KEEP.has(element.tag)) {
    return [
      { kind: 'open', html: `<${element.tag}>` },
      ...inner,
      { kind: 'close', html: `</${element.tag}>` },
    ];
  }
  // 未知行内标签 / 链接 / 嵌套块：透明处理，只保留文字
  return inner;
}

function inlineChildren(element: XmlElement, options: SanitizeOptions): InlineToken[] {
  const tokens: InlineToken[] = [];
  for (const child of element.children) {
    if (child.type === 'text') {
      tokens.push({ kind: 'text', value: child.value });
      continue;
    }
    const tag = child.tag;
    if (SKIP_SUBTREE.has(tag)) continue;
    if (tag === 'br') {
      tokens.push({ kind: 'void', html: '<br>' });
      continue;
    }
    if (tag === 'img' || tag === 'image') {
      // <image> 是 SVG 里的位图引用（封面常见），同样渲染成 <img>
      const token = imageToken(child, options);
      if (token) tokens.push(token);
      continue;
    }
    tokens.push(...wrapInline(child, options));
  }
  return tokens;
}

/**
 * 把行内 token 归一化成 HTML + 纯文本。
 *
 * 关键不变量：返回的 text 必须与 HTML 的 textContent 完全相等。
 * 因此空白在整块范围内折叠（跨标签边界），且折叠后的空格落在“下一个有内容的文本里”，
 * 图片 / <br> 等空元素两边都不产生字符。
 */
function renderTokens(tokens: readonly InlineToken[]): { html: string; text: string } {
  let html = '';
  let text = '';
  let pendingSpace = false;
  let hasContent = false;

  for (const token of tokens) {
    if (token.kind !== 'text') {
      html += token.html;
      continue;
    }

    let chunk = '';
    for (let i = 0; i < token.value.length; i++) {
      const ch = token.value[i];
      if (WHITESPACE.has(ch)) {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && hasContent) chunk += ' ';
      pendingSpace = false;
      chunk += ch;
      hasContent = true;
    }
    if (chunk) {
      html += escapeHtml(chunk);
      text += chunk;
    }
  }

  return { html, text };
}

function collectBlocks(
  element: XmlElement,
  out: { tag: string; tokens: InlineToken[] }[],
  options: SanitizeOptions,
): void {
  let buffer: InlineToken[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    out.push({ tag: 'p', tokens: buffer });
    buffer = [];
  };

  for (const child of element.children) {
    if (child.type === 'text') {
      buffer.push({ kind: 'text', value: child.value });
      continue;
    }
    const tag = child.tag;
    if (SKIP_SUBTREE.has(tag)) continue;
    if (BLOCK_CONTAINERS.has(tag)) {
      flush();
      collectBlocks(child, out, options);
      continue;
    }
    if (BLOCK_LEAVES.has(tag)) {
      flush();
      out.push({ tag, tokens: inlineChildren(child, options) });
      continue;
    }
    buffer.push(...wrapInline(child, options));
  }

  flush();
}

export function sanitizeTree(root: XmlElement, options: SanitizeOptions = {}): SanitizedDocument {
  const raw: { tag: string; tokens: InlineToken[] }[] = [];
  collectBlocks(root, raw, options);

  const blocks: SanitizedBlock[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const item of raw) {
    const { html, text } = renderTokens(item.tokens);
    if (!text && !html) continue;

    if (text) {
      blocks.push({ tag: item.tag, html, text, start: cursor, end: cursor + text.length });
      parts.push(text);
      cursor += text.length + 1;
    } else {
      // 纯图片块：不占用任何字符，只决定渲染位置
      blocks.push({ tag: item.tag, html, text: '', start: cursor, end: cursor });
    }
  }

  return { text: parts.join('\n'), blocks };
}

/** 把 XHTML 消毒成「纯文本 + 带 offset 的块」，供阅读器与索引共用。 */
export function sanitizeDocument(html: string, options: SanitizeOptions = {}): SanitizedDocument {
  return sanitizeTree(parseXml(html), options);
}