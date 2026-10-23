import {
  buildEvidenceBlocks,
  buildEvidenceMessage,
  evidenceIds,
  sanitizeCitations,
} from '../citation';
import type { Evidence, RetrievalHit } from '../types';
import {
  LlmRequestError,
  chat as llmChat,
  stream as llmStream,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LlmClientConfig,
  type StreamOptions,
  type ToolCall,
} from '../llm/client';
import {
  DEFAULT_TOOLS,
  executeToolByName,
  getToolByName,
  getToolSchemas,
} from './registry';
import {
  parseToolArguments,
  serializeToolResult,
} from './toolResult';
import type { AgentTool, AgentToolContext } from './types';

export interface AgentLlmAdapter {
  chat: (config: LlmClientConfig, options: ChatOptions) => Promise<ChatResponse>;
  stream: (config: LlmClientConfig, options: StreamOptions) => Promise<string>;
}

const DEFAULT_LLM: AgentLlmAdapter = { chat: llmChat, stream: llmStream };

export type AgentTrace =
  | {
      iteration: 0;
      type: 'pre_retrieval';
      evidence: Evidence[];
      query?: string;
    }
  | { iteration: number; type: 'thought'; content: string }
  | {
      iteration: number;
      type: 'tool';
      name: string;
      args: Record<string, unknown>;
      elapsed: number;
      result: unknown;
    }
  | { iteration: number; type: 'answer'; content: string };

export type AgentEvent =
  | { type: 'start'; model: string; tools: string[] }
  | { type: 'pre_retrieval'; evidence: Evidence[]; query?: string }
  | { type: 'fallback'; reason: string }
  | { type: 'thought'; content: string; iteration: number }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      args: Record<string, unknown>;
      iteration: number;
      callCount: number;
    }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      result: unknown;
      elapsed?: number;
      iteration: number;
      blocked?: boolean;
    }
  | { type: 'final_start'; iteration: number; reason?: string; fallback?: boolean }
  | { type: 'chunk'; content: string }
  | { type: 'citation_check'; validIds: number[]; removedIds: number[] }
  | {
      type: 'end';
      content: string;
      iterations: number;
      fallback?: boolean;
      maxedOut?: boolean;
    };

export interface AgentRunOptions {
  config: LlmClientConfig;
  /** 已组装好的 system + 历史 + 当前 user 消息 */
  messages: readonly ChatMessage[];
  question: string;
  context: AgentToolContext;
  tools?: readonly AgentTool[];
  /** 预检索与 searchInBook 共用的检索函数 */
  retrieve?: (query: string) => Promise<RetrievalHit[]>;
  /** 可选：用最近对话把追问改写成独立检索问题 */
  rewriteQuery?: (input: {
    question: string;
    messages: readonly ChatMessage[];
  }) => Promise<string>;
  llm?: AgentLlmAdapter;
  onEvent?: (event: AgentEvent) => void;
  maxIterations?: number;
  maxToolCallsPerName?: number;
  evidenceMaxChars?: number;
  evidenceMaxItems?: number;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  content: string;
  iterations: number;
  trace: AgentTrace[];
  evidence: Evidence[];
  fallback?: boolean;
  maxedOut?: boolean;
}

const MAX_ITERATIONS = 8;
const MAX_TOOL_CALLS_PER_NAME = 5;
const TOOL_CONCURRENCY = 3;

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

function buildRetrievalQuery(
  messages: readonly ChatMessage[],
  fallbackQuestion: string,
): string {
  const recentUserTexts = messages
    .filter((message) => message.role === 'user' && message.content)
    .slice(-2)
    .map((message) => message.content!.trim())
    .filter(Boolean);
  return recentUserTexts.length > 0 ? recentUserTexts.join('\n') : fallbackQuestion;
}

function withEvidenceMessage(
  messages: readonly ChatMessage[],
  evidenceMessage: string,
): ChatMessage[] {
  const copy = [...messages];
  if (!evidenceMessage) return copy;
  const insertAt = copy[0]?.role === 'system' ? 1 : 0;
  copy.splice(insertAt, 0, { role: 'system', content: evidenceMessage });
  return copy;
}

function fallbackReason(error: unknown, signal?: AbortSignal): string | null {
  if (signal?.aborted) return null;
  if (!(error instanceof LlmRequestError)) return null;
  if (error.status === 400 || error.status === 404) {
    return '当前模型不支持 Function Calling，切换为普通问答模式';
  }
  if (error.status === 0 && /abort/i.test(error.message)) {
    return '工具决策超时，切换为普通问答模式';
  }
  return null;
}

/**
 * ReAct Agent：
 * 预检索证据 → 工具决策/执行 → 最终流式回答 → 引用校验。
 * 工具结果按字段截断，参数解析失败时把错误回传给模型自行纠正。
 */
export async function runAgentLoop(options: AgentRunOptions): Promise<AgentRunResult> {
  const {
    config,
    messages,
    question,
    context,
    signal,
    onEvent = () => {},
  } = options;
  const tools = options.tools ?? DEFAULT_TOOLS;
  const llm = options.llm ?? DEFAULT_LLM;
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const maxToolCalls = options.maxToolCallsPerName ?? MAX_TOOL_CALLS_PER_NAME;
  const trace: AgentTrace[] = [];
  const toolContext: AgentToolContext = {
    ...context,
    retrieve: context.retrieve ?? options.retrieve,
    signal,
  };

  onEvent({ type: 'start', model: config.model, tools: tools.map((tool) => tool.name) });

  let evidence: Evidence[] = [];
  if (options.retrieve) {
    let retrievalQuery = buildRetrievalQuery(messages, question);
    if (options.rewriteQuery) {
      try {
        const rewritten = (await options.rewriteQuery({
          question,
          messages,
        })).trim();
        if (rewritten) retrievalQuery = rewritten;
      } catch {
        // 改写失败时使用原始上下文查询
      }
    }

    try {
      const hits = await options.retrieve(retrievalQuery);
      evidence = buildEvidenceBlocks(hits, {
        maxChars: options.evidenceMaxChars,
        maxItems: options.evidenceMaxItems,
      });
    } catch {
      evidence = [];
    }
    onEvent({ type: 'pre_retrieval', evidence, query: retrievalQuery });
    trace.push({
      iteration: 0,
      type: 'pre_retrieval',
      evidence,
      query: retrievalQuery,
    });
  }

  const validIds = evidenceIds(evidence);
  const baseMessages = withEvidenceMessage(
    messages,
    buildEvidenceMessage(evidence),
  );
  const working: ChatMessage[] = [...baseMessages];
  const toolCallCounts = new Map<string, number>();

  const finish = (
    rawContent: string,
    iterations: number,
    extras: { fallback?: boolean; maxedOut?: boolean } = {},
  ): AgentRunResult => {
    const sanitized = sanitizeCitations(rawContent, validIds);
    onEvent({
      type: 'citation_check',
      validIds,
      removedIds: sanitized.removedIds,
    });
    onEvent({
      type: 'end',
      content: sanitized.answer,
      iterations,
      fallback: extras.fallback,
      maxedOut: extras.maxedOut,
    });
    return {
      content: sanitized.answer,
      iterations,
      trace,
      evidence,
      fallback: extras.fallback,
      maxedOut: extras.maxedOut,
    };
  };

  const streamFinal = async (
    messagesForFinal: readonly ChatMessage[],
    iteration: number,
    extras: { fallback?: boolean; maxedOut?: boolean; reason?: string } = {},
  ): Promise<AgentRunResult> => {
    onEvent({
      type: 'final_start',
      iteration,
      reason: extras.reason,
      fallback: extras.fallback,
    });
    const content = await llm.stream(config, {
      messages: messagesForFinal,
      temperature: 0.4,
      maxTokens: 2000,
      timeoutMs: 90000,
      signal,
      onChunk: (chunk) => onEvent({ type: 'chunk', content: chunk }),
    });
    return finish(content, iteration, extras);
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let response: ChatResponse;
    try {
      response = await llm.chat(config, {
        messages: working,
        tools: getToolSchemas(tools),
        toolChoice: 'auto',
        temperature: 0.3,
        maxTokens: 1500,
        timeoutMs: 90000,
        retries: 1,
        signal,
      });
    } catch (error) {
      const reason = fallbackReason(error, signal);
      if (!reason) throw error;
      onEvent({ type: 'fallback', reason });
      return streamFinal(baseMessages, iteration, { fallback: true });
    }

    const choice = response.choices[0];
    if (!choice) throw new Error('LLM 返回为空');
    const message = choice.message;
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0 || choice.finish_reason === 'stop') {
      if (message.content && message.content.trim()) {
        onEvent({ type: 'final_start', iteration });
        const sanitized = sanitizeCitations(message.content, validIds);
        onEvent({
          type: 'citation_check',
          validIds,
          removedIds: sanitized.removedIds,
        });
        trace.push({ iteration, type: 'answer', content: sanitized.answer });
        onEvent({ type: 'chunk', content: sanitized.answer });
        onEvent({ type: 'end', content: sanitized.answer, iterations: iteration });
        return {
          content: sanitized.answer,
          iterations: iteration,
          trace,
          evidence,
        };
      }
      return streamFinal(working, iteration);
    }

    if (message.content && message.content.trim()) {
      trace.push({ iteration, type: 'thought', content: message.content });
      onEvent({ type: 'thought', content: message.content, iteration });
    }

    working.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    interface ToolCallPlan {
      toolCall: ToolCall;
      name: string;
      callCount: number;
      blocked: boolean;
      args?: Record<string, unknown>;
      argumentError?: string;
    }

    const plans: ToolCallPlan[] = toolCalls.map((toolCall) => {
      const name = toolCall.function.name;
      const callCount = (toolCallCounts.get(name) ?? 0) + 1;
      toolCallCounts.set(name, callCount);

      if (callCount > maxToolCalls) {
        return { toolCall, name, callCount, blocked: true };
      }

      const parsed = parseToolArguments(toolCall.function.arguments);
      if (!parsed.ok) {
        return {
          toolCall,
          name,
          callCount,
          blocked: false,
          argumentError: parsed.detail,
        };
      }

      onEvent({
        type: 'tool_call',
        id: toolCall.id,
        name,
        args: parsed.args,
        iteration,
        callCount,
      });
      return {
        toolCall,
        name,
        callCount,
        blocked: false,
        args: parsed.args,
      };
    });

    const executable = plans.filter(
      (plan) => !plan.blocked && !plan.argumentError && plan.args,
    );

    const executionResults = await runWithConcurrency(
      executable,
      TOOL_CONCURRENCY,
      async (plan) => {
        if (signal?.aborted) throw new Error('Agent 已取消');
        const startedAt = Date.now();
        let result: unknown;
        try {
          result = await executeToolByName(
            tools,
            plan.name,
            plan.args!,
            toolContext,
          );
        } catch (error) {
          result = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return { result, elapsed: Date.now() - startedAt };
      },
    );

    const executionByPlan = new Map(
      executable.map((plan, index) => [plan, executionResults[index]] as const),
    );

    for (const plan of plans) {
      let result: unknown;
      let elapsed: number | undefined;

      if (plan.blocked) {
        result = {
          error: `工具 ${plan.name} 调用次数超过 ${maxToolCalls} 次，已熔断`,
        };
      } else if (plan.argumentError) {
        result = { error: 'invalid_arguments', detail: plan.argumentError };
      } else {
        const execution = executionByPlan.get(plan);
        result = execution?.result;
        elapsed = execution?.elapsed;
      }

      if (!plan.blocked && !plan.argumentError && plan.args) {
        trace.push({
          iteration,
          type: 'tool',
          name: plan.name,
          args: plan.args,
          elapsed: elapsed ?? 0,
          result,
        });
      }

      onEvent({
        type: 'tool_result',
        id: plan.toolCall.id,
        name: plan.name,
        result,
        elapsed,
        iteration,
        blocked: plan.blocked || undefined,
      });

      const tool = getToolByName(tools, plan.name);
      working.push({
        role: 'tool',
        tool_call_id: plan.toolCall.id,
        content: serializeToolResult(result, tool?.resultLimits),
      });
    }
  }

  return streamFinal(working, maxIterations, {
    maxedOut: true,
    reason: 'max_iterations',
  });
}
