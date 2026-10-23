import type { DbAdapter } from '../../db/adapter';
import type { RetrievalHit } from '../types';

export interface AgentToolContext {
  db: DbAdapter;
  userId: string;
  bookId: string;
  bookName: string;
  /** 归一化后的书籍全文（TXT 可用；EPUB 后续按需注入） */
  content?: string;
  retrieve?: (query: string) => Promise<RetrievalHit[]>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<unknown>;
}
