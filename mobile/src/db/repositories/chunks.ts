import type { DbAdapter } from '../adapter';
import { buildFtsQuery } from '../../core/rag/fts';
import { scoreBm25 } from '../../core/rag/bm25';
import { toFtsDocument, tokenize } from '../../core/rag/tokenize';
import { isFts5Available } from '../fts5';
import type { ChunkRecord, Locator } from '../../core/types';

export interface NewChunk {
  index: number;
  chapter: string;
  text: string;
  loc: Locator;
  parentIndex?: number | null;
}

interface ChunkRow {
  id: number;
  book_id: string;
  chunk_index: number;
  chapter: string | null;
  text: string;
  loc_kind: string;
  loc_href: string | null;
  loc_start: number;
  loc_end: number;
  parent_index: number | null;
  book_title?: string | null;
}

export interface FtsHit {
  chunk: ChunkRecord;
  score: number;
}

function toLocator(row: ChunkRow): Locator {
  return {
    kind: row.loc_kind === 'epub' ? 'epub' : 'txt',
    href: row.loc_href,
    start: row.loc_start,
    end: row.loc_end,
  };
}

function mapChunk(row: ChunkRow): ChunkRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    bookTitle: row.book_title ?? undefined,
    chunkIndex: row.chunk_index,
    chapter: row.chapter ?? '',
    text: row.text,
    loc: toLocator(row),
    parentIndex: row.parent_index == null ? null : Number(row.parent_index),
  };
}

/**
 * 全量重建某书的词法索引：清空旧 chunks/fts/vectors 后写入新 chunks 与 FTS。
 * 只在内容变化或首次导入时调用；换 embedding 模型不要调用本函数。
 */
export async function writeLexicalIndex(
  db: DbAdapter,
  params: { userId: string; bookId: string; chunks: readonly NewChunk[] },
): Promise<number[]> {
  const { userId, bookId, chunks } = params;

  return db.transaction(async (tx) => {
    await tx.execute('DELETE FROM rag_fts WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM rag_lexical WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM rag_vectors WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM rag_book_vectors WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM rag_chunks WHERE book_id = ?', [bookId]);

    const useFts = isFts5Available();
    const ids: number[] = [];
    for (const chunk of chunks) {
      const result = await tx.execute(
        `INSERT INTO rag_chunks
          (user_id, book_id, chunk_index, chapter, text, loc_kind, loc_href, loc_start, loc_end, parent_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          bookId,
          chunk.index,
          chunk.chapter,
          chunk.text,
          chunk.loc.kind,
          chunk.loc.href,
          chunk.loc.start,
          chunk.loc.end,
          chunk.parentIndex ?? null,
        ],
      );
      const chunkId = result.lastInsertRowId;
      if (!chunkId) throw new Error('写入 rag_chunks 后未获得 chunk id');
      ids.push(chunkId);

      const tokens = toFtsDocument(chunk.text);
      if (useFts) {
        await tx.execute(
          'INSERT INTO rag_fts (chunk_id, book_id, tokens) VALUES (?, ?, ?)',
          [chunkId, bookId, tokens],
        );
      } else {
        await tx.execute(
          'INSERT INTO rag_lexical (chunk_id, book_id, tokens) VALUES (?, ?, ?)',
          [chunkId, bookId, tokens],
        );
      }
    }

    return ids;
  });
}

export async function deleteBookIndexData(db: DbAdapter, bookId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM rag_fts WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM rag_lexical WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM rag_vectors WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM rag_book_vectors WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM rag_chunks WHERE book_id = ?', [bookId]);
  });
}

export async function loadChunksByIds(
  db: DbAdapter,
  ids: readonly number[],
): Promise<Map<number, ChunkRecord>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const placeholders = unique.map(() => '?').join(',');
  const rows = await db.queryAll<ChunkRow>(
    `SELECT c.*, m.title AS book_title
     FROM rag_chunks c
     LEFT JOIN books_meta m ON m.id = c.book_id AND m.user_id = c.user_id
     WHERE c.id IN (${placeholders})`,
    unique,
  );

  return new Map(rows.map((row) => [row.id, mapChunk(row)]));
}

export async function loadChunksForBook(
  db: DbAdapter,
  bookId: string,
): Promise<ChunkRecord[]> {
  const rows = await db.queryAll<ChunkRow>(
    `SELECT c.*, m.title AS book_title
     FROM rag_chunks c
     LEFT JOIN books_meta m ON m.id = c.book_id AND m.user_id = c.user_id
     WHERE c.book_id = ?
     ORDER BY c.chunk_index`,
    [bookId],
  );
  return rows.map(mapChunk);
}

export async function loadChunksByParents(
  db: DbAdapter,
  params: { bookId: string; parentIndices: readonly number[] },
): Promise<ChunkRecord[]> {
  const parents = [...new Set(params.parentIndices)];
  if (parents.length === 0) return [];

  const placeholders = parents.map(() => '?').join(',');
  const rows = await db.queryAll<ChunkRow>(
    `SELECT c.*, m.title AS book_title
     FROM rag_chunks c
     LEFT JOIN books_meta m ON m.id = c.book_id AND m.user_id = c.user_id
     WHERE c.book_id = ? AND c.parent_index IN (${placeholders})
     ORDER BY c.chunk_index`,
    [params.bookId, ...parents],
  );
  return rows.map(mapChunk);
}

export async function countChunksForBook(db: DbAdapter, bookId: string): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM rag_chunks WHERE book_id = ?',
    [bookId],
  );
  return Number(row?.count ?? 0);
}

/**
 * 词法检索：FTS5 可用时走 MATCH；否则用 rag_lexical + JS BM25。
 * bm25() 越小越相关，对外统一取反成“越大越相关”。
 * query 无有效 token 时返回空数组。
 */
export async function queryFts(
  db: DbAdapter,
  params: { query: string; bookId?: string | null; limit: number },
): Promise<FtsHit[]> {
  if (!isFts5Available()) return queryLexicalFallback(db, params);

  const ftsQuery = buildFtsQuery(params.query);
  if (!ftsQuery) return [];

  const sqlParams: Array<string | number> = [ftsQuery];
  let sql = `SELECT chunk_id AS id, bm25(rag_fts) AS score
             FROM rag_fts
             WHERE rag_fts MATCH ?`;
  if (params.bookId) {
    sql += ' AND book_id = ?';
    sqlParams.push(params.bookId);
  }
  sql += ' ORDER BY bm25(rag_fts) ASC LIMIT ?';
  sqlParams.push(Math.max(1, Math.floor(params.limit)));

  const rows = await db.queryAll<{ id: number; score: number }>(sql, sqlParams);
  if (rows.length === 0) return [];

  const chunks = await loadChunksByIds(db, rows.map((row) => row.id));
  const hits: FtsHit[] = [];
  for (const row of rows) {
    const chunk = chunks.get(row.id);
    if (chunk) hits.push({ chunk, score: -Number(row.score) });
  }
  return hits;
}

interface LexicalRow {
  id: number;
  book_id: string;
  tokens: string;
}

async function queryLexicalFallback(
  db: DbAdapter,
  params: { query: string; bookId?: string | null; limit: number },
): Promise<FtsHit[]> {
  const queryTokens = tokenize(params.query);
  if (queryTokens.length === 0) return [];

  const rows = params.bookId
    ? await db.queryAll<LexicalRow>(
        'SELECT chunk_id AS id, book_id, tokens FROM rag_lexical WHERE book_id = ?',
        [params.bookId],
      )
    : await db.queryAll<LexicalRow>(
        'SELECT chunk_id AS id, book_id, tokens FROM rag_lexical',
      );
  if (rows.length === 0) return [];

  const ranked = scoreBm25(
    queryTokens,
    rows.map((row) => ({
      id: row.id,
      tokens: row.tokens ? row.tokens.split(' ').filter(Boolean) : [],
    })),
    { k1: 1.2, b: 0.75 },
  ).slice(0, Math.max(1, Math.floor(params.limit)));
  if (ranked.length === 0) return [];

  const chunks = await loadChunksByIds(db, ranked.map((item) => item.id));
  const hits: FtsHit[] = [];
  for (const item of ranked) {
    const chunk = chunks.get(item.id);
    if (chunk) hits.push({ chunk, score: item.score });
  }
  return hits;
}
