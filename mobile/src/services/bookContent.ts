import { File } from 'expo-file-system';
import type { DbAdapter } from '../db/adapter';
import type { BookFormat } from '../core/types';
import { getBook, type BookRecord } from '../db/repositories/books';
import { loadEpub, type LoadedEpub } from './epubContent';

const CACHE_LIMIT = 2;
const cache = new Map<string, string>();

function remember(bookId: string, text: string): void {
  cache.delete(bookId);
  cache.set(bookId, text);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export function invalidateBookText(bookId: string): void {
  cache.delete(bookId);
}

/** 读取导入时保存的归一化全文；locator 均相对该文本。仅 TXT 使用。 */
export async function loadBookText(book: BookRecord): Promise<string> {
  const cached = cache.get(book.id);
  if (cached != null) {
    remember(book.id, cached);
    return cached;
  }
  if (!book.fileUri) throw new Error('书籍文件缺失，请重新导入');

  const file = new File(book.fileUri);
  if (!file.exists) throw new Error('书籍文件已被删除，请重新导入');
  const text = await file.text();
  remember(book.id, text);
  return text;
}

export async function loadBookTextById(
  db: DbAdapter,
  params: { userId: string; bookId: string },
): Promise<{ book: BookRecord; text: string }> {
  const book = await getBook(db, params);
  if (!book) throw new Error('书籍不存在');
  const text = await loadBookText(book);
  return { book, text };
}

export interface BookContent {
  book: BookRecord;
  format: BookFormat;
  /** 仅 TXT：归一化全文，offset 相对该文本 */
  text: string | null;
  /** 仅 EPUB：解压后的书结构，正文按章惰性消毒 */
  epub: LoadedEpub | null;
}

/** 统一读取书籍内容：TXT 返回全文，EPUB 返回可惰性加载的结构。 */
export async function loadBookContent(book: BookRecord): Promise<BookContent> {
  if (book.format === 'epub') {
    return {
      book,
      format: 'epub',
      text: null,
      epub: await loadEpub(book),
    };
  }
  return {
    book,
    format: 'txt',
    text: await loadBookText(book),
    epub: null,
  };
}

export async function loadBookContentById(
  db: DbAdapter,
  params: { userId: string; bookId: string },
): Promise<BookContent> {
  const book = await getBook(db, params);
  if (!book) throw new Error('书籍不存在');
  return loadBookContent(book);
}