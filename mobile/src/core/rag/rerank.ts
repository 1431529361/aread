import type { RetrievalHit } from '../types';

export const DEFAULT_RERANK_CANDIDATES = 20;
export const DEFAULT_RERANK_TEXT_CHARS = 400;

export interface RerankLlm {
  complete(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string>;
}

export type RerankFunction = (
  query: string,
  hits: readonly RetrievalHit[],
) => Promise<RetrievalHit[]>;

export function buildRerankPrompt(
  query: string,
  hits: readonly RetrievalHit[],
  maxTextChars = DEFAULT_RERANK_TEXT_CHARS,
): string {
  const candidates = hits
    .map(
      (hit, index) =>
        `[${index}] 《${hit.bookTitle || '未知书籍'}/${hit.chapter || '未知章节'}》 ${hit.text
          .trim()
          .substring(0, maxTextChars)}`,
    )
    .join('\n\n');

  return `你是检索重排器。请判断以下候选片段与查询的相关性，并按从高到低排序。

查询：${query}

候选：
${candidates}

只输出 JSON 数组，元素为候选编号，例如 [2,0,1]。每个编号只能出现一次，不要输出解释或其他文字。`;
}

/** 解析并补全编号，保证返回恰好 count 个唯一索引。 */
export function parseRerankOrder(raw: string, count: number): number[] {
  if (count <= 0) return [];

  let parsed: unknown;
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    throw new Error('重排结果不是合法 JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('重排结果必须是数组');

  const order: number[] = [];
  const seen = new Set<number>();
  for (const item of parsed) {
    const index =
      typeof item === 'number'
        ? item
        : item && typeof item === 'object'
          ? Number(
              (item as Record<string, unknown>).index ??
                (item as Record<string, unknown>).candidateIndex,
            )
          : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) {
      continue;
    }
    seen.add(index);
    order.push(index);
  }

  if (order.length === 0) throw new Error('重排结果没有有效编号');
  for (let index = 0; index < count; index++) {
    if (!seen.has(index)) order.push(index);
  }
  return order;
}

export function reorderByIndex(
  hits: readonly RetrievalHit[],
  order: readonly number[],
): RetrievalHit[] {
  return order
    .map((index) => hits[index])
    .filter((hit): hit is RetrievalHit => hit != null);
}

/**
 * 复用现有对话 Provider 做 LLM rerank：无需额外 Key。
 * 任何失败（限流/超时/解析失败）都回退原顺序，不影响检索主流程。
 */
export function createLlmReranker(params: {
  llm: RerankLlm;
  maxCandidates?: number;
  maxTextChars?: number;
  maxTokens?: number;
}): RerankFunction {
  const maxCandidates = params.maxCandidates ?? DEFAULT_RERANK_CANDIDATES;

  return async (query, hits) => {
    if (hits.length <= 1) return [...hits];
    const candidates = hits.slice(0, maxCandidates);

    try {
      const raw = await params.llm.complete(
        buildRerankPrompt(query, candidates, params.maxTextChars),
        { maxTokens: params.maxTokens ?? 200, temperature: 0 },
      );
      const order = parseRerankOrder(raw, candidates.length);
      return reorderByIndex(candidates, order);
    } catch {
      return [...hits];
    }
  };
}
