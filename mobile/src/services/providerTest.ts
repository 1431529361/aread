import { chatWithNativeFetch } from './llmRuntime';
import { embedTexts } from '../core/embedding/client';
import type { LlmClientConfig } from '../core/llm/client';
import type { EmbeddingClientConfig } from '../core/embedding/client';

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export async function testChatConnection(
  config: LlmClientConfig,
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  const response = await chatWithNativeFetch(config, {
    messages: [{ role: 'user', content: '请只回复：OK' }],
    temperature: 0,
    maxTokens: 16,
    timeoutMs: 30000,
  });
  const content = response.choices[0]?.message?.content?.trim() ?? '';
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    detail: content ? `模型回复：${content.slice(0, 40)}` : '连接成功（模型返回空内容）',
  };
}

export async function testEmbeddingConnection(
  config: EmbeddingClientConfig,
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  const vectors = await embedTexts(config, ['阅读测试 embedding 1024'], {
    retries: 0,
    timeoutMs: 30000,
  });
  const dims = vectors[0]?.length ?? 0;
  return {
    ok: dims === 1024,
    latencyMs: Date.now() - startedAt,
    detail: `返回 ${dims} 维向量${dims === 1024 ? '' : '（必须为 1024 维）'}`,
  };
}
