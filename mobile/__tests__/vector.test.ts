import { describe, expect, it } from 'vitest';
import {
  bytesToVector,
  centroidVector,
  cosineSimilarity,
  dotProduct,
  normalizeVector,
  rankByDot,
  vectorToBytes,
} from '../src/core/rag/vector';

describe('vector', () => {
  it('L2 归一化', () => {
    const normalized = normalizeVector([3, 4]);
    expect(normalized[0]).toBeCloseTo(0.6, 6);
    expect(normalized[1]).toBeCloseTo(0.8, 6);
  });

  it('零向量归一化不产生 NaN', () => {
    const normalized = normalizeVector([0, 0, 0]);
    expect([...normalized]).toEqual([0, 0, 0]);
  });

  it('点积与余弦相似度', () => {
    expect(dotProduct([1, 0], [0.6, 0.8])).toBeCloseTo(0.6, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1, 6);
  });

  it('维度不一致时点积报错', () => {
    expect(() => dotProduct([1, 2], [1, 2, 3])).toThrow();
  });

  it('按点积降序排序并跳过维度不一致的候选', () => {
    const hits = rankByDot(
      new Float32Array([1, 0]),
      [
        { chunkId: 'c', vector: [0, 1] },
        { chunkId: 'a', vector: [1, 0] },
        { chunkId: 'bad', vector: [1, 0, 0] },
        { chunkId: 'b', vector: [0.8, 0.6] },
      ],
      3,
    );

    expect(hits.map((hit) => hit.chunkId)).toEqual(['a', 'b', 'c']);
    expect(hits[0].score).toBeCloseTo(1, 6);
    expect(hits[2].score).toBeCloseTo(0, 6);
  });

  it('书级 centroid 忽略错误维度并返回归一化均值方向', () => {
    const centroid = centroidVector([[1, 0], [0, 1], [1, 2, 3]], 2);

    expect(centroid).not.toBeNull();
    expect(centroid?.[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centroid?.[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centroidVector([], 2)).toBeNull();
  });

  it('float32 BLOB 往返', () => {
    const source = new Float32Array([0.1, -2.5, 3.75]);
    const decoded = bytesToVector(vectorToBytes(source));

    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toBeCloseTo(0.1, 5);
    expect(decoded[1]).toBeCloseTo(-2.5, 5);
    expect(decoded[2]).toBeCloseTo(3.75, 5);
  });
});
