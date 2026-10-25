import { File } from 'expo-file-system';
import type { DbAdapter } from '../db/adapter';
import { getBook, type BookRecord } from '../db/repositories/books';

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

/** 读取导入时保存的归一化全文；locator 均相对该文本。 */
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
