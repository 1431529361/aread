export class TaskCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

export interface DagProgress {
  stage?: string;
  done?: number;
  total?: number;
  percent?: number;
  cached?: boolean;
}

export type DagEvent =
  | { type: 'node_start'; id: string; name?: string }
  | { type: 'node_progress'; id: string; progress: DagProgress }
  | { type: 'node_done'; id: string; cached?: boolean }
  | { type: 'node_error'; id: string; error: string }
  | { type: 'progress'; progress: number; total: number; percent: number }
  | { type: 'task_cancelled'; completed: number; total: number };

export interface DagNodeContext {
  signal?: AbortSignal;
  getOutput<T = unknown>(id: string): T | undefined;
  progress(progress: DagProgress): void;
}

export interface DagNode {
  id: string;
  name?: string;
  deps?: readonly string[];
  run(context: DagNodeContext): Promise<unknown>;
}

export interface DagRunOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (event: DagEvent) => void;
}

export interface DagRunResult {
  outputs: Map<string, unknown>;
  errors: Map<string, Error>;
  completed: string[];
  failed: string[];
  cancelled: boolean;
  total: number;
}

/**
 * 拓扑调度：依赖就绪的节点并行执行，全局并发上限默认 3。
 * - 取消后不再启动新节点，等待正在执行的节点结束
 * - 单节点失败记录 error，不阻塞依赖它的节点（部分场景允许降级）
 */
export async function runDag(
  nodes: readonly DagNode[],
  options: DagRunOptions = {},
): Promise<DagRunResult> {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const onEvent = options.onEvent ?? (() => {});
  const outputs = new Map<string, unknown>();
  const errors = new Map<string, Error>();
  const completed: string[] = [];
  const failed: string[] = [];
  const settled = new Set<string>();
  const pending = new Map(nodes.map((node) => [node.id, node]));
  const running = new Map<string, Promise<void>>();
  let cancelled = false;
  let settledCount = 0;
  const total = nodes.length;

  if (pending.size !== nodes.length) {
    throw new Error('DAG 节点 id 重复');
  }
  for (const node of nodes) {
    for (const dep of node.deps ?? []) {
      if (!pending.has(dep)) throw new Error(`节点 ${node.id} 依赖不存在: ${dep}`);
    }
  }

  const emitProgress = (): void => {
    onEvent({
      type: 'progress',
      progress: settledCount,
      total,
      percent: total === 0 ? 100 : Math.round((settledCount / total) * 100),
    });
  };

  const launch = (node: DagNode): void => {
    const promise = (async () => {
      if (options.signal?.aborted) throw new TaskCancelledError();
      onEvent({ type: 'node_start', id: node.id, name: node.name });
      try {
        const output = await node.run({
          signal: options.signal,
          getOutput: <T>(id: string) => outputs.get(id) as T | undefined,
          progress: (progress) =>
            onEvent({ type: 'node_progress', id: node.id, progress }),
        });
        outputs.set(node.id, output);
        completed.push(node.id);
        onEvent({ type: 'node_done', id: node.id });
      } catch (error) {
        if (error instanceof TaskCancelledError || options.signal?.aborted) {
          cancelled = true;
        } else {
          const taskError =
            error instanceof Error ? error : new Error(String(error));
          errors.set(node.id, taskError);
          failed.push(node.id);
          onEvent({ type: 'node_error', id: node.id, error: taskError.message });
        }
      } finally {
        settled.add(node.id);
        running.delete(node.id);
        settledCount++;
        emitProgress();
      }
    })();

    running.set(node.id, promise);
  };

  while (pending.size > 0 || running.size > 0) {
    if (options.signal?.aborted && !cancelled) {
      cancelled = true;
    }

    if (!cancelled) {
      const ready = [...pending.values()].filter((node) =>
        (node.deps ?? []).every((dep) => settled.has(dep)),
      );

      if (ready.length === 0 && running.size === 0) {
        for (const node of pending.values()) {
          const error = new Error('DAG 依赖无法满足（可能存在循环依赖）');
          errors.set(node.id, error);
          failed.push(node.id);
          settled.add(node.id);
          settledCount++;
          onEvent({ type: 'node_error', id: node.id, error: error.message });
        }
        pending.clear();
        emitProgress();
        break;
      }

      for (const node of ready) {
        if (running.size >= concurrency) break;
        pending.delete(node.id);
        launch(node);
      }
    }

    if (running.size > 0) {
      await Promise.race([...running.values()]);
    } else if (!cancelled && pending.size > 0) {
      // 无可启动节点但仍有 pending：下一轮会走循环依赖分支
      continue;
    }

    if (cancelled && running.size === 0) break;
  }

  if (cancelled) {
    onEvent({ type: 'task_cancelled', completed: settledCount, total });
  }

  return { outputs, errors, completed, failed, cancelled, total };
}
