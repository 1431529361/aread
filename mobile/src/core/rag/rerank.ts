import { createRequestSignal, type FetchLike } from '../http';
import { normalizeBaseUrl } from '../embedding/signature';
import type { RetrievalHit } from '../types';

export const DEFAULT_RERANK_CANDIDATES = 20;
export const DEFAULT_RERANK_TEXT_CHARS = 400;
export const DEFAULT_NATIVE_RERANK_DOC_CHARS = 800;

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

export interface NativeRerankConfig {
  /** 复用 Embedding 配置 */
  baseUrl: string;
  apiKey: string;
  /** 如 BAAI/bge-reranker-v2-m3；留空表示不启用 */
  model: string;
  timeoutMs?: number;
}

export interface NativeRerankOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  topN?: number;
  maxDocumentChars?: number;
}

export interface NativeRerankItem {
  index: number;
  score: number;
}

export class RerankRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'RerankRequestError';
    this.status = status;
  }
}

/**
 * 调用与 Embedding 同一 Base URL/API Key 的 /rerank 端点。
 * 请求/响应格式兼容 SiliconFlow、Jina 等常见 rerank API。
 */
export async function rerankDocuments(
  config: NativeRerankConfig,
  query: string,
  documents: readonly string[],
  options: Omit<NativeRerankOptions, 'maxDocumentChars'> = {},
): Promise<NativeRerankItem[]> {
  if (documents.length === 0) return [];

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new RerankRequestError('Rerank Base URL 不能为空');
  if (!config.apiKey.trim()) throw new RerankRequestError('Rerank API Key 不能为空');
  if (!config.model.trim()) throw new RerankRequestError('Rerank 模型不能为空');

  const topN = Math.max(1, Math.min(options.topN ?? documents.length, documents.length));
  const requestSignal = createRequestSignal(config.timeoutMs ?? 30000, options.signal);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        query,
        documents: [...documents],
        top_n: topN,
      }),
      signal: requestSignal.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail =
        (body as { error?: { message?: string }; message?: string } | null)?.error
          ?.message ||
        (body as { message?: string } | null)?.message ||
        '';
      throw new RerankRequestError(
        `Rerank API 失败: ${response.status}${detail ? ` - ${detail}` : ''}`,
        response.status,
      );
    }

    const data = (await response.json()) as {
      results?: Array<{ index?: number; relevance_score?: number }>;
    };
    if (!Array.isArray(data.results)) {
      throw new RerankRequestError('Rerank 响应缺少 results');
    }

    const items: NativeRerankItem[] = [];
    const seen = new Set<number>();
    for (const item of data.results) {
      const index = Number(item.index);
      const score = Number(item.relevance_score);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= documents.length ||
        seen.has(index)
      ) {
        continue;
      }
      seen.add(index);
      items.push({ index, score: Number.isFinite(score) ? score : 0 });
    }

    if (items.length === 0) throw new RerankRequestError('Rerank 返回空结果');
    return items.sort((a, b) => b.score - a.score);
  } finally {
    requestSignal.cleanup();
  }
}

/**
 * 原生 reranker：留空模型返回 null（不启用）。
 * 任何网络/解析失败都回退原顺序，不影响检索主流程。
 */
export function createNativeReranker(
  config: NativeRerankConfig,
  options: Omit<NativeRerankOptions, 'topN' | 'signal'> & {
    topN?: number;
  } = {},
): RerankFunction | null {
  if (!config.model.trim()) return null;

  return async (query, hits) => {
    if (hits.length <= 1) return [...hits];

    const maxDocumentChars =
      options.maxDocumentChars ?? DEFAULT_NATIVE_RERANK_DOC_CHARS;
    const documents = hits.map((hit) =>
      (hit.text ?? '').trim().slice(0, maxDocumentChars),
    );

    try {
      const ranked = await rerankDocuments(config, query, documents, {
        fetchImpl: options.fetchImpl,
        topN: options.topN ?? hits.length,
      });
      const seen = new Set<number>();
      const reordered: RetrievalHit[] = [];
      for (const item of ranked) {
        const hit = hits[item.index];
        if (!hit || seen.has(item.index)) continue;
        seen.add(item.index);
        reordered.push(hit);
      }
      for (let index = 0; index < hits.length; index++) {
        if (!seen.has(index)) reordered.push(hits[index]);
      }
      return reordered;
    } catch {
      return [...hits];
    }
  };
}

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
