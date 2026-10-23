import { describe, expect, it } from 'vitest';
import {
  runAgentLoop,
  type AgentEvent,
  type AgentLlmAdapter,
} from '../src/core/agent/loop';
import type { AgentToolContext } from '../src/core/agent/types';
import {
  LlmRequestError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LlmClientConfig,
} from '../src/core/llm/client';
import type { RetrievalHit } from '../src/core/types';

const config: LlmClientConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
};

const baseMessages: ChatMessage[] = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '自由是什么？' },
];

const context = {
  db: {} as AgentToolContext['db'],
  userId: 'local',
  bookId: 'b1',
  bookName: '测试书',
} satisfies AgentToolContext;

const hit: RetrievalHit = {
  chunkId: 1,
  bookId: 'b1',
  bookTitle: '测试书',
  chapter: '第二章',
  text: '自由是重要的价值。',
  loc: { kind: 'txt', href: null, start: 10, end: 20 },
  score: 1,
  sources: ['fts'],
};

function stop(content: string | null): ChatResponse {
  return { choices: [{ message: { content }, finish_reason: 'stop' }] };
}

function toolCall(id: string, name: string, args: string): ChatResponse {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id, type: 'function', function: { name, arguments: args } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

function makeAdapter(
  responses: Array<ChatResponse | Error>,
  streamText = '流式回答',
): { adapter: AgentLlmAdapter; chatOptions: ChatOptions[] } {
  const chatOptions: ChatOptions[] = [];
  let call = 0;
  const adapter: AgentLlmAdapter = {
    async chat(_config, options) {
      chatOptions.push(options);
      const response = responses[Math.min(call, responses.length - 1)];
      call++;
      if (response instanceof Error) throw response;
      return response;
    },
    async stream(_config, options) {
      options.onChunk?.(streamText);
      return streamText;
    },
  };
  return { adapter, chatOptions };
}

describe('runAgentLoop', () => {
  it('预检索证据注入独立 system 消息，并清理无效引用', async () => {
    const events: AgentEvent[] = [];
    const { adapter, chatOptions } = makeAdapter([stop('答案[C1]，错误[C9]')]);

    const result = await runAgentLoop({
      config,
      messages: baseMessages,
      question: '自由是什么？',
      context,
      retrieve: async () => [hit],
      llm: adapter,
      onEvent: (event) => events.push(event),
    });

    expect(result.content).toBe('答案[C1]，错误');
    expect(result.evidence).toHaveLength(1);

    const sentMessages = chatOptions[0].messages;
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages[1].role).toBe('system');
    expect(sentMessages[1].content).toContain('[C1]');
    expect(sentMessages[1].content).toContain('自由是重要的价值');

    expect(events.some((event) => event.type === 'pre_retrieval')).toBe(true);
    const citationCheck = events.find((event) => event.type === 'citation_check');
    expect(citationCheck).toMatchObject({ validIds: [1], removedIds: [9] });
  });

  it('执行工具后把合法 JSON 结果回灌给模型', async () => {
    const events: AgentEvent[] = [];
    const { adapter, chatOptions } = makeAdapter([
      toolCall('call-1', 'searchInBook', '{"query":"自由"}'),
      stop('基于证据[C1]'),
    ]);

    const result = await runAgentLoop({
      config,
      messages: baseMessages,
      question: '自由是什么？',
      context,
      retrieve: async () => [hit],
      llm: adapter,
      onEvent: (event) => events.push(event),
    });

    expect(result.content).toBe('基于证据[C1]');
    expect(events.some((event) => event.type === 'tool_call')).toBe(true);
    expect(events.some((event) => event.type === 'tool_result')).toBe(true);

    const secondMessages = chatOptions[1].messages;
    const assistant = secondMessages.find((message) => message.role === 'assistant');
    expect(assistant?.tool_calls?.[0].id).toBe('call-1');

    const toolMessage = secondMessages.find((message) => message.role === 'tool');
    const toolResult = JSON.parse(toolMessage!.content!) as { source: string };
    expect(toolResult.source).toBe('hybrid');
  });

  it('工具参数非法时把错误回传给模型', async () => {
    const { adapter, chatOptions } = makeAdapter([
      toolCall('call-bad', 'searchInBook', '{bad'),
      stop('已纠正'),
    ]);

    await runAgentLoop({
      config,
      messages: baseMessages,
      question: '自由是什么？',
      context,
      llm: adapter,
    });

    const secondMessages = chatOptions[1].messages;
    const toolMessage = secondMessages.find((message) => message.role === 'tool');
    expect(JSON.parse(toolMessage!.content!)).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('模型不支持 function calling 时降级为普通流式回答', async () => {
    const events: AgentEvent[] = [];
    const { adapter } = makeAdapter([
      new LlmRequestError('not supported', { status: 400 }),
    ], '普通回答');

    const result = await runAgentLoop({
      config,
      messages: baseMessages,
      question: '自由是什么？',
      context,
      retrieve: async () => [hit],
      llm: adapter,
      onEvent: (event) => events.push(event),
    });

    expect(result.fallback).toBe(true);
    expect(result.content).toBe('普通回答');
    expect(events.some((event) => event.type === 'fallback')).toBe(true);
    expect(events.some((event) => event.type === 'chunk')).toBe(true);
  });

  it('单工具调用超过上限后熔断', async () => {
    const events: AgentEvent[] = [];
    const { adapter } = makeAdapter([
      toolCall('call-1', 'searchInBook', '{"query":"自由"}'),
      toolCall('call-2', 'searchInBook', '{"query":"自由"}'),
      stop('结束'),
    ]);

    await runAgentLoop({
      config,
      messages: baseMessages,
      question: '自由是什么？',
      context,
      retrieve: async () => [hit],
      llm: adapter,
      maxToolCallsPerName: 1,
      onEvent: (event) => events.push(event),
    });

    const blocked = events.find(
      (event) => event.type === 'tool_result' && event.blocked,
    );
    expect(blocked).toBeTruthy();
  });

  it('预检索查询包含最近两轮用户消息', async () => {
    let capturedQuery = '';
    const messages: ChatMessage[] = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '第二问' },
    ];
    const { adapter } = makeAdapter([stop('ok')]);

    await runAgentLoop({
      config,
      messages,
      question: '第二问',
      context,
      retrieve: async (query) => {
        capturedQuery = query;
        return [];
      },
      llm: adapter,
    });

    expect(capturedQuery).toBe('第一问\n第二问');
  });

  it('配置查询改写后，预检索使用改写结果', async () => {
    let capturedQuery = '';
    const messages: ChatMessage[] = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '福贵为什么离开家乡？' },
      { role: 'assistant', content: '因为被抓壮丁。' },
      { role: 'user', content: '他后来怎么样了？' },
    ];
    const { adapter } = makeAdapter([stop('ok')]);
    const events: AgentEvent[] = [];

    await runAgentLoop({
      config,
      messages,
      question: '他后来怎么样了？',
      context,
      rewriteQuery: async () => '福贵后来怎么样了？',
      retrieve: async (query) => {
        capturedQuery = query;
        return [];
      },
      llm: adapter,
      onEvent: (event) => events.push(event),
    });

    expect(capturedQuery).toBe('福贵后来怎么样了？');
    const preRetrieval = events.find((event) => event.type === 'pre_retrieval');
    expect(preRetrieval).toMatchObject({ query: '福贵后来怎么样了？' });
  });
});
