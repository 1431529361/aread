import { Directory, File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import type { DbAdapter } from '../db/adapter';
import { LOCAL_USER_ID } from '../db/schema';
import {
  createBook,
  findBookByHash,
  getBook,
  updateBookIndexState,
  type BookRecord,
} from '../db/repositories/books';
import { deleteBookIndexData } from '../db/repositories/chunks';
import { sha256Hex } from '../core/embedding/sha256';
import {
  decodeTxtBytes,
  formatFileSize,
  MAX_TXT_BYTES,
  titleFromFilename,
  type TxtEncoding,
} from '../core/import/txt';
import { normalizeText } from '../core/rag/chunk';
import { indexBook, type IndexProgress } from './indexing';

export const BOOKS_DIR = 'books';

export interface PickedTxt {
  uri: string;
  name: string;
  size: number;
}

export async function pickTxtFile(): Promise<PickedTxt | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['text/plain', 'text/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.name,
    size: asset.size ?? 0,
  };
}

export type ImportTxtResult =
  | { status: 'imported'; book: BookRecord; encoding: TxtEncoding }
  | { status: 'duplicate'; book: BookRecord };

export interface ImportTxtParams {
  db: DbAdapter;
  userId?: string;
  asset: PickedTxt;
  onProgress?: (progress: IndexProgress) => void;
}

function newBookId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * 导入 TXT：
 * 1. 读取字节并按 UTF-8/UTF-16 解码（GBK 明确拒绝，留待 M1）
 * 2. 写一份归一化副本到 document/books/<id>.txt（locator 以该副本为准）
 * 3. 建 books_meta 记录并同步完成词法索引（M0-B 不依赖向量）
 */
export async function importTxtBook(params: ImportTxtParams): Promise<ImportTxtResult> {
  const { db, asset } = params;
  const userId = params.userId ?? LOCAL_USER_ID;

  if (normalizeExtension(asset.name) !== 'txt') {
    throw new Error('当前仅支持导入 .txt 文件（EPUB 将在 M1 支持）');
  }
  if (asset.size > MAX_TXT_BYTES) {
    throw new Error('文件超过 50MB 上限，请拆分后再导入');
  }

  const picked = new File(asset.uri);
  const bytes = await picked.bytes();
  if (bytes.byteLength > MAX_TXT_BYTES) {
    throw new Error('文件超过 50MB 上限，请拆分后再导入');
  }

  const decoded = decodeTxtBytes(bytes);
  // 归一化换行并去 BOM：文件、阅读器与索引必须共用同一套字符 offset
  const text = normalizeText(decoded.text);
  if (!text.trim()) throw new Error('文件没有可阅读的正文');

  const fileHash = sha256Hex(text);
  const duplicate = await findBookByHash(db, { userId, fileHash });
  if (duplicate) return { status: 'duplicate', book: duplicate };

  const id = newBookId();
  const dir = new Directory(Paths.document, BOOKS_DIR);
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });

  const target = new File(dir, `${id}.txt`);
  target.create({ overwrite: true, intermediates: true });
  await target.write(text);

  try {
    await createBook(db, {
      id,
      userId,
      title: titleFromFilename(asset.name),
      format: 'txt',
      filename: `${id}.txt`,
      originalName: asset.name,
      fileUri: target.uri,
      fileHash,
      size: bytes.byteLength,
      sizeFormatted: formatFileSize(bytes.byteLength),
      charCount: text.length,
    });
  } catch (error) {
    try {
      if (target.exists) target.delete();
    } catch {
      // 清理失败不影响原始错误
    }
    throw error;
  }

  try {
    await indexBook({
      db,
      userId,
      bookId: id,
      content: text,
      charCount: text.length,
      strategy: 'parent-child',
      embed: null,
      onProgress: params.onProgress,
    });
  } catch (error) {
    await updateBookIndexState(db, {
      userId,
      bookId: id,
      status: 'partial',
      progress: 0,
    });
    const book = await getBook(db, { userId, bookId: id });
    throw new Error(
      `书籍已导入，但索引失败：${error instanceof Error ? error.message : String(error)}${
        book ? '' : '（记录未找到）'
      }`,
    );
  }

  const book = await getBook(db, { userId, bookId: id });
  if (!book) throw new Error('导入完成但未找到书籍记录');
  return { status: 'imported', book, encoding: decoded.encoding };
}

/** 删除书：文件、索引、会话、划线、任务缓存全部级联清理。 */
export async function deleteBookCompletely(
  db: DbAdapter,
  params: { userId?: string; book: BookRecord },
): Promise<void> {
  const userId = params.userId ?? LOCAL_USER_ID;
  const bookId = params.book.id;

  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE book_id = ?)', [bookId]);
    await tx.execute('DELETE FROM conversations WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM highlights WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM task_node_cache WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM task_runs WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM task_results WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM index_jobs WHERE book_id = ?', [bookId]);
    await tx.execute('DELETE FROM books_meta WHERE id = ? AND user_id = ?', [bookId, userId]);
  });

  // rag 表在 deleteBookIndexData 里单独事务处理，避免与上面的外键顺序耦合
  await deleteBookIndexData(db, bookId);

  if (params.book.fileUri) {
    try {
      const file = new File(params.book.fileUri);
      if (file.exists) file.delete();
    } catch {
      // 文件已不存在时忽略
    }
  }
}
