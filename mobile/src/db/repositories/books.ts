import type { DbAdapter, DbExecutor } from '../adapter';
import type { BookFormat, IndexStatus, Locator } from '../../core/types';

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  filename: string;
  originalName: string;
  fileUri: string | null;
  fileHash: string | null;
  size: number;
  sizeFormatted: string;
  charCount: number;
  indexStatus: IndexStatus;
  indexProgress: number;
  embedSig: string | null;
  embedDims: number | null;
  readProgress: number;
  lastRead: string | null;
  lastLocator: Locator | null;
  uploadTime: string;
}

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  format: string;
  filename: string;
  original_name: string;
  file_uri: string | null;
  file_hash: string | null;
  size: number;
  size_formatted: string;
  char_count: number | null;
  index_status: string | null;
  index_progress: number | null;
  embed_sig: string | null;
  embed_dims: number | null;
  read_progress: number | null;
  last_read: string | null;
  last_locator: string | null;
  upload_time: string;
}

function parseLocator(raw: string | null): Locator | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Locator>;
    if (
      (value.kind === 'txt' || value.kind === 'epub') &&
      typeof value.start === 'number' &&
      typeof value.end === 'number'
    ) {
      return {
        kind: value.kind,
        href: typeof value.href === 'string' ? value.href : null,
        start: value.start,
        end: value.end,
      };
    }
  } catch {
    // 忽略损坏的 locator，回到进度比例
  }
  return null;
}

function mapBook(row: BookRow): BookRecord {
  return {
    id: row.id,
    title: row.title,
    author: row.author ?? '未知',
    format: row.format === 'epub' ? 'epub' : 'txt',
    filename: row.filename,
    originalName: row.original_name,
    fileUri: row.file_uri,
    fileHash: row.file_hash,
    size: Number(row.size ?? 0),
    sizeFormatted: row.size_formatted,
    charCount: Number(row.char_count ?? 0),
    indexStatus: (row.index_status as IndexStatus | null) ?? 'pending',
    indexProgress: Number(row.index_progress ?? 0),
    embedSig: row.embed_sig,
    embedDims: row.embed_dims == null ? null : Number(row.embed_dims),
    readProgress: Number(row.read_progress ?? 0),
    lastRead: row.last_read,
    lastLocator: parseLocator(row.last_locator),
    uploadTime: row.upload_time,
  };
}

export interface NewBookRecord {
  id: string;
  userId: string;
  title: string;
  author?: string;
  format: BookFormat;
  filename: string;
  originalName: string;
  fileUri: string;
  fileHash: string;
  size: number;
  sizeFormatted: string;
  charCount: number;
  now?: string;
}

export async function createBook(db: DbAdapter, book: NewBookRecord): Promise<void> {
  await db.execute(
    `INSERT INTO books_meta
      (id, user_id, title, author, filename, original_name, format, size, size_formatted,
       upload_time, file_uri, file_hash, char_count, index_status, index_progress)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
    [
      book.id,
      book.userId,
      book.title,
      book.author ?? '未知',
      book.filename,
      book.originalName,
      book.format,
      book.size,
      book.sizeFormatted,
      book.now ?? new Date().toISOString(),
      book.fileUri,
      book.fileHash,
      book.charCount,
    ],
  );
}

export async function listBooks(db: DbAdapter, userId: string): Promise<BookRecord[]> {
  const rows = await db.queryAll<BookRow>(
    `SELECT * FROM books_meta
     WHERE user_id = ?
     ORDER BY CASE WHEN last_read IS NULL THEN 1 ELSE 0 END,
              last_read DESC, upload_time DESC`,
    [userId],
  );
  return rows.map(mapBook);
}

export async function getBook(
  db: DbAdapter,
  params: { userId: string; bookId: string },
): Promise<BookRecord | null> {
  const row = await db.queryOne<BookRow>(
    'SELECT * FROM books_meta WHERE id = ? AND user_id = ?',
    [params.bookId, params.userId],
  );
  return row ? mapBook(row) : null;
}

export async function findBookByHash(
  db: DbExecutor,
  params: { userId: string; fileHash: string },
): Promise<BookRecord | null> {
  const row = await db.queryOne<BookRow>(
    'SELECT * FROM books_meta WHERE user_id = ? AND file_hash = ? LIMIT 1',
    [params.userId, params.fileHash],
  );
  return row ? mapBook(row) : null;
}

export async function saveReadingProgress(
  db: DbAdapter,
  params: {
    userId: string;
    bookId: string;
    progress: number;
    locator: Locator;
    now?: string;
  },
): Promise<void> {
  const progress = Math.max(0, Math.min(1, params.progress));
  await db.execute(
    `UPDATE books_meta
     SET read_progress = ?, last_locator = ?, last_read = ?
     WHERE id = ? AND user_id = ?`,
    [
      progress,
      JSON.stringify(params.locator),
      params.now ?? new Date().toISOString(),
      params.bookId,
      params.userId,
    ],
  );
}

export async function updateBookIndexState(
  db: DbAdapter,
  params: {
    userId: string;
    bookId: string;
    status: IndexStatus;
    progress: number;
  },
): Promise<void> {
  await db.execute(
    `UPDATE books_meta SET index_status = ?, index_progress = ?
     WHERE id = ? AND user_id = ?`,
    [params.status, params.progress, params.bookId, params.userId],
  );
}

export async function deleteBookRecord(
  db: DbAdapter,
  params: { userId: string; bookId: string },
): Promise<void> {
  await db.execute('DELETE FROM books_meta WHERE id = ? AND user_id = ?', [
    params.bookId,
    params.userId,
  ]);
}
