import type { DbExecutor } from '../adapter';
import type { TaskType } from './taskRuns';

export interface TaskCacheLookup {
  bookId: string;
  taskType: TaskType;
  unitKey: string;
  unitHash: string;
  promptVersion: string;
  modelSig: string;
}

export interface TaskCacheWrite extends TaskCacheLookup {
  output: unknown;
  now?: string;
}

interface CacheRow {
  unit_hash: string;
  output_json: string;
}

export async function getCachedNode(
  db: DbExecutor,
  lookup: TaskCacheLookup,
): Promise<unknown | null> {
  const row = await db.queryOne<CacheRow>(
    `SELECT unit_hash, output_json
     FROM task_node_cache
     WHERE book_id = ? AND task_type = ? AND unit_key = ?
       AND prompt_version = ? AND model_sig = ?`,
    [
      lookup.bookId,
      lookup.taskType,
      lookup.unitKey,
      lookup.promptVersion,
      lookup.modelSig,
    ],
  );
  if (!row || row.unit_hash !== lookup.unitHash) return null;

  try {
    return JSON.parse(row.output_json) as unknown;
  } catch {
    return null;
  }
}

export async function putCachedNode(
  db: DbExecutor,
  write: TaskCacheWrite,
): Promise<void> {
  const now = write.now ?? new Date().toISOString();
  await db.execute(
    `INSERT INTO task_node_cache
      (book_id, task_type, unit_key, unit_hash, prompt_version, model_sig,
       output_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, task_type, unit_key, prompt_version, model_sig)
     DO UPDATE SET
       unit_hash = excluded.unit_hash,
       output_json = excluded.output_json,
       updated_at = excluded.updated_at`,
    [
      write.bookId,
      write.taskType,
      write.unitKey,
      write.unitHash,
      write.promptVersion,
      write.modelSig,
      JSON.stringify(write.output),
      now,
      now,
    ],
  );
}

export async function clearTaskCache(
  db: DbExecutor,
  params: { bookId: string; taskType?: TaskType },
): Promise<number> {
  const result = params.taskType
    ? await db.execute(
        'DELETE FROM task_node_cache WHERE book_id = ? AND task_type = ?',
        [params.bookId, params.taskType],
      )
    : await db.execute('DELETE FROM task_node_cache WHERE book_id = ?', [
        params.bookId,
      ]);
  return result.changes;
}

export async function countTaskCache(
  db: DbExecutor,
  params: { bookId: string; taskType?: TaskType },
): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM task_node_cache
     WHERE book_id = ?${params.taskType ? ' AND task_type = ?' : ''}`,
    params.taskType ? [params.bookId, params.taskType] : [params.bookId],
  );
  return Number(row?.count ?? 0);
}
