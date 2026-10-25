import type { DbAdapter } from '../db/adapter';
import { queryFts } from '../db/repositories/chunks';
import { buildSnippet } from '../reader/progress';
import type { Locator } from '../core/types';

export interface BookSearchResult {
  chunkId: number;
  chapter: string;
  loc: Locator;
  snippet: string;
  score: number;
}

/** 全书关键词检索（FTS5 或 BM25 降级），M0-B 不依赖向量。 */
export async function searchBookKeyword(
  db: DbAdapter,
  params: { bookId: string; query: string; limit?: number },
): Promise<BookSearchResult[]> {
  const query = params.query.trim();
  if (!query) return [];
  const hits = await queryFts(db, {
    query,
    bookId: params.bookId,
    limit: params.limit ?? 30,
  });
  return hits.map((hit) => {
    const snippet = buildSnippet(hit.chunk.text, query);
    return {
      chunkId: hit.chunk.id,
      chapter: hit.chunk.chapter,
      loc: hit.chunk.loc,
      snippet: `${snippet.prefix}${snippet.text}${snippet.suffix}`,
      score: hit.score,
    };
  });
}
