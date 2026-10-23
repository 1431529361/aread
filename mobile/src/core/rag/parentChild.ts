import {
  chunkText,
  type ChunkLocKind,
  type ChunkResult,
  type ChunkTextOptions,
} from './chunk';

export const DEFAULT_PARENT_SIZE = 1800;
export const DEFAULT_PARENT_OVERLAP = 0;
// 目标 300~500 字；chunkText 在段落聚合时最多放宽到 1.5 倍
export const DEFAULT_CHILD_SIZE = 330;
export const DEFAULT_CHILD_OVERLAP = 50;
export const DEFAULT_EXPAND_MAX_CHARS = 1800;

export interface ParentChildOptions
  extends Omit<ChunkTextOptions, 'chunkSize' | 'overlap'> {
  parentSize?: number;
  parentOverlap?: number;
  childSize?: number;
  childOverlap?: number;
  locKind?: ChunkLocKind;
}

/**
 * 两级分块：
 * - 父块 1500~2000 字，仅用于生成时扩写上下文
 * - 子块 300~500 字，写入 FTS/向量用于检索
 * 入库只存子块，同一父块子块共享 parent_index；引用 locator 始终指向子块。
 */
export function chunkParentChild(
  content: string,
  options: ParentChildOptions = {},
): ChunkResult[] {
  const parentSize = options.parentSize ?? DEFAULT_PARENT_SIZE;
  const parentOverlap = options.parentOverlap ?? DEFAULT_PARENT_OVERLAP;
  const childSize = options.childSize ?? DEFAULT_CHILD_SIZE;
  const childOverlap = options.childOverlap ?? DEFAULT_CHILD_OVERLAP;

  const parents = chunkText(content, {
    locKind: options.locKind,
    href: options.href,
    chunkSize: parentSize,
    overlap: parentOverlap,
  });

  const children: ChunkResult[] = [];

  parents.forEach((parent, parentIndex) => {
    const parentChildren = chunkText(parent.text, {
      locKind: options.locKind,
      href: options.href,
      chunkSize: childSize,
      overlap: childOverlap,
    });

    for (const child of parentChildren) {
      children.push({
        ...child,
        index: children.length,
        chapter: parent.chapter,
        loc_start: parent.loc_start + child.loc_start,
        loc_end: parent.loc_start + child.loc_end,
        parent_index: parentIndex,
      });
    }
  });

  return children;
}

/**
 * 合并有重叠的子块文本。检测最长公共前后缀（至少 8 字），
 * 无重叠时用换行分隔，避免直接粘成一句。
 */
export function mergeOverlappingTexts(
  texts: readonly string[],
  maxOverlap = 120,
): string {
  let merged = '';

  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (!merged) {
      merged = text;
      continue;
    }

    const max = Math.min(maxOverlap, merged.length, text.length);
    let overlap = 0;
    for (let length = max; length >= 8; length--) {
      if (merged.endsWith(text.slice(0, length))) {
        overlap = length;
        break;
      }
    }

    merged += overlap > 0 ? text.slice(overlap) : `\n${text}`;
  }

  return merged;
}

export function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars))}…`;
}
