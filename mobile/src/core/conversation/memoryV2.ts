import { cosineSimilarity } from '../rag/vector';
import { tokenize } from '../rag/tokenize';
import {
  MAX_MEMORY_PER_EXTRACT,
  normalizeMemoryContent,
} from './memory';

export { MAX_MEMORY_PER_EXTRACT } from './memory';

export type MemoryLayer = 'profile' | 'episodic' | 'procedural';
export type MemoryStatus = 'active' | 'superseded';
export type MemoryOp = 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'NOOP';

export const MEMORY_LAYERS: readonly MemoryLayer[] = [
  'profile',
  'episodic',
  'procedural',
];

export const MEMORY_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
export const MEMORY_EXTRACT_EVERY_TURNS = 6;
export const MEMORY_PROFILE_MAX_ITEMS = 8;
export const MEMORY_PROFILE_MAX_CHARS = 300;
export const MEMORY_EPISODIC_MAX_ITEMS = 4;
export const MEMORY_EPISODIC_MAX_CHARS = 200;
export const MEMORY_PROCEDURAL_MAX_ITEMS = 2;
export const MEMORY_PROCEDURAL_MAX_CHARS = 100;
export const MEMORY_EPISODIC_RELEVANCE_THRESHOLD = 0.2;

export interface MemoryRecord {
  id: number;
  userId: string;
  kind: string;
  layer: MemoryLayer;
  status: MemoryStatus;
  content: string;
  salience: number;
  sourceConv: string | null;
  sourceMessageId: number | null;
  validFrom: string | null;
  supersededBy: number | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
  embedding?: Float32Array;
}

export interface MemoryCandidate {
  layer: MemoryLayer;
  kind: string;
  content: string;
  evidence?: string;
  confidence: number;
  salience: number;
}

export interface MemoryDecision {
  candidateIndex: number;
  op: MemoryOp;
  targetId: number | null;
  content?: string;
}

export interface MemorySelection {
  profile: MemoryRecord[];
  episodic: MemoryRecord[];
  procedural: MemoryRecord[];
}

export interface ExtractionGate {
  due: boolean;
  reason: 'idle' | 'turns' | 'not_due';
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function normalizeLayerValue(value: unknown): MemoryLayer {
  return MEMORY_LAYERS.includes(value as MemoryLayer)
    ? (value as MemoryLayer)
    : 'profile';
}

function normalizeOp(value: unknown): MemoryOp | null {
  const op = typeof value === 'string' ? value.toUpperCase() : '';
  return op === 'ADD' || op === 'UPDATE' || op === 'SUPERSEDE' || op === 'NOOP'
    ? op
    : null;
}

function extractJsonArray(raw: string): unknown[] | null {
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed: unknown = JSON.parse(match ? match[0] : raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseMemoryCandidates(raw: string): MemoryCandidate[] {
  const items = extractJsonArray(raw);
  if (!items) return [];

  const candidates: MemoryCandidate[] = [];
  for (const item of items.slice(0, MAX_MEMORY_PER_EXTRACT)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.content !== 'string') continue;

    const content = record.content.trim().substring(0, 200);
    if (!content) continue;

    candidates.push({
      layer: normalizeLayerValue(record.layer),
      kind: typeof record.kind === 'string' ? record.kind : 'fact',
      content,
      evidence:
        typeof record.evidence === 'string'
          ? record.evidence.trim().substring(0, 300)
          : undefined,
      confidence: clamp01(Number(record.confidence), 0.7),
      salience: clamp01(Number(record.salience), 0.7),
    });
  }

  return candidates;
}

export function parseAdjudicationDecisions(
  raw: string,
  candidateCount: number,
): MemoryDecision[] {
  const items = extractJsonArray(raw);
  if (!items) return [];

  const decisions = new Map<number, MemoryDecision>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const candidateIndex = Number(record.candidateIndex);
    if (
      !Number.isInteger(candidateIndex) ||
      candidateIndex < 0 ||
      candidateIndex >= candidateCount ||
      decisions.has(candidateIndex)
    ) {
      continue;
    }

    const op = normalizeOp(record.op);
    if (!op) continue;

    const targetId =
      typeof record.targetId === 'number' && Number.isInteger(record.targetId)
        ? record.targetId
        : null;

    if ((op === 'UPDATE' || op === 'SUPERSEDE') && targetId == null) {
      continue;
    }

    const content =
      typeof record.content === 'string' && record.content.trim()
        ? record.content.trim().substring(0, 200)
        : undefined;

    decisions.set(candidateIndex, {
      candidateIndex,
      op,
      targetId,
      content,
    });
  }

  return [...decisions.values()].sort(
    (a, b) => a.candidateIndex - b.candidateIndex,
  );
}

/** 触发时机：空闲 5 分钟或累计 6 轮用户消息；不再每轮抽取。 */
export function shouldExtractMemories(params: {
  userTurnsSinceExtract: number;
  idleMs: number;
  idleThresholdMs?: number;
  everyTurns?: number;
}): ExtractionGate {
  const turns = Math.max(0, Math.floor(params.userTurnsSinceExtract || 0));
  const idle = Math.max(0, params.idleMs || 0);
  const idleThreshold = params.idleThresholdMs ?? MEMORY_IDLE_THRESHOLD_MS;
  const everyTurns = params.everyTurns ?? MEMORY_EXTRACT_EVERY_TURNS;

  if (turns >= everyTurns) return { due: true, reason: 'turns' };
  if (idle >= idleThreshold) return { due: true, reason: 'idle' };
  return { due: false, reason: 'not_due' };
}

/** salience × 新近度（30 天半衰） × (1 + 使用次数) */
export function evictionScore(memory: MemoryRecord, nowMs = Date.now()): number {
  const timestamp = Date.parse(
    memory.updatedAt || memory.validFrom || memory.createdAt || '',
  );
  const ageDays = Number.isFinite(timestamp)
    ? Math.max(0, (nowMs - timestamp) / 86400000)
    : 365;
  const recency = 0.5 ** (ageDays / 30);
  return (
    Math.max(0, memory.salience) * recency * (1 + Math.max(0, memory.useCount))
  );
}

export function memoryRelevance(
  memory: MemoryRecord,
  query: string,
  queryEmbedding?: Float32Array | null,
): number {
  if (!query.trim()) return 0;

  if (
    queryEmbedding &&
    memory.embedding &&
    memory.embedding.length === queryEmbedding.length
  ) {
    return Math.max(0, cosineSimilarity(queryEmbedding, memory.embedding));
  }

  const queryTokens = new Set(tokenize(query));
  const memoryTokens = tokenize(memory.content);
  let overlap = 0;
  for (const token of memoryTokens) {
    if (queryTokens.has(token)) overlap++;
  }
  return memoryTokens.length ? overlap / Math.sqrt(memoryTokens.length) : 0;
}

function takeWithinBudget(
  memories: readonly MemoryRecord[],
  maxItems: number,
  maxChars: number,
  usedKeys: Set<string>,
): MemoryRecord[] {
  const selected: MemoryRecord[] = [];
  let usedChars = 0;

  for (const memory of memories) {
    if (selected.length >= maxItems) break;
    const key = normalizeMemoryContent(memory.content);
    if (!key || usedKeys.has(key)) continue;

    const separator = selected.length > 0 ? 1 : 0;
    if (usedChars + separator + memory.content.length > maxChars) continue;

    selected.push(memory);
    usedKeys.add(key);
    usedChars += separator + memory.content.length;
  }

  return selected;
}

export interface MemorySelectionOptions {
  query?: string;
  taskType?: string | null;
  nowMs?: number;
  queryEmbedding?: Float32Array | null;
  relevanceThreshold?: number;
}

export function selectMemoriesForPrompt(
  memories: readonly MemoryRecord[],
  options: MemorySelectionOptions = {},
): MemorySelection {
  const active = memories.filter((memory) => memory.status === 'active');
  const nowMs = options.nowMs ?? Date.now();
  const usedKeys = new Set<string>();
  const query = options.query ?? '';

  const profile = takeWithinBudget(
    active
      .filter((memory) => memory.layer === 'profile')
      .sort((a, b) => evictionScore(b, nowMs) - evictionScore(a, nowMs)),
    MEMORY_PROFILE_MAX_ITEMS,
    MEMORY_PROFILE_MAX_CHARS,
    usedKeys,
  );

  const threshold =
    options.relevanceThreshold ?? MEMORY_EPISODIC_RELEVANCE_THRESHOLD;
  const episodicScored = active
    .filter((memory) => memory.layer === 'episodic')
    .map((memory) => ({
      memory,
      relevance: memoryRelevance(memory, query, options.queryEmbedding),
    }))
    .filter((entry) => entry.relevance >= threshold)
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        evictionScore(b.memory, nowMs) - evictionScore(a.memory, nowMs),
    )
    .map((entry) => entry.memory);

  const episodic = takeWithinBudget(
    episodicScored,
    MEMORY_EPISODIC_MAX_ITEMS,
    MEMORY_EPISODIC_MAX_CHARS,
    usedKeys,
  );

  const procedural = options.taskType
    ? takeWithinBudget(
        active
          .filter((memory) => memory.layer === 'procedural')
          .sort((a, b) => evictionScore(b, nowMs) - evictionScore(a, nowMs)),
        MEMORY_PROCEDURAL_MAX_ITEMS,
        MEMORY_PROCEDURAL_MAX_CHARS,
        usedKeys,
      )
    : [];

  return { profile, episodic, procedural };
}

export function memoryIds(selection: MemorySelection): number[] {
  return [
    ...selection.profile,
    ...selection.episodic,
    ...selection.procedural,
  ].map((memory) => memory.id);
}

export function formatMemoryPromptBlock(selection: MemorySelection): string {
  const sections: string[] = [];
  const append = (title: string, memories: readonly MemoryRecord[]): void => {
    if (memories.length === 0) return;
    sections.push(`${title}\n${memories.map((memory) => `- ${memory.content}`).join('\n')}`);
  };

  append('【用户画像】', selection.profile);
  append('【相关阅读经历】', selection.episodic);
  append('【任务偏好】', selection.procedural);

  if (sections.length === 0) return '';
  return `以下是与当前对话相关的长期记忆：\n\n${sections.join('\n\n')}\n\n仅在确实相关时参考这些信息，不要主动提及记忆本身。`;
}
