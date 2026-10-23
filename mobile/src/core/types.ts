export type LocatorKind = 'txt' | 'epub';

export interface Locator {
  kind: LocatorKind;
  /** EPUB 的 spine 文档路径；TXT 为 null */
  href: string | null;
  start: number;
  end: number;
}

export interface LocatorRow {
  loc_kind: LocatorKind;
  loc_href: string | null;
  loc_start: number;
  loc_end: number;
}

export type BookFormat = 'txt' | 'epub';

export type RetrievalSource = 'fts' | 'vector';

/** 检索命中的原文片段，携带可跳转 locator。 */
export interface RetrievalHit {
  chunkId: number;
  bookId: string;
  bookTitle?: string;
  chapter: string;
  text: string;
  loc: Locator;
  score: number;
  sources: RetrievalSource[];
}

/** 注入给模型的证据块，citationId 对应答案中的 [Cn]。 */
export interface Evidence {
  citationId: number;
  hit: RetrievalHit;
}

export interface ChunkRecord {
  id: number;
  bookId: string;
  chunkIndex: number;
  chapter: string;
  text: string;
  loc: Locator;
}
