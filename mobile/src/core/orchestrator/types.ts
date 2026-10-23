import type { NodeCache } from './cache';
import type { OrchestratorLlm } from './json';

export type TaskType = 'generate-notes' | 'character-analysis';

export interface OrchestratorEnv {
  bookId: string;
  userId: string;
  bookTitle: string;
  taskType: TaskType;
  llm: OrchestratorLlm;
  cache: NodeCache;
  modelSig: string;
  promptVersion: string;
  force?: boolean;
}
