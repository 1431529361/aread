import { describe, expect, it } from 'vitest';
import {
  LlmRequestError,
  chat,
  complete,
  stream,
  type ChatMessage,
  type FetchLike,
  type LlmClientConfig,
} from '../src/core/llm/client';

const config: LlmClientConfig = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-llm',
  model: 'test-model',
};

const messages: ChatMessage[] = [{ role: 'user', content: '你好' }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('llm chat', () => {
  it('调用 chat/completions 并返回内容', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        choices: [{ message: { content: '回答' }, finish_reason: 'stop' }],
      });
    };

    const response = await chat(config, { messages, fetchImpl });
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(body).toMatchObject({
      model: 'test-model',
      messages,
      temperature: 0.3,
      max_tokens: 1500,
    });
    expect(response.choices[0].message.content).toBe('回答');
  });

  it('透传供应商特有 extraBody 参数', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    };

    await chat(config, {
      messages,
      fetchImpl,
      extraBody: { enable_thinking: false },
    });

    expect(body.enable_thinking).toBe(false);
    expect(body.model).toBe('test-model');
  });

  it('带工具时发送 tools 与 tool_choice', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    };

    await chat(config, {
      messages,
      fetchImpl,
      tools: [
        {
          type: 'function',
          function: { name: 'searchInBook', description: '检索', parameters: {} },
        },
      ],
    });

    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
  });

  it('500 指数退避后重试成功', async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ error: { message: 'server' } }, 500)
        : jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    };

    await chat(config, {
      messages,
      fetchImpl,
      retries: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(calls).toBe(2);
    expect(delays).toEqual([1000]);
  });

  it('401 不重试', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return jsonResponse({ error: { message: 'invalid key' } }, 401);
    };

    await expect(
      chat(config, { messages, fetchImpl, retries: 3, sleep: async () => {} }),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('complete 返回 trim 后的文本', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ choices: [{ message: { content: '  答案  ' } }] });

    await expect(
      complete(config, '问题', { fetchImpl }),
    ).resolves.toBe('答案');
  });
});

describe('llm stream', () => {
  it('拼接 SSE 增量，支持跨 chunk 的半行', async () => {
    const parts = [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"！"}}]}\n',
      'data: [DONE]\n',
    ];
    const fetchImpl: FetchLike = async () => sseResponse(parts);
    const chunks: string[] = [];
    let startedModel = '';

    const content = await stream(config, {
      messages,
      fetchImpl,
      onStart: (info) => {
        startedModel = info.model;
      },
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(content).toBe('你好！');
    expect(chunks).toEqual(['你', '好', '！']);
    expect(startedModel).toBe('test-model');
  });

  it('非 2xx 抛带 status 的错误', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: { message: 'unauthorized' } }, 401);

    await expect(stream(config, { messages, fetchImpl })).rejects.toBeInstanceOf(
      LlmRequestError,
    );
  });
});
