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
import { sha256Hex, sha256HexBytes } from '../core/embedding/sha256';
import {
  decodeTxtBytes,
  formatFileSize,
  MAX_TXT_BYTES,
  titleFromFilename,
  type TxtEncoding,
} from '../core/import/txt';
import { chunkEpubDocuments } from '../core/rag/epubChunks';
import { normalizeText } from '../core/rag/chunk';
import type { BookFormat } from '../core/types';
import { openEpub } from '../core/epub/parse';
import {
  invalidateEpub,
  loadEpubDocuments,
  loadEpubFromArchive,
} from './epubContent';
import { indexBook, type IndexProgress } from './indexing';

export const BOOKS_DIR = 'books';

/** EPUB 常带图片，上限放宽到 100MB（TXT 仍为 50MB）。 */
export const MAX_EPUB_BYTES = 100 * 1024 * 1024;

export interface PickedBook {
  uri: string;
  name: string;
  size: number;
}

/** 统一的文件选择入口：不按 MIME 过滤，改由扩展名判定，兼容各厂商文件管理器。 */
export async function pickBookFile(): Promise<PickedBook | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
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

export type ImportBookResult =
  | {
      status: 'imported';
      book: BookRecord;
      format: BookFormat;
      /** TXT 的检测编码；EPUB 为 null */
      encoding: TxtEncoding | null;
    }
  | { status: 'duplicate'; book: BookRecord };

export interface ImportBookParams {
  db: DbAdapter;
  userId?: string;
  asset: PickedBook;
  onProgress?: (progress: IndexProgress) => void;
}

function newBookId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function booksDirectory(): Directory {
  const dir = new Directory(Paths.document, BOOKS_DIR);
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
}

/**
 * 导入 TXT：
 * 1. 读取字节并按 UTF-8 / UTF-16 / GB18030 解码
 * 2. 写一份归一化副本到 document/books/<id>.txt（locator 以该副本为准）
 * 3. 建 books_meta 记录并同步完成词法索引（M0-B 起不依赖向量）
 */
export async function importTxtBook(params: ImportBookParams): Promise<ImportBookResult> {
  const { db, asset } = params;
  const userId = params.userId ?? LOCAL_USER_ID;

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
  const target = new File(booksDirectory(), `${id}.txt`);
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
    await updateBookIndexState(db, { userId, bookId: id, status: 'partial', progress: 0 });
    throw new Error(
      `书籍已导入，但索引失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const book = await getBook(db, { userId, bookId: id });
  if (!book) throw new Error('导入完成但未找到书籍记录');
  return { status: 'imported', book, format: 'txt', encoding: decoded.encoding };
}

/**
 * 导入 EPUB：
 * 1. 先解压并做 DRM 检测（Adobe/加密正文直接拒绝）
 * 2. 保存原始 .epub 到 document/books/<id>.epub
 * 3. 按 spine 文档消毒后分块建索引（locator = href + 文档内 offset）
 */
export async function importEpubBook(params: ImportBookParams): Promise<ImportBookResult> {
  const { db, asset } = params;
  const userId = params.userId ?? LOCAL_USER_ID;

  if (asset.size > MAX_EPUB_BYTES) {
    throw new Error('EPUB 超过 100MB 上限，请拆分后再导入');
  }

  const picked = new File(asset.uri);
  const bytes = await picked.bytes();
  if (bytes.byteLength > MAX_EPUB_BYTES) {
    throw new Error('EPUB 超过 100MB 上限，请拆分后再导入');
  }

  // openEpub 会在 DRM / 非 EPUB / 空 spine 时抛出带中文说明的 EpubError
  const archive = await openEpub(bytes);

  const fileHash = sha256HexBytes(bytes);
  const duplicate = await findBookByHash(db, { userId, fileHash });
  if (duplicate) {
    invalidateEpub(duplicate.id);
    return { status: 'duplicate', book: duplicate };
  }

  const id = newBookId();
  const target = new File(booksDirectory(), `${id}.epub`);
  target.create({ overwrite: true, intermediates: true });
  await target.write(bytes);

  try {
    const loaded = await loadEpubFromArchive(id, archive);
    const documents = await loadEpubDocuments(loaded);
    const charCount = documents.reduce((sum, document) => sum + document.text.length, 0);
    if (charCount === 0) throw new Error('EPUB 没有可阅读的正文');

    await createBook(db, {
      id,
      userId,
      title: loaded.title.trim() || titleFromFilename(asset.name),
      author: loaded.author.trim() || undefined,
      format: 'epub',
      filename: `${id}.epub`,
      originalName: asset.name,
      fileUri: target.uri,
      fileHash,
      size: bytes.byteLength,
      sizeFormatted: formatFileSize(bytes.byteLength),
      charCount,
    });

    await indexBook({
      db,
      userId,
      bookId: id,
      chunks: chunkEpubDocuments(documents),
      charCount,
      embed: null,
      onProgress: params.onProgress,
    });
  } catch (error) {
    await deleteBookRecordAndFile(db, { userId, bookId: id, file: target });
    throw error instanceof Error && error.message === 'EPUB 没有可阅读的正文'
      ? error
      : new Error(
          `EPUB 已解析，但导入失败：${error instanceof Error ? error.message : String(error)}`,
        );
  }

  const book = await getBook(db, { userId, bookId: id });
  if (!book) throw new Error('导入完成但未找到书籍记录');
  return { status: 'imported', book, format: 'epub', encoding: null };
}

async function deleteBookRecordAndFile(
  db: DbAdapter,
  params: { userId: string; bookId: string; file: File },
): Promise<void> {
  invalidateEpub(params.bookId);
  try {
    await db.execute('DELETE FROM books_meta WHERE id = ? AND user_id = ?', [
      params.bookId,
      params.userId,
    ]);
    await deleteBookIndexData(db, params.bookId);
  } catch {
    // 清理失败不覆盖原始错误
  }
  try {
    if (params.file.exists) params.file.delete();
  } catch {
    // 文件已不存在时忽略
  }
}

/** 按扩展名分派到对应的导入流程。 */
export async function importBook(params: ImportBookParams): Promise<ImportBookResult> {
  const extension = normalizeExtension(params.asset.name);
  if (extension === 'epub') return importEpubBook(params);
  if (extension === 'txt' || extension === 'text') return importTxtBook(params);
  throw new Error('当前仅支持导入 .txt 与 .epub 文件');
}

/** 删除书：文件、索引、会话、划线、任务缓存全部级联清理。 */
export async function deleteBookCompletely(
  db: DbAdapter,
  params: { userId?: string; book: BookRecord },
): Promise<void> {
  const userId = params.userId ?? LOCAL_USER_ID;
  const bookId = params.book.id;

  invalidateEpub(bookId);

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