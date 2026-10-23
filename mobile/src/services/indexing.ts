import type { DbAdapter } from '../db/adapter';
import { chunkText, type ChunkResult } from '../core/rag/chunk';
import type { ChunkRecord } from '../core/types';
import { EMBED_DIMS } from '../core/embedding/signature';
import {
  loadChunksForBook,
  writeLexicalIndex,
} from '../db/repositories/chunks';
import {
  deleteVectorsExceptSig,
  getChunkIdsMissingVectors,
  upsertVectors,
} from '../db/repositories/vectors';

export const EMBED_BATCH_SIZE = 10;

export type IndexStage =
  | 'pending'
  | 'chunking'
  | 'lexical_ready'
  | 'embedding'
  | 'ready'
  | 'partial';

export type IndexRunStatus = 'ready' | 'partial' | 'lexical_ready';

export interface IndexProgress {
  stage: IndexStage;
  done: number;
  total: number;
  percent: number;
  error?: string;
}

export interface EmbedFunction {
  embedSig: string;
  dims?: number;
  embedTexts: (texts: readonly string[]) => Promise<number[][]>;
}

export interface IndexBookParams {
  db: DbAdapter;
  userId: string;
  bookId: string;
  content?: string;
  charCount?: number;
  chunks?: readonly ChunkResult[];
  /** full=重建词法索引；embedding=保留 chunks 只补/换向量 */
  mode?: 'full' | 'embedding';
  embed?: EmbedFunction | null;
  signal?: AbortSignal;
  onProgress?: (progress: IndexProgress) => void;
}

export interface IndexResult {
  status: IndexRunStatus;
  chunks: number;
  embedded: number;
  failed: number;
  error?: string;
}

export class IndexingCancelledError extends Error {
  constructor() {
    super('索引已取消');
    this.name = 'IndexingCancelledError';
  }
}

function report(
  onProgress: IndexBookParams['onProgress'],
  progress: IndexProgress,
): void {
  onProgress?.(progress);
}

async function updateBookMeta(
  db: DbAdapter,
  params: {
    bookId: string;
    userId: string;
    status: IndexStage;
    progress: number;
    embedSig: string | null;
    embedDims: number | null;
    charCount?: number | null;
  },
): Promise<void> {
  await db.execute(
    `UPDATE books_meta
     SET index_status = ?, index_progress = ?, embed_sig = ?, embed_dims = ?,
         char_count = COALESCE(?, char_count)
     WHERE id = ? AND user_id = ?`,
    [
      params.status,
      params.progress,
      params.embedSig,
      params.embedDims,
      params.charCount ?? null,
      params.bookId,
      params.userId,
    ],
  );
}

async function updateJob(
  db: DbAdapter,
  params: { bookId: string; stage: IndexStage; cursor: number; error: string | null },
): Promise<void> {
  await db.execute(
    `INSERT INTO index_jobs (book_id, stage, "cursor", error, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(book_id) DO UPDATE SET
       stage = excluded.stage,
       "cursor" = excluded."cursor",
       error = excluded.error,
       updated_at = excluded.updated_at`,
    [params.bookId, params.stage, params.cursor, params.error],
  );
}

async function markStage(
  db: DbAdapter,
  params: {
    bookId: string;
    userId: string;
    stage: IndexStage;
    progress: number;
    cursor: number;
    embedSig: string | null;
    embedDims: number | null;
    charCount?: number | null;
    error?: string | null;
    onProgress?: IndexBookParams['onProgress'];
    done?: number;
    total?: number;
  },
): Promise<void> {
  await updateBookMeta(db, {
    bookId: params.bookId,
    userId: params.userId,
    status: params.stage,
    progress: params.progress,
    embedSig: params.embedSig,
    embedDims: params.embedDims,
    charCount: params.charCount,
  });
  await updateJob(db, {
    bookId: params.bookId,
    stage: params.stage,
    cursor: params.cursor,
    error: params.error ?? null,
  });
  report(params.onProgress, {
    stage: params.stage,
    done: params.done ?? params.cursor,
    total: params.total ?? params.cursor,
    percent: Math.round(params.progress * 100),
    error: params.error ?? undefined,
  });
}

/**
 * 索引状态机：
 * pending → chunking → lexical_ready → embedding → ready/partial
 *
 * - full：重建 chunks/FTS，再写入当前 embed_sig 向量
 * - embedding：保留 chunks，只补齐当前 sig 缺失的向量（换模型/断点续跑）
 * - 成功后才清理旧 sig 向量并把 books_meta.embed_sig 切到新值
 */
export async function indexBook(params: IndexBookParams): Promise<IndexResult> {
  const {
    db,
    userId,
    bookId,
    embed = null,
    signal,
    onProgress,
  } = params;
  const mode = params.mode ?? 'full';
  const dims = embed?.dims ?? EMBED_DIMS;

  if (embed && dims !== EMBED_DIMS) {
    throw new Error(`Embedding 维度固定为 ${EMBED_DIMS}`);
  }
  if (embed && !embed.embedSig.trim()) {
    throw new Error('Embedding embed_sig 不能为空');
  }

  const book = await db.queryOne<{ id: string }>(
    'SELECT id FROM books_meta WHERE id = ? AND user_id = ?',
    [bookId, userId],
  );
  if (!book) throw new Error(`书籍不存在: ${bookId}`);

  let storedChunks: ChunkRecord[];

  if (mode === 'full') {
    const sourceChunks =
      params.chunks ??
      (params.content != null
        ? chunkText(params.content)
        : null);
    if (!sourceChunks) {
      throw new Error('full 模式需要 content 或 chunks');
    }

    await markStage(db, {
      bookId,
      userId,
      stage: 'chunking',
      progress: 0,
      cursor: 0,
      embedSig: null,
      embedDims: null,
      charCount: params.charCount ?? params.content?.length ?? null,
      onProgress,
      done: 0,
      total: sourceChunks.length,
    });

    if (signal?.aborted) throw new IndexingCancelledError();

    const newChunks = sourceChunks.map((chunk) => ({
      index: chunk.index,
      chapter: chunk.chapter,
      text: chunk.text,
      loc: {
        kind: chunk.loc_kind,
        href: chunk.loc_href,
        start: chunk.loc_start,
        end: chunk.loc_end,
      },
    }));
    await writeLexicalIndex(db, { userId, bookId, chunks: newChunks });
    storedChunks = await loadChunksForBook(db, bookId);

    if (!embed) {
      await markStage(db, {
        bookId,
        userId,
        stage: 'lexical_ready',
        progress: 0.5,
        cursor: 0,
        embedSig: null,
        embedDims: null,
        charCount: params.charCount ?? params.content?.length ?? null,
        onProgress,
        done: 0,
        total: storedChunks.length,
      });
      return {
        status: 'lexical_ready',
        chunks: storedChunks.length,
        embedded: 0,
        failed: 0,
      };
    }

    await markStage(db, {
      bookId,
      userId,
      stage: 'lexical_ready',
      progress: 0.3,
      cursor: 0,
      embedSig: null,
      embedDims: null,
      charCount: params.charCount ?? params.content?.length ?? null,
      onProgress,
      done: 0,
      total: storedChunks.length,
    });
  } else {
    storedChunks = await loadChunksForBook(db, bookId);
    if (storedChunks.length === 0) {
      throw new Error('embedding 模式下没有可续跑的 chunk，请先执行 full 索引');
    }
    if (!embed) throw new Error('embedding 模式需要 embedding 配置');
  }

  // 换模型重建期间保持旧 active sig，直到新向量全部成功后才切换
  let keepSig: string | null = null;
  let keepDims: number | null = null;
  if (mode === 'embedding') {
    const meta = await db.queryOne<{ embed_sig: string | null; embed_dims: number | null }>(
      'SELECT embed_sig, embed_dims FROM books_meta WHERE id = ? AND user_id = ?',
      [bookId, userId],
    );
    keepSig = meta?.embed_sig ?? null;
    keepDims = meta?.embed_dims ?? null;
  }

  const missingIds = await getChunkIdsMissingVectors(db, {
    bookId,
    embedSig: embed!.embedSig,
  });
  const missing = new Set(missingIds);
  const pending = storedChunks.filter((chunk) => missing.has(chunk.id));
  const total = storedChunks.length;
  const workTotal = pending.length;

  let done = 0;
  let lastError: string | null = null;
  let aborted = false;

  const baseProgress = 0.3;

  if (workTotal > 0) {
    await markStage(db, {
      bookId,
      userId,
      stage: 'embedding',
      progress: baseProgress,
      cursor: 0,
      embedSig: keepSig,
      embedDims: keepDims,
      onProgress,
      done: 0,
      total: workTotal,
    });
  }

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }

    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    try {
      const vectors = await embed!.embedTexts(batch.map((chunk) => chunk.text));
      if (vectors.length !== batch.length) {
        throw new Error('Embedding 返回数量与输入不一致');
      }
      for (const vector of vectors) {
        if (vector.length !== dims) {
          throw new Error(`Embedding 维度不匹配：期望 ${dims}，实际 ${vector.length}`);
        }
      }

      await upsertVectors(db, {
        bookId,
        embedSig: embed!.embedSig,
        dims,
        items: batch.map((chunk, index) => ({
          chunkId: chunk.id,
          vector: vectors[index],
        })),
      });
      done += batch.length;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      break;
    }

    const progress = baseProgress + 0.7 * (done / workTotal);
    await updateJob(db, {
      bookId,
      stage: 'embedding',
      cursor: done,
      error: null,
    });
    report(onProgress, {
      stage: 'embedding',
      done,
      total: workTotal,
      percent: Math.round(progress * 100),
    });
  }

  const processedCount = await countCurrentSigVectors(db, bookId, embed!.embedSig);
  const failed = Math.max(0, total - processedCount);

  if (aborted) {
    await markStage(db, {
      bookId,
      userId,
      stage: 'partial',
      progress: baseProgress + 0.7 * (processedCount / Math.max(1, total)),
      cursor: processedCount,
      embedSig: keepSig,
      embedDims: keepDims,
      error: '索引已取消',
      onProgress,
      done: processedCount,
      total,
    });
    throw new IndexingCancelledError();
  }

  if (failed > 0) {
    await markStage(db, {
      bookId,
      userId,
      stage: 'partial',
      progress: baseProgress + 0.7 * (processedCount / Math.max(1, total)),
      cursor: processedCount,
      embedSig: keepSig,
      embedDims: keepDims,
      error: lastError ?? `仍有 ${failed} 个块未完成向量化`,
      onProgress,
      done: processedCount,
      total,
    });
    return {
      status: 'partial',
      chunks: total,
      embedded: processedCount,
      failed,
      error: lastError ?? undefined,
    };
  }

  await deleteVectorsExceptSig(db, bookId, embed!.embedSig);
  await markStage(db, {
    bookId,
    userId,
    stage: 'ready',
    progress: 1,
    cursor: total,
    embedSig: embed!.embedSig,
    embedDims: dims,
    onProgress,
    done: total,
    total,
  });

  return {
    status: 'ready',
    chunks: total,
    embedded: processedCount,
    failed: 0,
  };
}

async function countCurrentSigVectors(
  db: DbAdapter,
  bookId: string,
  embedSig: string,
): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM rag_vectors v
     JOIN rag_chunks c ON c.id = v.chunk_id
     WHERE v.book_id = ? AND v.embed_sig = ?`,
    [bookId, embedSig],
  );
  return Number(row?.count ?? 0);
}

export interface BookIndexStatus {
  indexed: boolean;
  status: IndexStage | 'none';
  progress: number;
  embedSig: string | null;
  embedDims: number | null;
  stage: IndexStage | null;
  cursor: number;
  error: string | null;
  updatedAt: string | null;
}

export async function getBookIndexStatus(
  db: DbAdapter,
  params: { bookId: string; userId: string },
): Promise<BookIndexStatus> {
  const book = await db.queryOne<{
    index_status: string | null;
    index_progress: number | null;
    embed_sig: string | null;
    embed_dims: number | null;
  }>(
    'SELECT index_status, index_progress, embed_sig, embed_dims FROM books_meta WHERE id = ? AND user_id = ?',
    [params.bookId, params.userId],
  );
  const job = await db.queryOne<{
    stage: string | null;
    cursor: number | null;
    error: string | null;
    updated_at: string | null;
  }>('SELECT stage, "cursor", error, updated_at FROM index_jobs WHERE book_id = ?', [
    params.bookId,
  ]);

  if (!book) {
    return {
      indexed: false,
      status: 'none',
      progress: 0,
      embedSig: null,
      embedDims: null,
      stage: null,
      cursor: 0,
      error: null,
      updatedAt: null,
    };
  }

  return {
    indexed: true,
    status: (book.index_status as IndexStage | null) ?? 'pending',
    progress: Number(book.index_progress ?? 0),
    embedSig: book.embed_sig,
    embedDims: book.embed_dims,
    stage: (job?.stage as IndexStage | null) ?? null,
    cursor: Number(job?.cursor ?? 0),
    error: job?.error ?? null,
    updatedAt: job?.updated_at ?? null,
  };
}
