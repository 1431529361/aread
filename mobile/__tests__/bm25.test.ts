import { describe, expect, it } from 'vitest';
import { scoreBm25 } from '../src/core/rag/bm25';

describe('scoreBm25', () => {
  it('命中查询词的文档按相关度排序', () => {
    const docs = [
      { id: 1, tokens: ['机器学习', '模型', '训练', '数据'] },
      { id: 2, tokens: ['机器学习', '机器学习', '模型'] },
      { id: 3, tokens: ['文学', '小说', '阅读'] },
    ];
    const hits = scoreBm25(['机器学习'], docs);
    expect(hits.map((hit) => hit.id)).toEqual([2, 1]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('没有命中的文档不会返回', () => {
    const hits = scoreBm25(['不存在'], [
      { id: 1, tokens: ['模型'] },
      { id: 2, tokens: ['数据'] },
    ]);
    expect(hits).toEqual([]);
  });

  it('查询词重复不会重复计分', () => {
    const docs = [{ id: 1, tokens: ['阅读', '阅读', '笔记'] }];
    const single = scoreBm25(['阅读'], docs)[0].score;
    const repeated = scoreBm25(['阅读', '阅读', '阅读'], docs)[0].score;
    expect(repeated).toBeCloseTo(single, 10);
  });

  it('空查询与空文档返回空数组', () => {
    expect(scoreBm25([], [{ id: 1, tokens: ['x'] }])).toEqual([]);
    expect(scoreBm25(['x'], [])).toEqual([]);
  });
});
