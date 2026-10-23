import { createRequestSignal, defaultSleep, type FetchLike } from '../http';
import { normalizeBaseUrl } from '../embedding/signature';

export type { FetchLike } from '../http';

export interface LlmClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ToolCall {
  id: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LlmToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
}

export type FetchLikeImpl = FetchLike;

export class LlmRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; body?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'LlmRequestError';
    this.status = options.status ?? 0;
    this.body = options.body;
    this.retryable = options.retryable ?? false;
  }
}

function endpointFor(config: LlmClientConfig): string {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new LlmRequestError('LLM Base URL 不能为空');
  if (!config.apiKey.trim()) throw new LlmRequestError('LLM API Key 不能为空');
  if (!config.model.trim()) throw new LlmRequestError('LLM 模型不能为空');
  return `${baseUrl}/chat/completions`;
}

function headersFor(config: LlmClientConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
}

async function toRequestError(response: Response): Promise<LlmRequestError> {
  const body = await response.json().catch(() => null);
  const detail =
    (body as { error?: { message?: string } } | null)?.error?.message || '';
  return new LlmRequestError(
    `LLM 调用失败: ${response.status}${detail ? ` - ${detail}` : ''}`,
    {
      status: response.status,
      body,
      retryable: response.status === 429 || response.status >= 500,
    },
  );
}

export interface ChatOptions {
  messages: readonly ChatMessage[];
  tools?: readonly LlmToolSchema[] | null;
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export async function chat(
  config: LlmClientConfig,
  options: ChatOptions,
): Promise<ChatResponse> {
  const endpoint = endpointFor(config);
  const body: Record<string, unknown> = {
    model: config.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 1500,
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? 'auto';
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 0;
  const timeoutMs = options.timeoutMs ?? 60000;

  let lastError: unknown;
  if (options.signal?.aborted) {
    throw new LlmRequestError('LLM 请求已取消');
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const requestSignal = createRequestSignal(timeoutMs, options.signal);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: headersFor(config),
        body: JSON.stringify(body),
        signal: requestSignal.signal,
      });
      if (!response.ok) throw await toRequestError(response);
      return (await response.json()) as ChatResponse;
    } catch (error) {
      lastError = error;
      const requestError =
        error instanceof LlmRequestError
          ? error
          : new LlmRequestError(error instanceof Error ? error.message : String(error), {
              retryable: true,
            });

      if (options.signal?.aborted) throw requestError;
      if (requestError.status >= 400 && requestError.status < 500 && requestError.status !== 429) {
        throw requestError;
      }
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    } finally {
      requestSignal.cleanup();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new LlmRequestError(String(lastError));
}

export async function complete(
  config: LlmClientConfig,
  promptOrMessages: string | readonly ChatMessage[],
  options: Omit<ChatOptions, 'messages' | 'tools' | 'toolChoice'> = {},
): Promise<string> {
  const messages =
    typeof promptOrMessages === 'string'
      ? [{ role: 'user' as const, content: promptOrMessages }]
      : promptOrMessages;
  const response = await chat(config, { ...options, messages });
  return (response.choices[0]?.message?.content ?? '').trim();
}

export interface StreamOptions
  extends Omit<ChatOptions, 'retries' | 'tools' | 'toolChoice'> {
  onStart?: (info: { model: string }) => void;
  onChunk?: (content: string) => void;
}

/** SSE 流式对话；流式不做重试，避免重复下发内容。 */
export async function stream(
  config: LlmClientConfig,
  options: StreamOptions,
): Promise<string> {
  const endpoint = endpointFor(config);
  const timeoutMs = options.timeoutMs ?? 90000;
  const requestSignal = createRequestSignal(timeoutMs, options.signal);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    if (options.signal?.aborted) {
      throw new LlmRequestError('LLM 请求已取消');
    }

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: headersFor(config),
      body: JSON.stringify({
        model: config.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.4,
        max_tokens: options.maxTokens ?? 2000,
        stream: true,
      }),
      signal: requestSignal.signal,
    });

    if (!response.ok) throw await toRequestError(response);
    options.onStart?.({ model: config.model });

    const reader = response.body?.getReader();
    if (!reader) throw new LlmRequestError('LLM 响应没有可读流');

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    const handleLine = (rawLine: string): void => {
      const line = rawLine.replace(/\r$/, '');
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const content = parsed.choices?.[0]?.delta?.content ?? '';
        if (content) {
          fullContent += content;
          options.onChunk?.(content);
        }
      } catch {
        // 忽略不完整/非 JSON 的 SSE 行
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) handleLine(line);
    }
    if (buffer) handleLine(buffer);

    return fullContent;
  } finally {
    requestSignal.cleanup();
  }
}
