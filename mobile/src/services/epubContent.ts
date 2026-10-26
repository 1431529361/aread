import { File } from 'expo-file-system';
import type { BookRecord } from '../db/repositories/books';
import {
  EpubError,
  openEpub,
  readArchiveBytes,
  readArchiveText,
  type EpubArchive,
} from '../core/epub/parse';
import {
  collectImageSources,
  sanitizeDocument,
  type SanitizedBlock,
} from '../core/epub/sanitize';
import {
  dirname,
  isImagePath,
  mimeForPath,
  resolvePath,
  toDataUri,
} from '../core/epub/resource';
import { fallbackToc, loadEpubToc, type EpubTocEntry } from '../core/epub/toc';

export interface EpubChapterDocument {
  href: string;
  /** spine 顺序，从 0 开始 */
  index: number;
  /** 本章纯文本；块 offset 与索引块共享该坐标系 */
  text: string;
  blocks: SanitizedBlock[];
}

export interface LoadedEpub {
  bookId: string;
  archive: EpubArchive;
  spine: string[];
  toc: EpubTocEntry[];
  title: string;
  author: string;
}

/** 只保留最近几章，避免整本书的消毒结果常驻内存。 */
const CHAPTER_CACHE_LIMIT = 6;

const archiveCache = new Map<string, Promise<LoadedEpub>>();
const chapterCache = new Map<string, EpubChapterDocument>();

function rememberChapter(key: string, chapter: EpubChapterDocument): void {
  chapterCache.delete(key);
  chapterCache.set(key, chapter);
  while (chapterCache.size > CHAPTER_CACHE_LIMIT) {
    const oldest = chapterCache.keys().next().value;
    if (oldest == null) break;
    chapterCache.delete(oldest);
  }
}

/** 删除书籍或重新导入后清理缓存。 */
export function invalidateEpub(bookId: string): void {
  archiveCache.delete(bookId);
  const prefix = `${bookId}::`;
  for (const key of Array.from(chapterCache.keys())) {
    if (key.startsWith(prefix)) chapterCache.delete(key);
  }
}

/** 从已解压的 archive 构建读取上下文（导入时可复用同一份解压结果）。 */
export async function loadEpubFromArchive(
  bookId: string,
  archive: EpubArchive,
): Promise<LoadedEpub> {
  const parsedToc = await loadEpubToc(archive);
  const toc = parsedToc.length > 0 ? parsedToc : fallbackToc(archive.parsed.spine);
  const loaded: LoadedEpub = {
    bookId,
    archive,
    spine: archive.parsed.spine,
    toc,
    title: archive.parsed.metadata.title,
    author: archive.parsed.metadata.author,
  };
  archiveCache.set(bookId, Promise.resolve(loaded));
  return loaded;
}

/** 打开并缓存 EPUB（解压 + 目录解析），正文按章惰性消毒。 */
export async function loadEpub(book: BookRecord): Promise<LoadedEpub> {
  const cached = archiveCache.get(book.id);
  if (cached) return cached;

  const pending = (async (): Promise<LoadedEpub> => {
    if (!book.fileUri) throw new EpubError('CORRUPT', '书籍文件缺失，请重新导入');
    const file = new File(book.fileUri);
    if (!file.exists) throw new EpubError('CORRUPT', '书籍文件已被删除，请重新导入');

    const bytes = await file.bytes();
    const archive = await openEpub(bytes);
    const parsedToc = await loadEpubToc(archive);
    const toc = parsedToc.length > 0 ? parsedToc : fallbackToc(archive.parsed.spine);

    return {
      bookId: book.id,
      archive,
      spine: archive.parsed.spine,
      toc,
      title: archive.parsed.metadata.title || book.title,
      author: archive.parsed.metadata.author || book.author,
    };
  })();

  archiveCache.set(book.id, pending);
  try {
    return await pending;
  } catch (error) {
    archiveCache.delete(book.id);
    throw error;
  }
}

/** 把一章里的图片读成 data URI，保证飞行模式下也能显示。 */
async function resolveChapterImages(
  loaded: LoadedEpub,
  href: string,
  source: string,
): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const baseDir = dirname(href);
  for (const raw of collectImageSources(source)) {
    const path = resolvePath(baseDir, raw);
    if (!isImagePath(path)) continue;
    const bytes = await readArchiveBytes(loaded.archive, path);
    if (!bytes) continue;
    images.set(raw, toDataUri(mimeForPath(path), bytes));
  }
  return images;
}

/** 消毒单个 spine 文档，返回与索引共享 offset 的块列表。 */
export async function loadEpubChapter(
  loaded: LoadedEpub,
  href: string,
): Promise<EpubChapterDocument> {
  const key = `${loaded.bookId}::${href}`;
  const cached = chapterCache.get(key);
  if (cached) {
    rememberChapter(key, cached);
    return cached;
  }

  const source = await readArchiveText(loaded.archive, href);
  if (source == null) throw new EpubError('CORRUPT', `章节文件缺失：${href}`);

  const images = await resolveChapterImages(loaded, href, source);
  const document = sanitizeDocument(source, {
    resolveImage: (src) => images.get(src) ?? null,
  });

  const index = loaded.spine.indexOf(href);
  const chapter: EpubChapterDocument = {
    href,
    index: index < 0 ? 0 : index,
    text: document.text,
    blocks: document.blocks,
  };
  rememberChapter(key, chapter);
  return chapter;
}

/** 索引与字数统计需要整本书的纯文本，按 spine 顺序返回。 */
export async function loadEpubDocuments(
  loaded: LoadedEpub,
): Promise<{ href: string; text: string }[]> {
  const documents: { href: string; text: string }[] = [];
  for (const href of loaded.spine) {
    const chapter = await loadEpubChapter(loaded, href);
    documents.push({ href, text: chapter.text });
  }
  return documents;
}

/** 目录标题优先，其次回退到「第 N 节」。 */
export function epubChapterTitle(loaded: LoadedEpub, href: string, index: number): string {
  const entry = loaded.toc.find((item) => item.href === href);
  if (entry?.title) return entry.title;
  return `第 ${index + 1} 节`;
}