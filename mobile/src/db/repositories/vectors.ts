import type { DbAdapter, DbExecutor } from '../adapter';
import {
  bytesToVector,
  centroidVector,
  normalizeVector,
  vectorToBytes,
} from '../../core/rag/vector';
import { asUint8Array } from '../binary';

export interface VectorItem {
  chunkId: number;
  vector: ArrayLike<number>;
}

export interface LoadedVector {
  chunkId: number;
  vector: Float32Array;
}

/** 写入/覆盖某 embed_sig 下的向量；同 chunk 的其他 sig 向量保留。 */
export async function upsertVectors(
  db: DbAdapter,
  params: {
    bookId: string;
    embedSig: string;
    dims: number;
    items: readonly VectorItem[];
  },
): Promise<void> {
  if (params.items.length === 0) return;

  await db.transaction(async (tx) => {
    for (const item of params.items) {
      if (item.vector.length !== params.dims) {
        throw new Error(
          `向量维度不一致：期望 ${params.dims}，实际 ${item.vector.length}`,
        );
      }
      const normalized = normalizeVector(item.vector);
      await tx.execute(
        `INSERT INTO rag_vectors (chunk_id, book_id, embed_sig, dims, vector)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id, embed_sig) DO UPDATE SET
           book_id = excluded.book_id,
           dims = excluded.dims,
           vector = excluded.vector`,
        [
          item.chunkId,
          params.bookId,
          params.embedSig,
          params.dims,
          vectorToBytes(normalized),
        ],
      );
    }
  });
}

function mapVectors(rows: { chunk_id: number; vector: unknown }[]): LoadedVector[] {
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    vector: bytesToVector(asUint8Array(row.vector)),
  }));
}

export async function loadVectorsForBook(
  db: DbExecutor,
  params: { bookId: string; embedSig: string },
): Promise<LoadedVector[]> {
  const rows = await db.queryAll<{ chunk_id: number; vector: unknown }>(
    'SELECT chunk_id, vector FROM rag_vectors WHERE book_id = ? AND embed_sig = ?',
    [params.bookId, params.embedSig],
  );
  return mapVectors(rows);
}

export async function loadVectorsForChunks(
  db: DbAdapter,
  params: { chunkIds: readonly number[]; embedSig: string },
): Promise<LoadedVector[]> {
  const ids = [...new Set(params.chunkIds)];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.queryAll<{ chunk_id: number; vector: unknown }>(
    `SELECT chunk_id, vector FROM rag_vectors
     WHERE embed_sig = ? AND chunk_id IN (${placeholders})`,
    [params.embedSig, ...ids],
  );
  return mapVectors(rows);
}

/** 重建成功后才清理旧 embed_sig 的向量。 */
export async function deleteVectorsExceptSig(
  db: DbExecutor,
  bookId: string,
  activeSig: string,
): Promise<void> {
  await db.execute(
    'DELETE FROM rag_vectors WHERE book_id = ? AND embed_sig != ?',
    [bookId, activeSig],
  );
}

export async function countVectorsForBookSig(
  db: DbAdapter,
  params: { bookId: string; embedSig: string },
): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM rag_vectors WHERE book_id = ? AND embed_sig = ?',
    [params.bookId, params.embedSig],
  );
  return Number(row?.count ?? 0);
}

/** 断点续跑：找出该书当前 sig 下尚未写入向量的 chunk。 */
export async function getChunkIdsMissingVectors(
  db: DbAdapter,
  params: { bookId: string; embedSig: string },
): Promise<number[]> {
  const rows = await db.queryAll<{ id: number }>(
    `SELECT c.id AS id
     FROM rag_chunks c
     LEFT JOIN rag_vectors v ON v.chunk_id = c.id AND v.embed_sig = ?
     WHERE c.book_id = ? AND v.chunk_id IS NULL
     ORDER BY c.chunk_index`,
    [params.embedSig, params.bookId],
  );
  return rows.map((row) => Number(row.id));
}

export interface LoadedBookVector {
  bookId: string;
  vector: Float32Array;
}

export async function upsertBookVector(
  db: DbExecutor,
  params: { bookId: string; embedSig: string; dims: number; vector: ArrayLike<number> },
): Promise<void> {
  const normalized = normalizeVector(params.vector);
  await db.execute(
    `INSERT INTO rag_book_vectors (book_id, embed_sig, dims, vector)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id, embed_sig) DO UPDATE SET
       dims = excluded.dims,
       vector = excluded.vector`,
    [params.bookId, params.embedSig, params.dims, vectorToBytes(normalized)],
  );
}

export async function deleteBookVectorsExceptSig(
  db: DbExecutor,
  bookId: string,
  activeSig: string,
): Promise<void> {
  await db.execute(
    'DELETE FROM rag_book_vectors WHERE book_id = ? AND embed_sig != ?',
    [bookId, activeSig],
  );
}

export async function loadActiveBookVectors(
  db: DbAdapter,
  params: { embedSig: string; dims: number },
): Promise<LoadedBookVector[]> {
  const rows = await db.queryAll<{ book_id: string; vector: unknown }>(
    `SELECT bv.book_id, bv.vector
     FROM rag_book_vectors bv
     JOIN books_meta b ON b.id = bv.book_id
     WHERE bv.embed_sig = ? AND bv.dims = ?
       AND b.embed_sig = bv.embed_sig AND b.index_status = 'ready'`,
    [params.embedSig, params.dims],
  );
  return rows.map((row) => ({
    bookId: row.book_id,
    vector: bytesToVector(asUint8Array(row.vector)),
  }));
}

/** 为迁移前已经完成向量索引的书补建书级路由向量。 */
export async function ensureActiveBookVectors(
  db: DbAdapter,
  params: { embedSig: string; dims: number },
): Promise<void> {
  const missing = await db.queryAll<{ id: string }>(
    `SELECT b.id
     FROM books_meta b
     LEFT JOIN rag_book_vectors bv
       ON bv.book_id = b.id AND bv.embed_sig = ?
     WHERE b.embed_sig = ? AND b.embed_dims = ? AND b.index_status = 'ready'
       AND bv.book_id IS NULL`,
    [params.embedSig, params.embedSig, params.dims],
  );
  for (const row of missing) {
    const vectors = await loadVectorsForBook(db, {
      bookId: row.id,
      embedSig: params.embedSig,
    });
    const centroid = centroidVector(vectors.map((item) => item.vector), params.dims);
    if (!centroid) continue;
    await upsertBookVector(db, {
      bookId: row.id,
      embedSig: params.embedSig,
      dims: params.dims,
      vector: centroid,
    });
  }
}
