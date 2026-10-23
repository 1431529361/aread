import type { DbAdapter } from '../db/adapter';
import { loadChunksByIds, queryFts } from '../db/repositories/chunks';
import { loadVectorsForBook, loadVectorsForChunks } from '../db/repositories/vectors';
import { rrfFuse } from '../core/rag/rrf';
import { rankByDot } from '../core/rag/vector';
import { EMBED_DIMS } from '../core/embedding/signature';
import type { ChunkRecord, RetrievalHit, RetrievalSource } from '../core/types';

export type QueryEmbedder = (query: string) => Promise<ArrayLike<number>>;

export interface RetrievalOptions {
  db: DbAdapter;
  query: string;
  topK?: number;
  recallN?: number;
  /** 查询向量化；为空表示当前仅有词法索引（降级为 FTS） */
  embedQuery?: QueryEmbedder | null;
  /** 当前 active embed_sig；与向量表不匹配时跳过向量路 */
  activeSig?: string | null;
  dims?: number;
}

export const RECALL_N = 20;
export const LIBRARY_FTS_CANDIDATES = 200;

function toHit(
  chunk: ChunkRecord,
  score: number,
  sources: RetrievalSource[],
): RetrievalHit {
  return {
    chunkId: chunk.id,
    bookId: chunk.bookId,
    bookTitle: chunk.bookTitle,
    chapter: chunk.chapter,
    text: chunk.text,
    loc: chunk.loc,
    score,
    sources,
  };
}

interface RankedChunk {
  id: number;
  chunk: ChunkRecord;
}

async function vectorCandidatesInBook(
  db: DbAdapter,
  params: {
    bookId: string;
    embedSig: string;
    queryVector: ArrayLike<number>;
    limit: number;
  },
): Promise<RankedChunk[]> {
  const vectors = await loadVectorsForBook(db, {
    bookId: params.bookId,
    embedSig: params.embedSig,
  });
  if (vectors.length === 0) return [];

  const ranked = rankByDot(
    params.queryVector,
    vectors.map((item) => ({ chunkId: item.chunkId, vector: item.vector })),
    params.limit,
  );
  const chunks = await loadChunksByIds(db, ranked.map((item) => Number(item.chunkId)));

  return ranked
    .map((item) => {
      const chunk = chunks.get(Number(item.chunkId));
      return chunk ? { id: chunk.id, chunk } : null;
    })
    .filter((item): item is RankedChunk => item !== null);
}

async function vectorCandidatesInLibrary(
  db: DbAdapter,
  params: {
    candidates: readonly ChunkRecord[];
    embedSig: string;
    queryVector: ArrayLike<number>;
    perBookLimit: number;
  },
): Promise<RankedChunk[]> {
  const byBook = new Map<string, number[]>();
  for (const chunk of params.candidates) {
    const ids = byBook.get(chunk.bookId) ?? [];
    ids.push(chunk.id);
    byBook.set(chunk.bookId, ids);
  }

  const results: RankedChunk[] = [];
  for (const chunkIds of byBook.values()) {
    const vectors = await loadVectorsForChunks(db, {
      chunkIds,
      embedSig: params.embedSig,
    });
    if (vectors.length === 0) continue;
    const ranked = rankByDot(
      params.queryVector,
      vectors.map((item) => ({ chunkId: item.chunkId, vector: item.vector })),
      params.perBookLimit,
    );
    const chunkMap = new Map(
      params.candidates.map((chunk) => [chunk.id, chunk] as const),
    );
    for (const item of ranked) {
      const chunk = chunkMap.get(Number(item.chunkId));
      if (chunk) results.push({ id: chunk.id, chunk });
    }
  }
  return results;
}

function fuse(
  fts: readonly RankedChunk[],
  vectors: readonly RankedChunk[] | null,
  topK: number,
): RetrievalHit[] {
  if (fts.length === 0 && (!vectors || vectors.length === 0)) return [];

  const chunkById = new Map<number, ChunkRecord>();
  for (const item of fts) chunkById.set(item.id, item.chunk);
  for (const item of vectors ?? []) chunkById.set(item.id, item.chunk);

  const ftsIds = new Set(fts.map((item) => item.id));
  const vectorIds = new Set((vectors ?? []).map((item) => item.id));

  return rrfFuse([fts, vectors ?? []], topK).map(({ item, score }) => {
    const sources: RetrievalSource[] = [];
    if (ftsIds.has(item.id)) sources.push('fts');
    if (vectorIds.has(item.id)) sources.push('vector');
    return toHit(chunkById.get(item.id)!, score, sources);
  });
}

async function queryVectorIfAvailable(
  options: RetrievalOptions,
): Promise<ArrayLike<number> | null> {
  if (!options.embedQuery || !options.activeSig) return null;
  try {
    const vector = await options.embedQuery(options.query);
    const dims = options.dims ?? EMBED_DIMS;
    if (vector.length !== dims) return null;
    return vector;
  } catch {
    return null;
  }
}

/** 单书混合检索：FTS Top-20 + 该书向量 Top-20 → RRF Top-K。 */
export async function retrieveInBook(
  bookId: string,
  options: RetrievalOptions,
): Promise<RetrievalHit[]> {
  const topK = options.topK ?? 5;
  const recallN = options.recallN ?? RECALL_N;
  const queryVector = await queryVectorIfAvailable(options);

  let fts: RankedChunk[] = [];
  try {
    const ftsHits = await queryFts(options.db, {
      query: options.query,
      bookId,
      limit: recallN,
    });
    fts = ftsHits.map((hit) => ({ id: hit.chunk.id, chunk: hit.chunk }));
  } catch {
    fts = [];
  }

  let vectors: RankedChunk[] | null = null;
  if (queryVector && options.activeSig) {
    try {
      vectors = await vectorCandidatesInBook(options.db, {
        bookId,
        embedSig: options.activeSig,
        queryVector,
        limit: recallN,
      });
    } catch {
      vectors = null;
    }
  }

  return fuse(fts, vectors, topK);
}

/**
 * 书库检索：FTS 粗筛 200 条 → 按书分组加载候选向量精排 → RRF Top-K。
 * 没有 FTS 候选时不做全库向量扫描，避免内存与延迟失控。
 */
export async function retrieveInLibrary(
  options: RetrievalOptions,
): Promise<RetrievalHit[]> {
  const topK = options.topK ?? 5;
  const queryVector = await queryVectorIfAvailable(options);

  let fts: RankedChunk[] = [];
  try {
    const ftsHits = await queryFts(options.db, {
      query: options.query,
      limit: LIBRARY_FTS_CANDIDATES,
    });
    fts = ftsHits.map((hit) => ({ id: hit.chunk.id, chunk: hit.chunk }));
  } catch {
    fts = [];
  }

  let vectors: RankedChunk[] | null = null;
  if (queryVector && options.activeSig && fts.length > 0) {
    try {
      vectors = await vectorCandidatesInLibrary(options.db, {
        candidates: fts.map((item) => item.chunk),
        embedSig: options.activeSig,
        queryVector,
        perBookLimit: options.recallN ?? RECALL_N,
      });
    } catch {
      vectors = null;
    }
  }

  return fuse(fts, vectors, topK);
}
