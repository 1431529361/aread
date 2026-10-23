import type { DbExecutor } from '../adapter';

export type TaskType = 'generate-notes' | 'character-analysis';
export type TaskRunStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed';

export interface TaskRunRecord {
  id: string;
  userId: string;
  bookId: string;
  taskType: TaskType;
  status: TaskRunStatus;
  progress: number;
  totalNodes: number;
  completedNodes: number;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

interface TaskRunRow {
  id: string;
  user_id: string;
  book_id: string;
  task_type: string;
  status: string;
  progress: number;
  total_nodes: number;
  completed_nodes: number;
  error: string | null;
  started_at: string;
  updated_at: string;
}

function mapRun(row: TaskRunRow): TaskRunRecord {
  return {
    id: row.id,
    userId: row.user_id,
    bookId: row.book_id,
    taskType: row.task_type as TaskType,
    status: row.status as TaskRunStatus,
    progress: Number(row.progress ?? 0),
    totalNodes: Number(row.total_nodes ?? 0),
    completedNodes: Number(row.completed_nodes ?? 0),
    error: row.error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export async function createTaskRun(
  db: DbExecutor,
  params: {
    id: string;
    userId: string;
    bookId: string;
    taskType: TaskType;
    startedAt?: string;
  },
): Promise<void> {
  const now = params.startedAt ?? new Date().toISOString();
  await db.execute(
    `INSERT INTO task_runs
      (id, user_id, book_id, task_type, status, progress,
       total_nodes, completed_nodes, error, started_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', 0, 0, 0, NULL, ?, ?)`,
    [params.id, params.userId, params.bookId, params.taskType, now, now],
  );
}

export async function updateTaskRun(
  db: DbExecutor,
  params: {
    id: string;
    status?: TaskRunStatus;
    progress?: number;
    totalNodes?: number;
    completedNodes?: number;
    error?: string | null;
    updatedAt?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  if (params.status !== undefined) {
    sets.push('status = ?');
    values.push(params.status);
  }
  if (params.progress !== undefined) {
    sets.push('progress = ?');
    values.push(Math.max(0, Math.min(1, params.progress)));
  }
  if (params.totalNodes !== undefined) {
    sets.push('total_nodes = ?');
    values.push(params.totalNodes);
  }
  if (params.completedNodes !== undefined) {
    sets.push('completed_nodes = ?');
    values.push(params.completedNodes);
  }
  if (params.error !== undefined) {
    sets.push('error = ?');
    values.push(params.error);
  }
  sets.push('updated_at = ?');
  values.push(params.updatedAt ?? new Date().toISOString());
  values.push(params.id);

  await db.execute(
    `UPDATE task_runs SET ${sets.join(', ')} WHERE id = ?`,
    values,
  );
}

export async function getTaskRun(
  db: DbExecutor,
  id: string,
): Promise<TaskRunRecord | null> {
  const row = await db.queryOne<TaskRunRow>(
    'SELECT * FROM task_runs WHERE id = ?',
    [id],
  );
  return row ? mapRun(row) : null;
}

export async function getLatestTaskRun(
  db: DbExecutor,
  params: { bookId: string; taskType: TaskType; userId: string },
): Promise<TaskRunRecord | null> {
  const row = await db.queryOne<TaskRunRow>(
    `SELECT * FROM task_runs
     WHERE book_id = ? AND task_type = ? AND user_id = ?
     ORDER BY started_at DESC LIMIT 1`,
    [params.bookId, params.taskType, params.userId],
  );
  return row ? mapRun(row) : null;
}

export async function listTaskRuns(
  db: DbExecutor,
  params: { bookId: string; userId: string; limit?: number },
): Promise<TaskRunRecord[]> {
  const rows = await db.queryAll<TaskRunRow>(
    `SELECT * FROM task_runs
     WHERE book_id = ? AND user_id = ?
     ORDER BY started_at DESC LIMIT ?`,
    [params.bookId, params.userId, params.limit ?? 20],
  );
  return rows.map(mapRun);
}

export async function saveTaskResult(
  db: DbExecutor,
  params: {
    userId: string;
    bookId: string;
    taskType: TaskType;
    content: string;
    now?: string;
  },
): Promise<void> {
  const now = params.now ?? new Date().toISOString();
  await db.execute(
    `INSERT INTO task_results (user_id, book_id, task_type, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, book_id, task_type) DO UPDATE SET
       content = excluded.content,
       updated_at = excluded.updated_at`,
    [params.userId, params.bookId, params.taskType, params.content, now, now],
  );
}

export async function getTaskResult(
  db: DbExecutor,
  params: { userId: string; bookId: string; taskType: TaskType },
): Promise<string | null> {
  const row = await db.queryOne<{ content: string }>(
    `SELECT content FROM task_results
     WHERE user_id = ? AND book_id = ? AND task_type = ?`,
    [params.userId, params.bookId, params.taskType],
  );
  return row?.content ?? null;
}
