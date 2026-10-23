import type { DbAdapter } from '../db/adapter';
import { loadChunksByParents } from '../db/repositories/chunks';
import {
  DEFAULT_EXPAND_MAX_CHARS,
  mergeOverlappingTexts,
  truncateToBudget,
} from '../core/rag/parentChild';
import type { ChunkRecord, RetrievalHit } from '../core/types';

export interface ExpandParentsOptions {
  maxChars?: number;
  maxOverlap?: number;
}

/**
 * small-to-big：把命中子块扩展到同一 parent_index 的完整父块文本。
 * - hit.text 保留子块原文（引用 locator 仍指向子块）
 * - hit.parentText 为合并后的父块文本，供生成使用
 * - 同一父块的多个子块命中会合并为一条，childHits 保留全部子命中
 */
export async function expandRetrievalHits(
  db: DbAdapter,
  hits: readonly RetrievalHit[],
  options: ExpandParentsOptions = {},
): Promise<RetrievalHit[]> {
  if (hits.length === 0) return [];

  const maxChars = options.maxChars ?? DEFAULT_EXPAND_MAX_CHARS;
  const maxOverlap = options.maxOverlap ?? 120;

  const parentsByBook = new Map<string, Set<number>>();
  for (const hit of hits) {
    if (hit.parentIndex == null) continue;
    const parents = parentsByBook.get(hit.bookId) ?? new Set<number>();
    parents.add(hit.parentIndex);
    parentsByBook.set(hit.bookId, parents);
  }

  const childrenByParent = new Map<string, ChunkRecord[]>();
  for (const [bookId, parents] of parentsByBook) {
    const children = await loadChunksByParents(db, {
      bookId,
      parentIndices: [...parents],
    });
    for (const child of children) {
      if (child.parentIndex == null) continue;
      const key = `${bookId}:p:${child.parentIndex}`;
      const group = childrenByParent.get(key) ?? [];
      group.push(child);
      childrenByParent.set(key, group);
    }
  }

  const expanded: RetrievalHit[] = [];
  const indexByKey = new Map<string, number>();

  for (const hit of hits) {
    const key =
      hit.parentIndex != null
        ? `${hit.bookId}:p:${hit.parentIndex}`
        : `${hit.bookId}:c:${hit.chunkId}`;

    const existingIndex = indexByKey.get(key);
    if (existingIndex != null) {
      const existing = expanded[existingIndex];
      existing.childHits = [...(existing.childHits ?? []), hit];
      continue;
    }

    let parentText = hit.text;
    if (hit.parentIndex != null) {
      const children = (childrenByParent.get(key) ?? []).sort(
        (a, b) => a.chunkIndex - b.chunkIndex,
      );
      if (children.length > 0) {
        parentText = mergeOverlappingTexts(
          children.map((child) => child.text),
          maxOverlap,
        );
      }
    }

    expanded.push({
      ...hit,
      parentIndex: hit.parentIndex ?? null,
      parentText: truncateToBudget(parentText, maxChars),
      childHits: [hit],
    });
    indexByKey.set(key, expanded.length - 1);
  }

  return expanded;
}
