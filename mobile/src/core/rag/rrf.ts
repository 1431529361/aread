export const RRF_K = 60;

export interface RankedItem {
  id: string | number;
}

export interface RrfHit<T extends RankedItem> {
  item: T;
  score: number;
}

/**
 * Reciprocal Rank Fusion：score = Σ 1 / (k + rank + 1)，按 id 去重累加。
 * 与 Web 版 rag.js 的 rrfFuse 保持同一排序规则。
 */
export function rrfFuse<T extends RankedItem>(
  lists: ReadonlyArray<ReadonlyArray<T> | null | undefined>,
  topK: number,
  k: number = RRF_K,
): RrfHit<T>[] {
  const merged = new Map<T['id'], RrfHit<T>>();

  for (const list of lists) {
    if (!list) continue;
    list.forEach((item, rank) => {
      const hit = merged.get(item.id) ?? { item, score: 0 };
      hit.score += 1 / (k + rank + 1);
      merged.set(item.id, hit);
    });
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK));
}
