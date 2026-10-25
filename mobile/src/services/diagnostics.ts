import type { DbAdapter } from '../db/adapter';
import { getFts5Status, type Fts5Status } from '../db/fts5';
import { getStreamingMode, type StreamingMode } from './llmRuntime';
import { LATEST_SCHEMA_VERSION } from '../db/schema';

export interface Diagnostics {
  fts5: Fts5Status;
  streaming: StreamingMode;
  schemaVersion: number;
  books: number;
  chunks: number;
  vectors: number;
  conversations: number;
  highlights: number;
  storageBytes: number;
}

async function count(db: DbAdapter, table: string): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table}`,
  );
  return Number(row?.count ?? 0);
}

export async function getDiagnostics(db: DbAdapter): Promise<Diagnostics> {
  const storage = await db.queryOne<{ bytes: number | null }>(
    'SELECT SUM(size) AS bytes FROM books_meta',
  );
  return {
    fts5: getFts5Status(),
    streaming: getStreamingMode(),
    schemaVersion: LATEST_SCHEMA_VERSION,
    books: await count(db, 'books_meta'),
    chunks: await count(db, 'rag_chunks'),
    vectors: await count(db, 'rag_vectors'),
    conversations: await count(db, 'conversations'),
    highlights: await count(db, 'highlights'),
    storageBytes: Number(storage?.bytes ?? 0),
  };
}
