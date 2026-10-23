import { tokenize } from '../rag/tokenize';

export const MAX_MEMORIES_PER_USER = 200;
export const MAX_MEMORY_PER_EXTRACT = 5;
export const MAX_INJECTED_MEMORIES = 8;
export const MAX_INJECTED_MEMORY_CHARS = 500;

export type MemoryKind = 'preference' | 'fact' | 'interest';

export interface MemoryItem {
  id?: number;
  kind: string;
  content: string;
  salience?: number;
  updated_at?: string;
}

/** 记忆去重前的归一化：忽略大小写、空白与标点符号。 */
export function normalizeMemoryContent(content: string): string {
  return content.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function isBetterMemory<T extends MemoryItem>(candidate: T, current: T): boolean {
  const candidateSalience = candidate.salience ?? 1;
  const currentSalience = current.salience ?? 1;
  if (candidateSalience !== currentSalience) return candidateSalience > currentSalience;
  if (candidate.updated_at && current.updated_at) {
    return candidate.updated_at > current.updated_at;
  }
  return false;
}

/** 按归一化内容去重，保留 salience 更高（相同时取更新）的一条。 */
export function dedupeMemories<T extends MemoryItem>(memories: readonly T[]): T[] {
  const best = new Map<string, T>();

  for (const memory of memories) {
    const key = normalizeMemoryContent(memory.content);
    if (!key) continue;
    const current = best.get(key);
    if (!current || isBetterMemory(memory, current)) best.set(key, memory);
  }

  return [...best.values()].sort((a, b) => (b.salience ?? 1) - (a.salience ?? 1));
}

/**
 * 挑选注入 system prompt 的记忆：去重后按 salience 排序，
 * 最多 8 条、总正文不超过 500 字；最后一条超长时截断。
 */
export function selectMemoriesForInjection<T extends MemoryItem>(
  memories: readonly T[],
  options: { maxItems?: number; maxChars?: number } = {},
): T[] {
  const maxItems = options.maxItems ?? MAX_INJECTED_MEMORIES;
  const maxChars = options.maxChars ?? MAX_INJECTED_MEMORY_CHARS;
  const selected: T[] = [];
  let usedChars = 0;

  for (const memory of dedupeMemories(memories)) {
    if (selected.length >= maxItems) break;

    const content = memory.content.trim();
    if (!content) continue;

    const separator = selected.length > 0 ? 1 : 0;
    const remaining = maxChars - usedChars - separator;
    if (remaining <= 0) break;

    if (content.length <= remaining) {
      selected.push({ ...memory, content });
      usedChars += content.length + separator;
      continue;
    }

    if (remaining >= 10) {
      selected.push({ ...memory, content: content.slice(0, remaining) });
      usedChars += remaining + separator;
    }
    break;
  }

  return selected;
}

export function formatMemoriesBlock(memories: readonly MemoryItem[]): string {
  return memories.map((memory) => `- ${memory.content.trim()}`).join('\n');
}

/** 与 Web 版一致：salience 0.4 权重 + 关键词重叠 + preference 恒定加权。 */
export function retrieveMemories<T extends MemoryItem>(
  memories: readonly T[],
  query: string,
  k = 6,
): T[] {
  if (memories.length === 0) return [];

  const queryTokens = new Set(tokenize(query));
  const scored = memories.map((memory) => {
    const memoryTokens = tokenize(memory.content);
    let overlap = 0;
    for (const token of memoryTokens) {
      if (queryTokens.has(token)) overlap++;
    }
    const relevance = memoryTokens.length ? overlap / Math.sqrt(memoryTokens.length) : 0;
    const kindBoost = memory.kind === 'preference' ? 0.5 : 0;
    return { memory, score: (memory.salience ?? 1) * 0.4 + relevance + kindBoost };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((entry) => entry.memory);
}

export interface ExtractedMemory {
  kind: string;
  content: string;
  salience: number;
}

/** 解析记忆抽取模型的输出（容忍 ```json 包裹或前后说明文字）。 */
export function parseMemoryExtractionResult(raw: string): ExtractedMemory[] {
  let parsed: unknown;
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items: ExtractedMemory[] = [];
  for (const item of parsed.slice(0, MAX_MEMORY_PER_EXTRACT)) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<ExtractedMemory>;
    if (typeof candidate.content !== 'string') continue;
    const content = candidate.content.trim().substring(0, 200);
    if (!content) continue;
    const salience =
      typeof candidate.salience === 'number'
        ? Math.max(0.1, Math.min(1, candidate.salience))
        : 0.8;
    items.push({
      kind: typeof candidate.kind === 'string' ? candidate.kind : 'fact',
      content,
      salience,
    });
  }
  return items;
}
