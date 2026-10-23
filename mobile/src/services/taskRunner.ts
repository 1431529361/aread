import type { DbAdapter } from '../db/adapter';
import { sha256Hex } from '../core/embedding/sha256';
import { complete, type LlmClientConfig } from '../core/llm/client';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_SINGLE_PASS_MAX_TOKENS,
  selectNotesStrategy,
  singlePassBudget,
  type NotesStrategy,
} from '../core/context/tokens';
import { splitChapters } from '../core/rag/chapters';
import { getProviderConfig } from '../db/repositories/providers';
import type { NodeCache } from '../core/orchestrator/cache';
import {
  TaskCancelledError,
  runDag,
  type DagEvent,
} from '../core/orchestrator/dag';
import { buildCharacterPlan, type CharacterFinalValue } from '../core/orchestrator/characters';
import {
  buildNotesPlan,
  buildSinglePassNotesPlan,
  type NotesFinalValue,
} from '../core/orchestrator/notes';
import {
  CHARACTERS_PROMPT_VERSION,
  NOTES_PROMPT_VERSION,
  NOTES_SINGLE_PROMPT_VERSION,
} from '../core/orchestrator/prompts';
import type { OrchestratorLlm } from '../core/orchestrator/json';
import type { OrchestratorEnv, TaskType } from '../core/orchestrator/types';
import {
  getCachedNode,
  putCachedNode,
} from '../db/repositories/taskCache';
import {
  createTaskRun,
  saveTaskResult,
  updateTaskRun,
  type TaskRunStatus,
} from '../db/repositories/taskRuns';

export type TaskEvent =
  | {
      type: 'task_start';
      runId: string;
      taskType: TaskType;
      bookId: string;
      totalNodes: number;
    }
  | DagEvent
  | {
      type: 'fallback';
      taskType: TaskType;
      from: 'single-pass';
      to: 'map-reduce';
      reason: string;
    }
  | {
      type: 'task_done';
      runId: string;
      taskType: TaskType;
      status: TaskRunStatus;
      coverage: number;
      cacheHits: number;
      durationMs: number;
      errors: number;
      strategy: TaskStrategyUsed;
    };

export type TaskStrategyUsed =
  | 'single-pass'
  | 'map-reduce'
  | 'single-pass-fallback';

export interface StartTaskOptions {
  db: DbAdapter;
  userId: string;
  bookId: string;
  bookTitle: string;
  content: string;
  taskType: TaskType;
  chatConfig: LlmClientConfig;
  /** 测试/评测可注入带 extraBody 的 LLM 适配器 */
  llm?: OrchestratorLlm;
  extraBody?: Record<string, unknown>;
  force?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: TaskEvent) => void;
  concurrency?: number;
  /** 来自 chat provider_config；默认 200000 */
  contextWindow?: number;
  /** 单次调用内容预算上限；默认 100000 tokens */
  singlePassMaxTokens?: number;
}

export interface TaskRunResult {
  runId: string;
  taskType: TaskType;
  status: TaskRunStatus;
  content: string;
  coverage: number;
  missingChapters: number[];
  missingChunks: string[];
  errors: Array<{ node: string; error: string }>;
  cacheHits: number;
  totalNodes: number;
  completedNodes: number;
  durationMs: number;
  chapterCount: number;
  chunkCount: number;
  characterCount?: number;
  mentionCount?: number;
  partCount?: number;
  strategy: TaskStrategyUsed;
  fallbackReason?: string;
  contextWindow: number;
  singlePassBudget: number;
}

const runningControllers = new Map<string, AbortController>();

function createRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function modelSignature(config: LlmClientConfig): string {
  return sha256Hex(`${config.baseUrl.trim()}|${config.model.trim()}`).slice(0, 16);
}

function buildLlm(
  options: StartTaskOptions,
  signal: AbortSignal,
): OrchestratorLlm {
  if (options.llm) return options.llm;
  return {
    complete: (prompt, llmOptions) =>
      complete(options.chatConfig, prompt, {
        maxTokens: llmOptions?.maxTokens,
        temperature: llmOptions?.temperature,
        timeoutMs: 90000,
        retries: 2,
        signal: llmOptions?.signal ?? signal,
        extraBody: options.extraBody,
      }),
  };
}

export function isContextLengthError(error: Error): boolean {
  const status = (error as { status?: number }).status;
  const body = (error as { body?: unknown }).body;
  const text = `${error.message} ${body ? JSON.stringify(body) : ''}`.toLowerCase();
  const statusMatches = status === 400 || status === 413 || status == null;
  return statusMatches && /context|length|token|too long|maximum/.test(text);
}

export async function startTask(options: StartTaskOptions): Promise<TaskRunResult> {
  const startedAt = Date.now();
  const runId = createRunId();
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  runningControllers.set(runId, controller);

  const promptVersion =
    options.taskType === 'generate-notes'
      ? NOTES_PROMPT_VERSION
      : CHARACTERS_PROMPT_VERSION;
  const contextWindow =
    options.contextWindow ??
    (await getProviderConfig(options.db, 'chat').catch(() => null))
      ?.contextWindow ??
    DEFAULT_CONTEXT_WINDOW;
  const singlePassMaxTokens =
    options.singlePassMaxTokens ?? DEFAULT_SINGLE_PASS_MAX_TOKENS;
  const singlePassBudgetTokens = singlePassBudget(
    contextWindow,
    singlePassMaxTokens,
  );
  const initialStrategy: NotesStrategy =
    options.taskType === 'generate-notes'
      ? selectNotesStrategy(options.content, {
          contextWindow,
          singlePassMaxTokens,
        })
      : 'map-reduce';
  let activePromptVersion =
    initialStrategy === 'single-pass'
      ? NOTES_SINGLE_PROMPT_VERSION
      : promptVersion;
  let strategyUsed: TaskStrategyUsed =
    initialStrategy === 'single-pass' ? 'single-pass' : 'map-reduce';
  let fallbackReason: string | undefined;
  const modelSig = modelSignature(options.chatConfig);
  let cacheHits = 0;

  const cache: NodeCache = {
    async get(unitKey, inputHash) {
      if (options.force) return null;
      const value = await getCachedNode(options.db, {
        bookId: options.bookId,
        taskType: options.taskType,
        unitKey,
        unitHash: inputHash,
        promptVersion: activePromptVersion,
        modelSig,
      });
      if (value !== null) cacheHits++;
      return value;
    },
    async set(unitKey, inputHash, output) {
      await putCachedNode(options.db, {
        bookId: options.bookId,
        taskType: options.taskType,
        unitKey,
        unitHash: inputHash,
        promptVersion: activePromptVersion,
        modelSig,
        output,
      });
    },
  };

  const env: OrchestratorEnv = {
    bookId: options.bookId,
    userId: options.userId,
    bookTitle: options.bookTitle,
    taskType: options.taskType,
    llm: buildLlm(options, controller.signal),
    cache,
    modelSig,
    promptVersion: activePromptVersion,
    force: options.force,
  };

  let nodes: ReturnType<typeof buildNotesPlan>['nodes'];
  let finalNodeId: string;
  let expectedChapters = 0;
  let expectedChunks = 0;
  let expectedParts = 0;

  try {
    if (options.taskType === 'generate-notes') {
      const plan =
        initialStrategy === 'single-pass'
          ? buildSinglePassNotesPlan(env, options.content)
          : buildNotesPlan(env, options.content);
      nodes = plan.nodes;
      finalNodeId = plan.finalNodeId;
      expectedChapters = plan.chapters.length;
      expectedChunks = plan.chunkCount;
      expectedParts = plan.partCount;
    } else {
      const plan = buildCharacterPlan(env, options.content);
      nodes = plan.nodes;
      finalNodeId = plan.finalNodeId;
      expectedChapters = splitChapters(options.content).length;
      expectedChunks = plan.chunkCount;
    }
  } catch (error) {
    runningControllers.delete(runId);
    options.signal?.removeEventListener('abort', externalAbort);
    throw error;
  }

  await createTaskRun(options.db, {
    id: runId,
    userId: options.userId,
    bookId: options.bookId,
    taskType: options.taskType,
    startedAt: new Date(startedAt).toISOString(),
  });

  options.onEvent?.({
    type: 'task_start',
    runId,
    taskType: options.taskType,
    bookId: options.bookId,
    totalNodes: nodes.length,
  });

  const handleDagEvent = (event: DagEvent): void => {
    options.onEvent?.(event);
    if (event.type === 'progress') {
      void updateTaskRun(options.db, {
        id: runId,
        progress: event.total === 0 ? 1 : event.progress / event.total,
        totalNodes: event.total,
        completedNodes: event.progress,
      }).catch(() => {});
    }
  };

  let dag;
  try {
    dag = await runDag(nodes, {
      concurrency: options.concurrency ?? 3,
      signal: controller.signal,
      onEvent: handleDagEvent,
    });
  } catch (error) {
    dag = {
      outputs: new Map<string, unknown>(),
      errors: new Map([['dag', error instanceof Error ? error : new Error(String(error))]]),
      completed: [],
      failed: ['dag'],
      cancelled: error instanceof TaskCancelledError || controller.signal.aborted,
      total: nodes.length,
    };
  }

  let finalOutput = dag.outputs.get(finalNodeId) as
    | NotesFinalValue
    | CharacterFinalValue
    | undefined;

  if (
    options.taskType === 'generate-notes' &&
    initialStrategy === 'single-pass' &&
    !dag.cancelled &&
    !controller.signal.aborted
  ) {
    const contextError = [...dag.errors.values()].find(isContextLengthError);
    const notesOutput = finalOutput as NotesFinalValue | undefined;
    const needsFallback =
      contextError != null ||
      !notesOutput ||
      notesOutput.coverage < 1 ||
      notesOutput.missingChapters.length > 0;

    if (needsFallback) {
      fallbackReason = contextError
        ? 'context_limit'
        : notesOutput
          ? 'coverage_incomplete'
          : 'single_pass_failed';
      options.onEvent?.({
        type: 'fallback',
        taskType: 'generate-notes',
        from: 'single-pass',
        to: 'map-reduce',
        reason: fallbackReason,
      });

      activePromptVersion = NOTES_PROMPT_VERSION;
      const mapPlan = buildNotesPlan(env, options.content);
      nodes = mapPlan.nodes;
      finalNodeId = mapPlan.finalNodeId;
      expectedChapters = mapPlan.chapters.length;
      expectedChunks = mapPlan.chunkCount;
      expectedParts = mapPlan.partCount;

      dag = await runDag(nodes, {
        concurrency: options.concurrency ?? 3,
        signal: controller.signal,
        onEvent: handleDagEvent,
      });
      finalOutput = dag.outputs.get(finalNodeId) as
        | NotesFinalValue
        | CharacterFinalValue
        | undefined;
      strategyUsed = 'single-pass-fallback';
    }
  }

  let status: TaskRunStatus;
  if (dag.cancelled || controller.signal.aborted) {
    status = 'cancelled';
  } else if (!finalOutput) {
    status = 'failed';
  } else if (
    dag.errors.size > 0 ||
    finalOutput.degraded ||
    finalOutput.coverage < 1 ||
    ('missingChapters' in finalOutput && finalOutput.missingChapters.length > 0) ||
    ('missingChunks' in finalOutput && finalOutput.missingChunks.length > 0)
  ) {
    status = 'partial';
  } else {
    status = 'completed';
  }

  const content = finalOutput?.markdown ?? '';
  if (content && status !== 'cancelled') {
    await saveTaskResult(options.db, {
      userId: options.userId,
      bookId: options.bookId,
      taskType: options.taskType,
      content,
    });
  }

  const errorEntries = [...dag.errors.entries()].map(([node, error]) => ({
    node,
    error: error.message,
  }));
  const errorText = errorEntries
    .slice(0, 5)
    .map((entry) => `${entry.node}: ${entry.error}`)
    .join('\n');

  await updateTaskRun(options.db, {
    id: runId,
    status,
    progress: dag.cancelled ? dag.completed.length / Math.max(1, dag.total) : 1,
    totalNodes: dag.total,
    completedNodes: dag.completed.length,
    error: errorText || null,
    updatedAt: new Date().toISOString(),
  });

  runningControllers.delete(runId);
  options.signal?.removeEventListener('abort', externalAbort);

  const durationMs = Date.now() - startedAt;
  const coverage = finalOutput?.coverage ?? 0;

  options.onEvent?.({
    type: 'task_done',
    runId,
    taskType: options.taskType,
    status,
    coverage,
    cacheHits,
    durationMs,
    errors: errorEntries.length,
    strategy: strategyUsed,
  });

  return {
    runId,
    taskType: options.taskType,
    status,
    content,
    coverage,
    missingChapters:
      finalOutput && 'missingChapters' in finalOutput
        ? finalOutput.missingChapters
        : [],
    missingChunks:
      finalOutput && 'missingChunks' in finalOutput
        ? finalOutput.missingChunks
        : [],
    errors: errorEntries,
    cacheHits,
    totalNodes: dag.total,
    completedNodes: dag.completed.length,
    durationMs,
    chapterCount:
      finalOutput && 'chapterCount' in finalOutput
        ? finalOutput.chapterCount
        : expectedChapters,
    chunkCount:
      finalOutput && 'chunkCount' in finalOutput
        ? finalOutput.chunkCount
        : expectedChunks,
    characterCount:
      finalOutput && 'characterCount' in finalOutput
        ? finalOutput.characterCount
        : undefined,
    mentionCount:
      finalOutput && 'mentionCount' in finalOutput
        ? finalOutput.mentionCount
        : undefined,
    partCount:
      finalOutput && 'partCount' in finalOutput
        ? finalOutput.partCount
        : expectedParts || undefined,
    strategy: strategyUsed,
    fallbackReason,
    contextWindow,
    singlePassBudget: singlePassBudgetTokens,
  };
}

export async function resumeTask(
  options: StartTaskOptions,
): Promise<TaskRunResult> {
  return startTask({ ...options, force: false });
}

export function cancelTask(runId: string): boolean {
  const controller = runningControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isTaskRunning(runId: string): boolean {
  return runningControllers.has(runId);
}
