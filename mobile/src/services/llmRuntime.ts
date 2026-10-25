import { fetch as expoFetch } from 'expo/fetch';
import {
  chat,
  stream,
  type ChatOptions,
  type ChatResponse,
  type LlmClientConfig,
  type StreamOptions,
} from '../core/llm/client';
import type { FetchLike } from '../core/http';
import type { AgentLlmAdapter } from '../core/agent/loop';
import { streamChatViaXhr } from './xhrSse';

export type StreamingMode = 'expo-fetch' | 'xhr-sse';

export const nativeFetch = expoFetch as unknown as FetchLike;

export function getStreamingMode(): StreamingMode {
  return typeof ReadableStream !== 'undefined' && typeof TextDecoder !== 'undefined'
    ? 'expo-fetch'
    : 'xhr-sse';
}

export async function chatWithNativeFetch(
  config: LlmClientConfig,
  options: ChatOptions,
): Promise<ChatResponse> {
  return chat(config, { ...options, fetchImpl: options.fetchImpl ?? nativeFetch });
}

/**
 * 流式统一入口：优先 expo/fetch（SDK 58 已内置 WinterCG fetch），
 * 只有在尚未收到任何增量且错误指向流不支持/网络层时才切 XHR SSE，避免重复输出。
 */
export async function streamWithFallback(
  config: LlmClientConfig,
  options: StreamOptions,
): Promise<string> {
  if (getStreamingMode() === 'xhr-sse') {
    return streamChatViaXhr(config, options);
  }

  let received = false;
  const onChunk = options.onChunk;
  try {
    return await stream(config, {
      ...options,
      fetchImpl: options.fetchImpl ?? nativeFetch,
      onChunk: (content) => {
        received = true;
        onChunk?.(content);
      },
    });
  } catch (error) {
    if (received || options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const shouldFallback =
      message.includes('没有可读流') ||
      message.includes('ReadableStream') ||
      message.includes('stream is not supported') ||
      message.includes('Network request failed') ||
      message.includes('网络');
    if (!shouldFallback) throw error;
    return streamChatViaXhr(config, options);
  }
}

export function createNativeLlmAdapter(): AgentLlmAdapter {
  return {
    chat: chatWithNativeFetch,
    stream: streamWithFallback,
  };
}
