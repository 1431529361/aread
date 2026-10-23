export const DEFAULT_CONTEXT_WINDOW = 200000;
export const SINGLE_PASS_BUDGET_RATIO = 0.6;
export const DEFAULT_SINGLE_PASS_MAX_TOKENS = 100000;

/**
 * 保守估算：中文按 1 字 ≈ 1 token；英文/混合会偏高，但不会低估中文。
 * 所有上下文预算判断统一走这里。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return text.length;
}

export function singlePassBudget(
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  singlePassMaxTokens = DEFAULT_SINGLE_PASS_MAX_TOKENS,
): number {
  return Math.min(contextWindow * SINGLE_PASS_BUDGET_RATIO, singlePassMaxTokens);
}

export type NotesStrategy = 'single-pass' | 'map-reduce';

/**
 * 自动策略：能装进 60% 上下文窗口且不超过单次调用上限时走单次，
 * 否则走分层 map-reduce。大书优先分层，保证缓存、增量和失败隔离。
 */
export function selectNotesStrategy(
  content: string,
  options: {
    contextWindow?: number;
    singlePassMaxTokens?: number;
  } = {},
): NotesStrategy {
  const budget = singlePassBudget(
    options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    options.singlePassMaxTokens ?? DEFAULT_SINGLE_PASS_MAX_TOKENS,
  );
  return estimateTokens(content) <= budget ? 'single-pass' : 'map-reduce';
}

export function shouldUseMapReduce(
  text: string,
  options: {
    contextWindow?: number;
    singlePassMaxTokens?: number;
  } = {},
): boolean {
  return selectNotesStrategy(text, options) === 'map-reduce';
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  return text.length <= maxTokens
    ? text
    : `${text.slice(0, maxTokens)}…`;
}
