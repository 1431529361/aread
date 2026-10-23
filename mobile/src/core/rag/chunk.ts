export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 100;

export const CHAPTER_RE =
  /^(第[一二三四五六七八九十零百千万]+[章节回部篇集]|[第\d]+[章节回部篇集]|[一二三四五六七八九十零]+[、.]|[\d]+[、.]|Chapter\s*\d+|CHAPTER\s*\d+)/i;

export type ChunkLocKind = 'txt' | 'epub';

export interface ChunkResult {
  index: number;
  chapter: string;
  text: string;
  loc_kind: ChunkLocKind;
  loc_href: string | null;
  loc_start: number;
  loc_end: number;
}

export interface ChunkTextOptions {
  chunkSize?: number;
  overlap?: number;
  locKind?: ChunkLocKind;
  href?: string | null;
}

interface Paragraph {
  text: string;
  start: number;
  end: number;
}

/** 统一换行符并去掉 BOM。locator 的字符 offset 以该函数返回的文本为准。 */
export function normalizeText(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function splitParagraphs(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const re = /[^\n]+/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    let start = match.index;
    let end = match.index + match[0].length;
    while (start < end && /\s/.test(content[start])) start++;
    while (end > start && /\s/.test(content[end - 1])) end--;
    if (end > start) paragraphs.push({ text: content.slice(start, end), start, end });
  }

  return paragraphs;
}

/**
 * 按章节边界 + 滑动窗口分块，返回带 locator 的块。
 * - TXT：offset 为归一化全文中的字符位置
 * - EPUB：offset 为当前 spine 文档内的字符位置，href 由调用方传入
 */
export function chunkText(content: string, options: ChunkTextOptions = {}): ChunkResult[] {
  const text = normalizeText(content);
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const overlap = Math.min(
    Math.max(0, Math.floor(options.overlap ?? DEFAULT_CHUNK_OVERLAP)),
    chunkSize - 1,
  );
  const locKind = options.locKind ?? 'txt';
  const href = options.href ?? null;

  if (!text.trim()) return [];

  const paragraphs = splitParagraphs(text);
  const chunks: ChunkResult[] = [];
  let currentChapter = '前言';
  let bufferStart: number | null = null;
  let bufferEnd = 0;

  const pushRange = (start: number, end: number): void => {
    let from = start;
    let to = Math.min(end, text.length);
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (to <= from) return;

    chunks.push({
      index: chunks.length,
      chapter: currentChapter,
      text: text.slice(from, to),
      loc_kind: locKind,
      loc_href: href,
      loc_start: from,
      loc_end: to,
    });
  };

  const flushBuffer = (): void => {
    if (bufferStart === null) return;
    const start = bufferStart;
    const end = bufferEnd;
    bufferStart = null;

    if (end - start > chunkSize * 1.5) {
      const step = chunkSize - overlap;
      for (let i = start; i < end; i += step) {
        pushRange(i, Math.min(i + chunkSize, end));
      }
    } else {
      pushRange(start, end);
    }
  };

  for (const paragraph of paragraphs) {
    if (CHAPTER_RE.test(paragraph.text)) {
      flushBuffer();
      currentChapter = paragraph.text.substring(0, 60);
      bufferStart = paragraph.start;
      bufferEnd = paragraph.end;
      continue;
    }

    if (bufferStart === null) bufferStart = paragraph.start;
    bufferEnd = paragraph.end;
    if (bufferEnd - bufferStart >= chunkSize) flushBuffer();
  }
  flushBuffer();

  return chunks;
}
