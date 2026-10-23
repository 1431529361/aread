import { describe, expect, it } from 'vitest';
import {
  EmbeddingRequestError,
  embedTexts,
  type EmbeddingClientConfig,
  type FetchLike,
} from '../src/core/embedding/client';

const config: EmbeddingClientConfig = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-test',
  model: 'bge-test',
};

function embeddingResponse(count: number, dims = 1024, status = 200): Response {
  return new Response(
    JSON.stringify({
      data: Array.from({ length: count }, () => ({ embedding: new Array(dims).fill(0.01) })),
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function errorResponse(status: number, message = 'failed'): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('embedTexts', () => {
  it('请求自定义端点，默认不发送 dimensions', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};

    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = init?.headers as Record<string, string>;
      return embeddingResponse(1);
    };

    const vectors = await embedTexts(config, ['你好'], {
      fetchImpl,
      sleep: async () => {},
    });

    expect(capturedUrl).toBe('https://api.example.com/v1/embeddings');
    expect(capturedBody).toEqual({ model: 'bge-test', input: ['你好'] });
    expect(capturedHeaders.Authorization).toBe('Bearer sk-test');
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(1024);
  });

  it('配置 dimensions 后随请求发送', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return embeddingResponse(1);
    };

    await embedTexts({ ...config, dimensionsParam: 1024 }, ['测试'], { fetchImpl });
    expect(capturedBody.dimensions).toBe(1024);
  });

  it('429 按指数退避重试后成功', async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1 ? errorResponse(429, 'rate limited') : embeddingResponse(1);
    };

    await embedTexts(config, ['测试'], {
      fetchImpl,
      retries: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(calls).toBe(2);
    expect(delays).toEqual([1000]);
  });

  it('401 不重试直接抛错', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return errorResponse(401, 'invalid key');
    };

    await expect(
      embedTexts(config, ['测试'], { fetchImpl, retries: 3, sleep: async () => {} }),
    ).rejects.toMatchObject({ status: 401, fatal: true });
    expect(calls).toBe(1);
  });

  it('维度不符是 fatal，不重试', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return embeddingResponse(1, 2048);
    };

    await expect(
      embedTexts(config, ['测试'], { fetchImpl, retries: 3, sleep: async () => {} }),
    ).rejects.toMatchObject({ fatal: true });
    expect(calls).toBe(1);
  });

  it('返回数量不一致是 fatal', async () => {
    const fetchImpl: FetchLike = async () => embeddingResponse(2);
    await expect(embedTexts(config, ['一条'], { fetchImpl })).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });

  it('5xx 重试耗尽后抛出最后一次错误', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return errorResponse(500, 'server error');
    };

    await expect(
      embedTexts(config, ['测试'], { fetchImpl, retries: 2, sleep: async () => {} }),
    ).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(3);
  });

  it('已取消的 signal 不发起请求', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return embeddingResponse(1);
    };

    await expect(
      embedTexts(config, ['测试'], { fetchImpl, signal: controller.signal }),
    ).rejects.toThrow(/取消/);
    expect(calls).toBe(0);
  });
});
