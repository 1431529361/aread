export const SHORT_CHAPTER_MAX_CHARS = 14000;
export const BATCH_MAX_CHAPTERS = 3;
export const BATCH_MAX_CHARS = 12000;

export interface BatchChapterUnit {
  chapterIndex: number;
  title: string;
  text: string;
}

/** 短章节：整章作为单个 Map 单元，可与其他短章合并调用。 */
export function isShortChapter(
  text: string,
  threshold = SHORT_CHAPTER_MAX_CHARS,
): boolean {
  return text.length <= threshold;
}

/**
 * 贪心打包：最多 3 章或 12000 字符，两者先到为准。
 * 调用方应只传未缓存章节；长章节不应进入本函数。
 */
export function planChapterBatches(
  units: readonly BatchChapterUnit[],
  options: {
    maxChapters?: number;
    maxChars?: number;
  } = {},
): BatchChapterUnit[][] {
  const maxChapters = options.maxChapters ?? BATCH_MAX_CHAPTERS;
  const maxChars = options.maxChars ?? BATCH_MAX_CHARS;
  const batches: BatchChapterUnit[][] = [];
  let current: BatchChapterUnit[] = [];
  let currentChars = 0;

  for (const unit of units) {
    const wouldExceed =
      current.length > 0 &&
      (current.length >= maxChapters || currentChars + unit.text.length > maxChars);

    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(unit);
    currentChars += unit.text.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export interface ChapterIndexedItem {
  chapterIndex: number;
}

/**
 * 批量结果必须与请求章节一一对应：
 * 数量一致、chapterIndex 齐全、无重复、无额外章节。
 */
export function validateChapterBatch<T extends ChapterIndexedItem>(
  value: unknown,
  expectedIndices: readonly number[],
): Map<number, T> | null {
  if (!Array.isArray(value) || value.length !== expectedIndices.length) {
    return null;
  }

  const expected = new Set(expectedIndices);
  const result = new Map<number, T>();

  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const chapterIndex = Number((item as { chapterIndex?: unknown }).chapterIndex);
    if (
      !Number.isInteger(chapterIndex) ||
      !expected.has(chapterIndex) ||
      result.has(chapterIndex)
    ) {
      return null;
    }
    result.set(chapterIndex, item as T);
  }

  if (result.size !== expected.size) return null;
  for (const index of expectedIndices) {
    if (!result.has(index)) return null;
  }
  return result;
}
