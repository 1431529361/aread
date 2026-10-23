import type { ProviderConfigRecord } from '../db/repositories/providers';
import type { EmbeddingClientConfig } from '../core/embedding/client';
import type { LlmClientConfig } from '../core/llm/client';
import { createNativeReranker, type RerankFunction } from '../core/rag/rerank';

export function buildChatConfig(
  record: ProviderConfigRecord,
  apiKey: string,
): LlmClientConfig {
  if (record.kind !== 'chat') throw new Error('不是对话模型配置');
  if (!apiKey.trim()) throw new Error('对话模型 API Key 不能为空');
  return {
    baseUrl: record.baseUrl,
    apiKey,
    model: record.model,
  };
}

export function buildEmbeddingConfig(
  record: ProviderConfigRecord,
  apiKey: string,
): EmbeddingClientConfig {
  if (record.kind !== 'embedding') throw new Error('不是向量模型配置');
  if (!apiKey.trim()) throw new Error('向量模型 API Key 不能为空');
  return {
    baseUrl: record.baseUrl,
    apiKey,
    model: record.model,
    dims: record.dims ?? 1024,
    dimensionsParam: record.dimensionsParam,
  };
}

/**
 * 向量模型设置下的可选 Rerank Model：
 * - 留空 → null，不启用重排
 * - 非空 → 复用向量模型的 Base URL / API Key 调用 /rerank
 */
export function buildReranker(
  record: ProviderConfigRecord,
  embeddingApiKey: string,
): RerankFunction | null {
  if (record.kind !== 'embedding') return null;
  if (!record.rerankModel?.trim() || !embeddingApiKey.trim()) return null;

  return createNativeReranker({
    baseUrl: record.baseUrl,
    apiKey: embeddingApiKey,
    model: record.rerankModel,
  });
}
