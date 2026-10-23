import { defaultSleep, type FetchLike } from '../http';
import { EMBED_DIMS, normalizeBaseUrl } from './signature';

export type { FetchLike } from '../http';

export interface EmbeddingClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 可选的 dimensions 请求参数；为 undefined/null 时不发送该字段 */
  dimensionsParam?: number | null;
  dims?: number;
}

export class EmbeddingRequestError extends Error {
  readonly status: number;
  readonly fatal: boolean;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; fatal?: boolean; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'EmbeddingRequestError';
    this.status = options.status ?? 0;
    this.fatal = options.fatal ?? false;
    this.retryable = options.retryable ?? false;
  }
}

export interface EmbedTextsOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  retries?: number;
  timeoutMs?: number;
}

function buildError(message: string, status: number): EmbeddingRequestError {
  const fatal = status >= 400 && status < 500 && status !== 429;
  return new EmbeddingRequestError(message, {
    status,
    fatal,
    retryable: status === 429 || status >= 500,
  });
}

/**
 * 调用自定义 OpenAI 兼容 Embedding 端点。
 * - 默认请求体只含 model + input；配置了 dimensions 才附带
 * - 统一校验 1024 维，维度不符视为 fatal，不重试
 * - 429/5xx/超时按指数退避重试；其余 4xx 不重试
 */
export async function embedTexts(
  config: EmbeddingClientConfig,
  texts: readonly string[],
  options: EmbedTextsOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new EmbeddingRequestError('Embedding Base URL 不能为空', { fatal: true });
  if (!config.apiKey.trim()) {
    throw new EmbeddingRequestError('Embedding API Key 不能为空', { fatal: true });
  }
  if (!config.model.trim()) {
    throw new EmbeddingRequestError('Embedding 模型不能为空', { fatal: true });
  }

  const dims = config.dims ?? EMBED_DIMS;
  if (dims !== EMBED_DIMS) {
    throw new EmbeddingRequestError(`Embedding 维度固定为 ${EMBED_DIMS}`, { fatal: true });
  }

  const endpoint = `${baseUrl}/embeddings`;
  const body: Record<string, unknown> = { model: config.model, input: [...texts] };
  if (config.dimensionsParam != null) body.dimensions = config.dimensionsParam;

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 30000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (options.signal?.aborted) {
        throw new EmbeddingRequestError('Embedding 请求已取消', { fatal: true });
      }

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const detail =
          (errorBody as { error?: { message?: string }; message?: string })?.error?.message ||
          (errorBody as { message?: string })?.message ||
          '';
        throw buildError(
          `Embedding API 失败: ${response.status}${detail ? ` - ${detail}` : ''}`,
          response.status,
        );
      }

      const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const vectors = (data.data ?? []).map((item) => item.embedding ?? []);

      if (vectors.length !== texts.length) {
        throw new EmbeddingRequestError('Embedding 返回数量与输入不一致', { fatal: true });
      }
      for (const vector of vectors) {
        if (vector.length !== dims) {
          throw new EmbeddingRequestError(
            `Embedding 维度不匹配：期望 ${dims}，实际 ${vector.length}（请更换模型或填写 dimensions=1024）`,
            { fatal: true },
          );
        }
      }

      return vectors;
    } catch (error) {
      lastError = error;
      const requestError =
        error instanceof EmbeddingRequestError
          ? error
          : new EmbeddingRequestError(
              error instanceof Error ? error.message : String(error),
              { retryable: true },
            );

      if (requestError.fatal) throw requestError;
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new EmbeddingRequestError(String(lastError));
}

/** 设置页“测试连接”：单条测试文本 + 1024 维校验，失败直接抛错。 */
export async function validateEmbeddingConfig(
  config: EmbeddingClientConfig,
  options: Omit<EmbedTextsOptions, 'retries'> = {},
): Promise<true> {
  await embedTexts(config, ['测试'], { ...options, retries: 0, timeoutMs: 15000 });
  return true;
}
