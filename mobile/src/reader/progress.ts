import type { Locator } from '../core/types';

export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress));
}

/** 以 locator 起点计算阅读进度；用于恢复/保存时校验。 */
export function progressFromLocator(locator: Locator, textLength: number): number {
  if (!Number.isFinite(textLength) || textLength <= 0) return 0;
  return clampProgress(locator.start / textLength);
}

/** 没有 locator 时按比例回退到全文字符 offset。 */
export function locatorFromProgress(progress: number, textLength: number): Locator {
  const length = Math.max(0, Math.floor(textLength));
  const start = Math.min(length, Math.round(clampProgress(progress) * length));
  return { kind: 'txt', href: null, start, end: start };
}

export interface Snippet {
  text: string;
  prefix: string;
  suffix: string;
}

/**
 * 在命中块中截取查询附近的文本，避免把整章塞进搜索结果。
 */
export function buildSnippet(
  text: string,
  query: string,
  options: { maxChars?: number } = {},
): Snippet {
  const maxChars = Math.max(20, options.maxChars ?? 160);
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return { text: trimmed, prefix: '', suffix: '' };

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  const lower = trimmed.toLowerCase();
  let index = -1;
  for (const term of terms) {
    index = lower.indexOf(term);
    if (index >= 0) break;
  }
  if (index < 0) index = 0;

  const lead = Math.floor(maxChars * 0.3);
  let start = Math.max(0, index - lead);
  if (start > 0) {
    const newline = trimmed.indexOf('\n', start);
    if (newline >= 0 && newline < index) start = newline + 1;
  }
  let end = Math.min(trimmed.length, start + maxChars);
  if (end < trimmed.length) {
    const newline = trimmed.lastIndexOf('\n', end);
    if (newline > start) end = newline;
  }

  return {
    text: trimmed.slice(start, end),
    prefix: start > 0 ? '…' : '',
    suffix: end < trimmed.length ? '…' : '',
  };
}
