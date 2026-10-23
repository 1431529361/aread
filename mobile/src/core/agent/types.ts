import type { DbAdapter } from '../../db/adapter';
import type { RetrievalHit } from '../types';

export interface AgentToolResultLimits {
  maxArrayItems?: number;
  maxStringLength?: number;
  maxObjectKeys?: number;
}

export interface AgentToolContext {
  db: DbAdapter;
  userId: string;
  bookId: string;
  bookName: string;
  /** 归一化后的书籍全文（TXT 可用；EPUB 后续按需注入） */
  content?: string;
  retrieve?: (query: string) => Promise<RetrievalHit[]>;
  /** 跨书检索；未注入时 searchLibrary 工具返回不可用 */
  searchLibrary?: (query: string) => Promise<RetrievalHit[]>;
  signal?: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 覆盖默认工具结果截断限制（如章节列表需要更多条目） */
  resultLimits?: AgentToolResultLimits;
  execute(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<unknown>;
}
