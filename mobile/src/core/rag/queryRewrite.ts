import { buildQueryRewritePrompt } from '../llm/prompts/retrieval';

export const QUERY_REWRITE_MAX_ROUNDS = 3;
export const QUERY_REWRITE_MAX_CHARS = 200;

export interface QueryRewriteMessage {
  role: string;
  content: string | null;
}

export interface QueryRewriteLlm {
  complete(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string>;
}

export interface RewriteQueryParams {
  llm: QueryRewriteLlm;
  question: string;
  messages: readonly QueryRewriteMessage[];
  maxRounds?: number;
}

export interface RewriteQueryResult {
  query: string;
  rewritten: boolean;
  reason: 'rewritten' | 'unchanged' | 'no_history' | 'empty_question';
  error?: string;
}

function withoutCurrentQuestion(
  messages: readonly QueryRewriteMessage[],
  question: string,
): QueryRewriteMessage[] {
  const filtered = messages.filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      message.content &&
      message.content.trim(),
  );
  const last = filtered[filtered.length - 1];
  if (
    last?.role === 'user' &&
    last.content &&
    last.content.trim() === question
  ) {
    return filtered.slice(0, -1);
  }
  return filtered;
}

/** 取最近 N 轮 user/assistant 消息，供改写 prompt 使用。 */
export function buildRewriteHistory(
  messages: readonly QueryRewriteMessage[],
  maxRounds = QUERY_REWRITE_MAX_ROUNDS,
): string {
  const recent = messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        message.content &&
        message.content.trim(),
    )
    .slice(-maxRounds * 2);

  return recent
    .map(
      (message) =>
        `${message.role === 'user' ? '用户' : '助手'}：${message.content!
          .trim()
          .substring(0, 500)}`,
    )
    .join('\n');
}

export function normalizeRewrittenQuery(
  raw: string,
  fallback: string,
): string {
  const firstLine = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;

  const cleaned = firstLine
    .replace(/^(改写后|改写|独立问题|检索问题|问题)\s*[:：]\s*/, '')
    .replace(/^["“「『']+|["”」』']+$/g, '')
    .trim()
    .substring(0, QUERY_REWRITE_MAX_CHARS);

  return cleaned || fallback;
}

/**
 * 用最近 3 轮对话把追问改写成独立检索问题。
 * 无历史、空问题或模型失败时回退原问题，不阻塞检索。
 */
export async function rewriteQuery(
  params: RewriteQueryParams,
): Promise<RewriteQueryResult> {
  const question = params.question.trim();
  if (!question) return { query: '', rewritten: false, reason: 'empty_question' };

  const history = buildRewriteHistory(
    withoutCurrentQuestion(params.messages, question),
    params.maxRounds,
  );
  if (!history.trim()) {
    return { query: question, rewritten: false, reason: 'no_history' };
  }

  try {
    const raw = await params.llm.complete(
      buildQueryRewritePrompt({ history, question }),
      { maxTokens: 120, temperature: 0.1 },
    );
    const query = normalizeRewrittenQuery(raw, question);
    return {
      query,
      rewritten: query !== question,
      reason: query === question ? 'unchanged' : 'rewritten',
    };
  } catch (error) {
    return {
      query: question,
      rewritten: false,
      reason: 'unchanged',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
