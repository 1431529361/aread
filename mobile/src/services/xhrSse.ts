import {
  LlmRequestError,
  type LlmClientConfig,
  type StreamOptions,
} from '../core/llm/client';
import { normalizeBaseUrl } from '../core/embedding/signature';
import { createSseParser, extractStreamContent } from './sse';

interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: string): void;
  abort(): void;
  readyState: number;
  status: number;
  responseText: string;
  timeout: number;
  onreadystatechange: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
}

type XhrConstructor = new () => XhrLike;

/**
 * RN fetch 不支持流式时的兜底：用 XMLHttpRequest 逐段读取 SSE。
 * 与 react-native-sse 同思路，但不额外引入依赖；仅在 expo/fetch 不可用时使用。
 */
export function streamChatViaXhr(
  config: LlmClientConfig,
  options: StreamOptions,
): Promise<string> {
  const Xhr = (globalThis as { XMLHttpRequest?: XhrConstructor }).XMLHttpRequest;
  if (!Xhr) {
    return Promise.reject(new LlmRequestError('当前运行环境不支持 XMLHttpRequest 流式'));
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) return Promise.reject(new LlmRequestError('LLM Base URL 不能为空'));
  if (!config.apiKey.trim()) {
    return Promise.reject(new LlmRequestError('LLM API Key 不能为空'));
  }

  return new Promise<string>((resolve, reject) => {
    const xhr = new Xhr();
    let processed = 0;
    let fullContent = '';
    let started = false;
    let settled = false;

    const parser = createSseParser((event) => {
      const content = extractStreamContent(event.data);
      if (!content) return;
      if (!started) {
        started = true;
        options.onStart?.({ model: config.model });
      }
      fullContent += content;
      options.onChunk?.(content);
    });

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const process = (): void => {
      const text = xhr.responseText ?? '';
      if (text.length > processed) {
        const chunk = text.slice(processed);
        processed = text.length;
        parser.push(chunk);
      }
    };

    const onAbort = (): void => {
      xhr.abort();
      fail(new LlmRequestError('LLM 请求已取消'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    xhr.open('POST', `${baseUrl}/chat/completions`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${config.apiKey}`);
    xhr.timeout = options.timeoutMs ?? 90000;

    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 3) process();
      if (xhr.readyState !== 4 || settled) return;

      process();
      parser.flush();
      options.signal?.removeEventListener('abort', onAbort);

      if (xhr.status >= 200 && xhr.status < 300) {
        settled = true;
        resolve(fullContent);
        return;
      }

      let detail = '';
      try {
        const body = JSON.parse(xhr.responseText) as {
          error?: { message?: string };
          message?: string;
        };
        detail = body.error?.message || body.message || '';
      } catch {
        detail = '';
      }
      fail(
        new LlmRequestError(
          `LLM 调用失败: ${xhr.status}${detail ? ` - ${detail}` : ''}`,
          {
            status: xhr.status,
            retryable: xhr.status === 429 || xhr.status >= 500,
          },
        ),
      );
    };

    xhr.onerror = () => {
      options.signal?.removeEventListener('abort', onAbort);
      fail(new LlmRequestError('LLM 网络请求失败', { retryable: true }));
    };
    xhr.ontimeout = () => {
      options.signal?.removeEventListener('abort', onAbort);
      fail(new LlmRequestError('LLM 请求超时', { retryable: true }));
    };

    if (options.signal?.aborted) {
      fail(new LlmRequestError('LLM 请求已取消'));
      return;
    }

    xhr.send(
      JSON.stringify({
        ...(options.extraBody ?? {}),
        model: config.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.4,
        max_tokens: options.maxTokens ?? 2000,
        stream: true,
      }),
    );
  });
}
