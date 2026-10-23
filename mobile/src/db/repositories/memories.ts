import type { DbAdapter, DbExecutor } from '../adapter';
import { asUint8Array } from '../binary';
import {
  normalizeVector,
  vectorToBytes,
  bytesToVector,
} from '../../core/rag/vector';
import {
  evictionScore,
  memoryRelevance,
  normalizeLayerValue,
  type MemoryLayer,
  type MemoryRecord,
  type MemoryStatus,
} from '../../core/conversation/memoryV2';
import { normalizeMemoryContent } from '../../core/conversation/memory';

const MEMORY_COLUMNS = `id, user_id, kind, layer, status, content, salience,
  source_conv, source_message_id, valid_from, superseded_by,
  last_used_at, use_count, embedding, created_at, updated_at`;

interface MemoryRow {
  id: number;
  user_id: string;
  kind: string;
  layer: string | null;
  status: string | null;
  content: string;
  salience: number | null;
  source_conv: string | null;
  source_message_id: number | null;
  valid_from: string | null;
  superseded_by: number | null;
  last_used_at: string | null;
  use_count: number | null;
  embedding: unknown;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: Number(row.id),
    userId: row.user_id,
    kind: row.kind,
    layer: normalizeLayerValue(row.layer),
    status: row.status === 'superseded' ? 'superseded' : 'active',
    content: row.content,
    salience: Number(row.salience ?? 1),
    sourceConv: row.source_conv,
    sourceMessageId:
      row.source_message_id == null ? null : Number(row.source_message_id),
    validFrom: row.valid_from,
    supersededBy:
      row.superseded_by == null ? null : Number(row.superseded_by),
    lastUsedAt: row.last_used_at,
    useCount: Number(row.use_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    embedding: row.embedding ? bytesToVector(asUint8Array(row.embedding)) : undefined,
  };
}

export async function listMemories(
  db: DbExecutor,
  userId: string,
  options: { includeSuperseded?: boolean } = {},
): Promise<MemoryRecord[]> {
  const rows = await db.queryAll<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS}
     FROM user_memories
     WHERE user_id = ?${options.includeSuperseded ? '' : " AND status = 'active'"}
     ORDER BY salience DESC, updated_at DESC`,
    [userId],
  );
  return rows.map(mapMemory);
}

export async function getMemoryById(
  db: DbExecutor,
  userId: string,
  id: number,
): Promise<MemoryRecord | null> {
  const row = await db.queryOne<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM user_memories WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  return row ? mapMemory(row) : null;
}

export interface MemoryInsert {
  kind: string;
  layer: MemoryLayer;
  content: string;
  salience: number;
  sourceConv?: string | null;
  sourceMessageId?: number | null;
  validFrom?: string | null;
  embedding?: ArrayLike<number> | null;
  now?: string;
}

export async function insertMemory(
  db: DbExecutor,
  userId: string,
  memory: MemoryInsert,
): Promise<number> {
  const now = memory.now ?? nowIso();
  const embedding = memory.embedding
    ? vectorToBytes(normalizeVector(memory.embedding))
    : null;

  await db.execute(
    `INSERT INTO user_memories
      (user_id, kind, content, salience, source_conv, embedding,
       layer, status, source_message_id, valid_from, last_used_at, use_count,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, 0, ?, ?)
     ON CONFLICT(user_id, content) DO UPDATE SET
       kind = excluded.kind,
       layer = excluded.layer,
       status = 'active',
       superseded_by = NULL,
       salience = MAX(user_memories.salience, excluded.salience),
       embedding = COALESCE(excluded.embedding, user_memories.embedding),
       source_message_id = excluded.source_message_id,
       valid_from = COALESCE(excluded.valid_from, user_memories.valid_from),
       updated_at = excluded.updated_at`,
    [
      userId,
      memory.kind,
      memory.content,
      memory.salience,
      memory.sourceConv ?? null,
      embedding,
      memory.layer,
      memory.sourceMessageId ?? null,
      memory.validFrom ?? now,
      now,
      now,
    ],
  );

  const row = await db.queryOne<{ id: number }>(
    'SELECT id FROM user_memories WHERE user_id = ? AND content = ?',
    [userId, memory.content],
  );
  if (!row) throw new Error('写入记忆后未找到记录');
  return Number(row.id);
}

export interface MemoryUpdate {
  content?: string;
  kind?: string;
  layer?: MemoryLayer;
  salience?: number;
  validFrom?: string | null;
  embedding?: ArrayLike<number> | null;
  now?: string;
}

export async function updateMemory(
  db: DbExecutor,
  userId: string,
  id: number,
  patch: MemoryUpdate,
): Promise<boolean> {
  const sets: string[] = [];
  const params: Array<string | number | Uint8Array | null> = [];

  if (patch.content !== undefined) {
    sets.push('content = ?');
    params.push(patch.content);
  }
  if (patch.kind !== undefined) {
    sets.push('kind = ?');
    params.push(patch.kind);
  }
  if (patch.layer !== undefined) {
    sets.push('layer = ?');
    params.push(patch.layer);
  }
  if (patch.salience !== undefined) {
    sets.push('salience = ?');
    params.push(patch.salience);
  }
  if (patch.validFrom !== undefined) {
    sets.push('valid_from = ?');
    params.push(patch.validFrom);
  }
  if (patch.embedding !== undefined) {
    sets.push('embedding = ?');
    params.push(
      patch.embedding ? vectorToBytes(normalizeVector(patch.embedding)) : null,
    );
  }

  sets.push('updated_at = ?');
  params.push(patch.now ?? nowIso());
  params.push(id, userId);

  const result = await db.execute(
    `UPDATE user_memories SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
    params,
  );
  return result.changes > 0;
}

export async function markMemorySuperseded(
  db: DbExecutor,
  params: {
    userId: string;
    id: number;
    supersededBy: number;
    now?: string;
  },
): Promise<boolean> {
  const result = await db.execute(
    `UPDATE user_memories
     SET status = 'superseded', superseded_by = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [params.supersededBy, params.now ?? nowIso(), params.id, params.userId],
  );
  return result.changes > 0;
}

export async function deleteMemory(
  db: DbExecutor,
  userId: string,
  id: number,
): Promise<boolean> {
  const result = await db.execute(
    'DELETE FROM user_memories WHERE id = ? AND user_id = ?',
    [id, userId],
  );
  return result.changes > 0;
}

export async function clearMemories(
  db: DbExecutor,
  userId: string,
): Promise<number> {
  const result = await db.execute('DELETE FROM user_memories WHERE user_id = ?', [
    userId,
  ]);
  return result.changes;
}

export async function recordMemoryUsage(
  db: DbAdapter,
  params: { userId: string; ids: readonly number[]; now?: string },
): Promise<void> {
  if (params.ids.length === 0) return;
  const now = params.now ?? nowIso();
  await db.transaction(async (tx) => {
    for (const id of new Set(params.ids)) {
      await tx.execute(
        `UPDATE user_memories
         SET last_used_at = ?, use_count = use_count + 1
         WHERE id = ? AND user_id = ?`,
        [now, id, params.userId],
      );
    }
  });
}

/** 淘汰超额记忆：superseded 优先，其次 evictionScore 最低。 */
export async function evictMemories(
  db: DbAdapter,
  params: { userId: string; max?: number; now?: string },
): Promise<number[]> {
  const max = params.max ?? 200;
  const nowMs = params.now ? Date.parse(params.now) : Date.now();
  const memories = await listMemories(db, params.userId, {
    includeSuperseded: true,
  });
  if (memories.length <= max) return [];

  const sorted = [...memories].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'superseded' ? -1 : 1;
    return evictionScore(a, nowMs) - evictionScore(b, nowMs);
  });
  const toDelete = sorted.slice(0, memories.length - max).map((memory) => memory.id);

  await db.transaction(async (tx) => {
    for (const id of toDelete) {
      await tx.execute('DELETE FROM user_memories WHERE id = ? AND user_id = ?', [
        id,
        params.userId,
      ]);
    }
  });

  return toDelete;
}

export interface SimilarMemory {
  memory: MemoryRecord;
  relevance: number;
}

export async function recallSimilarMemories(
  db: DbExecutor,
  params: {
    userId: string;
    content: string;
    queryEmbedding?: Float32Array | null;
    limit?: number;
  },
): Promise<SimilarMemory[]> {
  const memories = await listMemories(db, params.userId);
  const limit = params.limit ?? 5;

  return memories
    .map((memory) => ({
      memory,
      relevance: memoryRelevance(memory, params.content, params.queryEmbedding),
    }))
    .filter((entry) => entry.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

export interface ConsolidateResult {
  merged: number;
}

/** 会话结束后的确定性整理：归一化内容重复的记忆保留分数最高的一条。 */
export async function consolidateMemories(
  db: DbAdapter,
  params: { userId: string; now?: string },
): Promise<ConsolidateResult> {
  const active = await listMemories(db, params.userId);
  const nowMs = params.now ? Date.parse(params.now) : Date.now();
  const groups = new Map<string, MemoryRecord[]>();

  for (const memory of active) {
    const key = normalizeMemoryContent(memory.content);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }

  const superseded: Array<{ id: number; keeperId: number }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => evictionScore(b, nowMs) - evictionScore(a, nowMs),
    );
    const keeper = sorted[0];
    for (const memory of sorted.slice(1)) {
      superseded.push({ id: memory.id, keeperId: keeper.id });
    }
  }

  if (superseded.length > 0) {
    const now = params.now ?? nowIso();
    await db.transaction(async (tx) => {
      for (const entry of superseded) {
        await markMemorySuperseded(tx, {
          userId: params.userId,
          id: entry.id,
          supersededBy: entry.keeperId,
          now,
        });
      }
    });
  }

  return { merged: superseded.length };
}

export async function countMemories(
  db: DbExecutor,
  userId: string,
  options: { activeOnly?: boolean } = {},
): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM user_memories WHERE user_id = ?${
      options.activeOnly ? " AND status = 'active'" : ''
    }`,
    [userId],
  );
  return Number(row?.count ?? 0);
}

export type { MemoryLayer, MemoryStatus };
