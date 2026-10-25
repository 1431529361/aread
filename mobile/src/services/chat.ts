import type { DbAdapter } from '../db/adapter';
import { LOCAL_USER_ID } from '../db/schema';
import type { BookRecord } from '../db/repositories/books';
import {
  appendMessage,
  getConversation,
  listMessages,
  type MessageRecord,
} from '../db/repositories/conversations';
import { runAgentLoop, type AgentEvent } from '../core/agent/loop';
import { buildAgentSystemPrompt, buildAgentUserMessage } from '../core/llm/prompts/agent';
import { selectHistoryMessages } from '../core/conversation/history';
import type { ChatMessage } from '../core/llm/client';
import type { Evidence, RetrievalHit } from '../core/types';
import { loadBookContentById } from './bookContent';
import { retrieveInBook } from './retrieval';
import { createNativeLlmAdapter, nativeFetch } from './llmRuntime';
import { loadChatRuntime, loadEmbeddingRuntime } from './providerRuntime';
import { buildReranker } from './providerSettings';
import { embedTexts } from '../core/embedding/client';

export class ChatNotConfiguredError extends Error {
  constructor() {
    super('尚未配置对话模型，请先在设置中填写 Base URL、API Key 与模型');
    this.name = 'ChatNotConfiguredError';
  }
}

export interface SendBookChatParams {
  db: DbAdapter;
  userId?: string;
  conversationId: string;
  bookId: string;
  question: string;
  selectedText?: string | null;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface SendBookChatResult {
  userMessage: MessageRecord;
  assistantMessage: MessageRecord;
  evidence: Evidence[];
}

function composeUserContent(question: string, selectedText?: string | null): string {
  const trimmed = question.trim();
  if (!selectedText?.trim()) return trimmed;
  return `选中的文本：\n"${selectedText.trim()}"\n\n问题：${trimmed}`;
}

async function buildRetriever(params: {
  db: DbAdapter;
  book: BookRecord;
}): Promise<(query: string) => Promise<RetrievalHit[]>> {
  const { db, book } = params;
  const embedding = await loadEmbeddingRuntime(db);
  const canUseVectors =
    embedding != null &&
    book.indexStatus === 'ready' &&
    !!book.embedSig &&
    (book.embedDims ?? 1024) === 1024;

  const reranker =
    canUseVectors && embedding
      ? buildReranker(embedding.record, embedding.apiKey, { fetchImpl: nativeFetch })
      : null;

  return async (query: string) => {
    if (!query.trim()) return [];
    return retrieveInBook(book.id, {
      db,
      query,
      topK: 5,
      recallN: 20,
      expandParents: true,
      embedQuery: canUseVectors && embedding
        ? async (text) => {
            const vectors = await embedTexts(embedding.config, [text], {
              fetchImpl: nativeFetch,
              retries: 1,
              timeoutMs: 15000,
            });
            return vectors[0] ?? [];
          }
        : null,
      activeSig: canUseVectors ? book.embedSig : null,
      dims: book.embedDims ?? 1024,
      rerank: reranker,
    });
  };
}

/**
 * M0-B 对话主流程：持久化用户消息 → 预检索 + Agent 工具循环 → 流式输出
 * → 校验引用 → 保存助手消息与引用快照。离线/未配置 Key 时抛出明确错误。
 */
export async function sendBookChat(params: SendBookChatParams): Promise<SendBookChatResult> {
  const { db, conversationId, bookId, signal } = params;
  const userId = params.userId ?? LOCAL_USER_ID;
  const question = params.question.trim();
  if (!question) throw new Error('问题不能为空');

  const conversation = await getConversation(db, { userId, conversationId });
  if (!conversation) throw new Error('会话不存在');
  if (conversation.bookId !== bookId) throw new Error('会话与书籍不匹配');

  const runtime = await loadChatRuntime(db);
  if (!runtime) throw new ChatNotConfiguredError();

  const { book, text } = await loadBookContentById(db, { userId, bookId });
  const priorMessages = await listMessages(db, conversationId);
  const userContent = composeUserContent(question, params.selectedText);

  const userMessage = await appendMessage(db, {
    conversationId,
    role: 'user',
    content: userContent,
  });

  const history = selectHistoryMessages(priorMessages, {
    maxMessages: 20,
    maxChars: Math.min(60000, Math.max(6000, Math.floor(runtime.contextWindow * 0.3))),
  });

  let system = buildAgentSystemPrompt({ model: runtime.record.model, bookName: book.title });
  if (conversation.summary.trim()) {
    system += `\n\n【当前会话的历史摘要】\n${conversation.summary.trim()}`;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    {
      role: 'user',
      content: buildAgentUserMessage({
        selectedText: params.selectedText,
        question,
        bookName: book.title,
      }),
    },
  ];

  const retrieve = await buildRetriever({ db, book });

  const result = await runAgentLoop({
    config: runtime.config,
    messages,
    question,
    context: {
      db,
      userId,
      bookId,
      bookName: book.title,
      // EPUB 的 offset 分属各 spine 文档，暂不注入全文；检索与引用仍走带 href 的 locator
      content: text ?? undefined,
      retrieve,
    },
    retrieve,
    llm: createNativeLlmAdapter(),
    onEvent: params.onEvent,
    signal,
  });

  const assistantMessage = await appendMessage(db, {
    conversationId,
    role: 'assistant',
    content: result.content,
    citations: result.evidence.length > 0 ? result.evidence : null,
  });

  return { userMessage, assistantMessage, evidence: result.evidence };
}
