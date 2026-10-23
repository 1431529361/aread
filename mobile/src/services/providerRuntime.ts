import type { DbAdapter } from '../db/adapter';
import {
  getProviderConfig,
  saveProviderConfig,
  type ProviderConfigRecord,
  type ProviderKind,
  type SaveProviderConfig,
} from '../db/repositories/providers';
import {
  buildChatConfig,
  buildEmbeddingConfig,
  getChatContextWindow,
} from './providerSettings';
import { getApiKey, maskApiKey, setApiKey } from './secureStore';
import type { LlmClientConfig } from '../core/llm/client';
import type { EmbeddingClientConfig } from '../core/embedding/client';

export interface ChatRuntime {
  record: ProviderConfigRecord;
  apiKey: string;
  config: LlmClientConfig;
  contextWindow: number;
}

export interface EmbeddingRuntime {
  record: ProviderConfigRecord;
  apiKey: string;
  config: EmbeddingClientConfig;
}

export async function loadChatRuntime(db: DbAdapter): Promise<ChatRuntime | null> {
  const record = await getProviderConfig(db, 'chat');
  if (!record) return null;
  const apiKey = await getApiKey('chat');
  if (!apiKey) return null;
  try {
    return {
      record,
      apiKey,
      config: buildChatConfig(record, apiKey),
      contextWindow: getChatContextWindow(record),
    };
  } catch {
    return null;
  }
}

export async function loadEmbeddingRuntime(
  db: DbAdapter,
): Promise<EmbeddingRuntime | null> {
  const record = await getProviderConfig(db, 'embedding');
  if (!record) return null;
  const apiKey = await getApiKey('embedding');
  if (!apiKey) return null;
  try {
    return { record, apiKey, config: buildEmbeddingConfig(record, apiKey) };
  } catch {
    return null;
  }
}

export interface SaveProviderInput {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  dims?: number | null;
  dimensionsParam?: number | null;
  rerankModel?: string | null;
  contextWindow?: number | null;
}

/**
 * 保存配置：Key 只进 SecureStore，DB 只保存掩码。
 * apiKey 留空表示沿用已保存的 Key（UI 里显示掩码时）。
 */
export async function saveProvider(
  db: DbAdapter,
  input: SaveProviderInput,
): Promise<void> {
  const existing = await getProviderConfig(db, input.kind);
  const newKey = input.apiKey?.trim() ?? '';

  if (newKey) await setApiKey(input.kind, newKey);

  const maskedKey = newKey
    ? maskApiKey(newKey)
    : existing?.maskedKey ?? null;

  const payload: SaveProviderConfig = {
    kind: input.kind,
    baseUrl: input.baseUrl,
    model: input.model,
    maskedKey,
    dims: input.kind === 'embedding' ? input.dims ?? 1024 : null,
    dimensionsParam:
      input.kind === 'embedding' ? input.dimensionsParam ?? null : null,
    rerankModel: input.kind === 'embedding' ? input.rerankModel ?? null : null,
    contextWindow:
      input.kind === 'chat' ? input.contextWindow ?? 200000 : undefined,
  };

  await saveProviderConfig(db, payload);
}
