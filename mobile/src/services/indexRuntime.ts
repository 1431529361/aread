import type { DbAdapter } from '../db/adapter';
import { LOCAL_USER_ID } from '../db/schema';
import { computeEmbedSig } from '../core/embedding/signature';
import { embedTexts } from '../core/embedding/client';
import { indexBook, type IndexProgress, type IndexResult } from './indexing';
import { loadEmbeddingRuntime, type EmbeddingRuntime } from './providerRuntime';
import { nativeFetch } from './llmRuntime';

export function runtimeEmbedSig(runtime: EmbeddingRuntime): string {
  return computeEmbedSig({
    baseUrl: runtime.record.baseUrl,
    model: runtime.record.model,
    dimensionsParam: runtime.record.dimensionsParam,
    dims: runtime.record.dims ?? 1024,
  });
}

function embedder(runtime: EmbeddingRuntime, signal?: AbortSignal) {
  return {
    embedSig: runtimeEmbedSig(runtime),
    dims: runtime.record.dims ?? 1024,
    embedTexts: (texts: readonly string[]) =>
      embedTexts(runtime.config, texts, {
        fetchImpl: nativeFetch,
        retries: 2,
        timeoutMs: 30000,
        signal,
      }),
  };
}

export async function markBooksForVectorRebuild(
  db: DbAdapter,
  activeSig: string,
  userId = LOCAL_USER_ID,
): Promise<number> {
  const result = await db.execute(
    `UPDATE books_meta
     SET index_status = 'partial'
     WHERE user_id = ?
       AND EXISTS (SELECT 1 FROM rag_chunks c WHERE c.book_id = books_meta.id)
       AND COALESCE(embed_sig, '') != ?`,
    [userId, activeSig],
  );
  return result.changes;
}

export async function runBookVectorIndex(params: {
  db: DbAdapter;
  bookId: string;
  userId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: IndexProgress) => void;
}): Promise<IndexResult> {
  const runtime = await loadEmbeddingRuntime(params.db);
  if (!runtime) throw new Error('尚未配置向量模型，请先在设置中完成配置');

  return indexBook({
    db: params.db,
    userId: params.userId ?? LOCAL_USER_ID,
    bookId: params.bookId,
    mode: 'embedding',
    embed: embedder(runtime, params.signal),
    signal: params.signal,
    onProgress: params.onProgress,
  });
}

export interface LibraryIndexProgress {
  current: number;
  total: number;
  bookId: string;
  bookTitle: string;
  book: IndexProgress | null;
}

export async function rebuildLibraryVectors(params: {
  db: DbAdapter;
  userId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: LibraryIndexProgress) => void;
  onlyInterrupted?: boolean;
}): Promise<{ completed: number; partial: number; total: number }> {
  const userId = params.userId ?? LOCAL_USER_ID;
  const runtime = await loadEmbeddingRuntime(params.db);
  if (!runtime) throw new Error('尚未配置向量模型，请先在设置中完成配置');
  const activeSig = runtimeEmbedSig(runtime);
  const rows = await params.db.queryAll<{
    id: string;
    title: string;
    index_status: string;
    embed_sig: string | null;
  }>(
    `SELECT b.id, b.title, b.index_status, b.embed_sig
     FROM books_meta b
     WHERE b.user_id = ?
       AND EXISTS (SELECT 1 FROM rag_chunks c WHERE c.book_id = b.id)
       ${params.onlyInterrupted ? "AND b.index_status = 'embedding'" : "AND (b.embed_sig IS NULL OR b.embed_sig != ? OR b.index_status != 'ready')"}
     ORDER BY b.upload_time`,
    params.onlyInterrupted ? [userId] : [userId, activeSig],
  );

  let completed = 0;
  let partial = 0;
  for (let index = 0; index < rows.length; index++) {
    if (params.signal?.aborted) break;
    const row = rows[index];
    params.onProgress?.({
      current: index,
      total: rows.length,
      bookId: row.id,
      bookTitle: row.title,
      book: null,
    });
    try {
      const result = await indexBook({
        db: params.db,
        userId,
        bookId: row.id,
        mode: 'embedding',
        embed: embedder(runtime, params.signal),
        signal: params.signal,
        onProgress: (book) =>
          params.onProgress?.({
            current: index,
            total: rows.length,
            bookId: row.id,
            bookTitle: row.title,
            book,
          }),
      });
      if (result.status === 'ready') completed++;
      else partial++;
    } catch {
      if (params.signal?.aborted) break;
      partial++;
    }
  }

  return { completed, partial, total: rows.length };
}

/** App 被系统杀死时状态会停在 embedding；下次启动只续跑这些任务。 */
export async function resumeInterruptedVectorIndexes(db: DbAdapter): Promise<void> {
  const runtime = await loadEmbeddingRuntime(db);
  if (!runtime) return;
  await rebuildLibraryVectors({ db, onlyInterrupted: true });
}
