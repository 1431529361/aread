import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateTokens,
  selectNotesStrategy,
  shouldUseMapReduce,
  singlePassBudget,
  truncateToTokenBudget,
} from '../src/core/context/tokens';

describe('context tokens', () => {
  it('默认 context_window 为 200k，单次预算 60% 且不超过 100k', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200000);
    expect(singlePassBudget()).toBe(100000);
    expect(singlePassBudget(200000, 150000)).toBe(120000);
    expect(singlePassBudget(128000)).toBe(76800);
  });

  it('中文按 1 字 ≈ 1 token 保守估算', () => {
    expect(estimateTokens('中文测试')).toBe(4);
    expect(estimateTokens('hello')).toBe(5);
  });

  it('100k/100001 边界决定单次或分层', () => {
    expect(selectNotesStrategy('字'.repeat(100000))).toBe('single-pass');
    expect(selectNotesStrategy('字'.repeat(100001))).toBe('map-reduce');
  });

  it('小书单次、大书分层', () => {
    expect(selectNotesStrategy('字'.repeat(80000))).toBe('single-pass');
    expect(selectNotesStrategy('字'.repeat(251753))).toBe('map-reduce');
    expect(shouldUseMapReduce('字'.repeat(80000))).toBe(false);
  });

  it('可配置 context_window 与单次上限', () => {
    expect(
      selectNotesStrategy('字'.repeat(80000), {
        contextWindow: 128000,
      }),
    ).toBe('map-reduce');
    expect(
      selectNotesStrategy('字'.repeat(50000), {
        singlePassMaxTokens: 50000,
      }),
    ).toBe('single-pass');
    expect(
      selectNotesStrategy('字'.repeat(50001), {
        singlePassMaxTokens: 50000,
      }),
    ).toBe('map-reduce');
  });

  it('truncateToTokenBudget 按 1 字≈1 token 截断', () => {
    expect(truncateToTokenBudget('abcdef', 3)).toBe('abc…');
    expect(truncateToTokenBudget('abc', 3)).toBe('abc');
  });
});
