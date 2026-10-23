import type { DbAdapter } from '../db/adapter';
import {
  buildMemoryAdjudicationPrompt,
  buildMemoryCandidatesPrompt,
} from '../core/llm/prompts/memory-v2';
import {
  formatMemoryPromptBlock,
  memoryIds,
  parseAdjudicationDecisions,
  parseMemoryCandidates,
  selectMemoriesForPrompt,
  shouldExtractMemories,
  type MemoryCandidate,
  type MemoryRecord,
  type MemorySelection,
} from '../core/conversation/memoryV2';
import {
  consolidateMemories as consolidateMemoryRecords,
  evictMemories,
  insertMemory,
  listMemories,
  markMemorySuperseded,
  recallSimilarMemories,
  recordMemoryUsage,
  updateMemory,
  type SimilarMemory,
} from '../db/repositories/memories';

export interface MemoryLlmClient {
  complete(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string>;
}

export interface MemoryEmbeddingClient {
  embedTexts(texts: readonly string[]): Promise<number[][]>;
}

export interface MemoryServiceOptions {
  db: DbAdapter;
  userId: string;
  llm: MemoryLlmClient;
  embedder?: MemoryEmbeddingClient | null;
  now?: () => string;
}

export interface MemoryMessage {
  role: string;
  content: string | null;
}

export interface MemoryExtractionParams {
  conversationId: string;
  messages: readonly MemoryMessage[];
  sourceMessageId?: number | null;
}

export interface MemoryExtractionResult {
  skipped?: boolean;
  reason?: string;
  extracted: number;
  added: number;
  updated: number;
  superseded: number;
  noop: number;
  error?: string;
}

const EMPTY_RESULT: MemoryExtractionResult = {
  extracted: 0,
  added: 0,
  updated: 0,
  superseded: 0,
  noop: 0,
};

function nowIso(): string {
  return new Date().toISOString();
}

function buildConversationText(messages: readonly MemoryMessage[]): string {
  return messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        message.content &&
        message.content.trim(),
    )
    .map(
      (message) =>
        `${message.role === 'user' ? '用户' : '助手'}：${message.content!
          .trim()
          .substring(0, 1200)}`,
    )
    .join('\n');
}

async function embedOne(
  embedder: MemoryEmbeddingClient | null | undefined,
  text: string,
): Promise<Float32Array | null> {
  if (!embedder) return null;
  try {
    const vectors = await embedder.embedTexts([text]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) return null;
    return Float32Array.from(vector);
  } catch {
    return null;
  }
}

/**
 * 记忆写入管线：抽取候选 → 召回相似记忆 → LLM 判定 ADD/UPDATE/SUPERSEDE/NOOP → 事务落库。
 * 失败返回 error，不向对话主流程抛错。
 */
export async function extractAndMergeMemories(
  options: MemoryServiceOptions,
  params: MemoryExtractionParams,
): Promise<MemoryExtractionResult> {
  const conversationText = buildConversationText(params.messages);
  if (!conversationText) return { ...EMPTY_RESULT };

  let rawCandidates: string;
  try {
    rawCandidates = await options.llm.complete(
      buildMemoryCandidatesPrompt(conversationText),
      { maxTokens: 800, temperature: 0.2 },
    );
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const candidates = parseMemoryCandidates(rawCandidates);
  if (candidates.length === 0) return { ...EMPTY_RESULT };

  const prepared: Array<{
    candidate: MemoryCandidate;
    embedding: Float32Array | null;
    neighbors: SimilarMemory[];
  }> = [];

  for (const candidate of candidates) {
    const embedding = await embedOne(options.embedder, candidate.content);
    let neighbors: SimilarMemory[] = [];
    try {
      neighbors = await recallSimilarMemories(options.db, {
        userId: options.userId,
        content: candidate.content,
        queryEmbedding: embedding,
        limit: 5,
      });
    } catch {
      neighbors = [];
    }
    prepared.push({ candidate, embedding, neighbors });
  }

  let rawDecisions: string;
  try {
    rawDecisions = await options.llm.complete(
      buildMemoryAdjudicationPrompt({
        candidates,
        similar: prepared.map((entry) =>
          entry.neighbors.map((neighbor) => ({
            id: neighbor.memory.id,
            content: neighbor.memory.content,
            layer: neighbor.memory.layer,
            status: neighbor.memory.status,
          })),
        ),
      }),
      { maxTokens: 800, temperature: 0.1 },
    );
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      extracted: candidates.length,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const decisions = parseAdjudicationDecisions(rawDecisions, candidates.length);
  if (decisions.length === 0) {
    return {
      ...EMPTY_RESULT,
      extracted: candidates.length,
      error: 'adjudication_parse_failed',
    };
  }

  const decisionByIndex = new Map(
    decisions.map((decision) => [decision.candidateIndex, decision]),
  );
  const now = options.now?.() ?? nowIso();

  let added = 0;
  let updated = 0;
  let superseded = 0;
  let noop = 0;

  try {
    await options.db.transaction(async (tx) => {
      for (let index = 0; index < prepared.length; index++) {
        const { candidate, embedding, neighbors } = prepared[index];
        const decision = decisionByIndex.get(index);

        if (!decision || decision.op === 'NOOP') {
          noop++;
          continue;
        }

        if (decision.op === 'ADD') {
          await insertMemory(tx, options.userId, {
            kind: candidate.kind,
            layer: candidate.layer,
            content: candidate.content,
            salience: candidate.salience,
            sourceConv: params.conversationId,
            sourceMessageId: params.sourceMessageId ?? null,
            validFrom: now,
            embedding,
            now,
          });
          added++;
          continue;
        }

        const target = neighbors.find(
          (neighbor) => neighbor.memory.id === decision.targetId,
        );
        if (!target) {
          noop++;
          continue;
        }

        const content = decision.content ?? candidate.content;
        if (decision.op === 'UPDATE') {
          await updateMemory(tx, options.userId, target.memory.id, {
            content,
            kind: candidate.kind,
            layer: candidate.layer,
            salience: candidate.salience,
            validFrom: now,
            embedding,
            now,
          });
          updated++;
        } else {
          const newId = await insertMemory(tx, options.userId, {
            kind: candidate.kind,
            layer: candidate.layer,
            content,
            salience: candidate.salience,
            sourceConv: params.conversationId,
            sourceMessageId: params.sourceMessageId ?? null,
            validFrom: now,
            embedding,
            now,
          });
          if (newId === target.memory.id) {
            noop++;
          } else {
            await markMemorySuperseded(tx, {
              userId: options.userId,
              id: target.memory.id,
              supersededBy: newId,
              now,
            });
            superseded++;
          }
        }
      }
    });
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      extracted: candidates.length,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await evictMemories(options.db, { userId: options.userId, now });
  } catch {
    // 淘汰失败不影响本次写入结果
  }

  return {
    extracted: candidates.length,
    added,
    updated,
    superseded,
    noop,
  };
}

/** 只有满足空闲/轮次门槛才抽取，避免每轮调用模型。 */
export async function maybeExtractAndMergeMemories(
  options: MemoryServiceOptions,
  params: MemoryExtractionParams & {
    userTurnsSinceExtract: number;
    idleMs: number;
  },
): Promise<MemoryExtractionResult> {
  const gate = shouldExtractMemories({
    userTurnsSinceExtract: params.userTurnsSinceExtract,
    idleMs: params.idleMs,
  });
  if (!gate.due) {
    return { ...EMPTY_RESULT, skipped: true, reason: gate.reason };
  }
  return extractAndMergeMemories(options, params);
}

export interface MemoryInjection {
  text: string;
  selection: MemorySelection;
  ids: number[];
}

/** 读取管线：profile 常驻、episodic 相关性门控、procedural 仅任务模式。 */
export async function buildMemoryInjection(
  options: MemoryServiceOptions,
  params: { query: string; taskType?: string | null },
): Promise<MemoryInjection> {
  const memories = await listMemories(options.db, options.userId);
  if (memories.length === 0) {
    return {
      text: '',
      selection: { profile: [], episodic: [], procedural: [] },
      ids: [],
    };
  }

  const queryEmbedding = params.query
    ? await embedOne(options.embedder, params.query)
    : null;
  const selection = selectMemoriesForPrompt(memories, {
    query: params.query,
    taskType: params.taskType ?? null,
    queryEmbedding,
  });
  const ids = memoryIds(selection);
  const text = formatMemoryPromptBlock(selection);

  if (ids.length > 0) {
    try {
      await recordMemoryUsage(options.db, { userId: options.userId, ids });
    } catch {
      // 使用统计失败不影响回答
    }
  }

  return { text, selection, ids };
}

export async function consolidateMemoryStore(
  options: MemoryServiceOptions,
): Promise<{ merged: number; evicted: number }> {
  const now = options.now?.() ?? nowIso();
  const result = await consolidateMemoryRecords(options.db, {
    userId: options.userId,
    now,
  });
  let evicted = 0;
  try {
    evicted = (await evictMemories(options.db, {
      userId: options.userId,
      now,
    })).length;
  } catch {
    evicted = 0;
  }
  return { merged: result.merged, evicted };
}

export type { MemoryRecord };
