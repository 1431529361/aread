import { describe, expect, it } from 'vitest';
import { RRF_K, rrfFuse } from '../src/core/rag/rrf';

const a = { id: 'a' };
const b = { id: 'b' };
const c = { id: 'c' };

describe('rrfFuse', () => {
  it('按两路排名累加分数并去重', () => {
    const hits = rrfFuse([[a, b], [b, c]], 3);

    expect(hits.map((hit) => hit.item.id)).toEqual(['b', 'a', 'c']);
    expect(hits[0].score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 10);
    expect(hits[1].score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(hits[2].score).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it('忽略 null / undefined 列表', () => {
    expect(rrfFuse([null, [a], undefined], 5).map((hit) => hit.item.id)).toEqual(['a']);
  });

  it('按 topK 截断', () => {
    expect(rrfFuse([[a, b, c]], 2)).toHaveLength(2);
  });

  it('空输入返回空数组', () => {
    expect(rrfFuse([], 10)).toEqual([]);
  });
});
