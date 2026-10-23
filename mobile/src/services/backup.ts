import JSZip from 'jszip';

export const BACKUP_FORMAT = 'ai-reading-assistant-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MANIFEST_FILE = 'manifest.json';
export const BACKUP_DATABASE_FILE = 'data/reading.db';
export const BACKUP_BOOKS_DIR = 'books';
export const MAX_BACKUP_FILE_BYTES = 50 * 1024 * 1024;

export type BookFormat = 'txt' | 'epub';

export interface BackupBookInput {
  id: string;
  title: string;
  originalName: string;
  format: BookFormat;
  fileHash?: string | null;
}

export interface BackupBookEntry extends BackupBookInput {
  size: number;
  path: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  appVersion: string;
  createdAt: string;
  dbVersion: number;
  books: BackupBookEntry[];
}

export interface BackupBookFile extends BackupBookInput {
  data: Uint8Array;
}

export interface BackupArchiveInput {
  database: Uint8Array;
  books: readonly BackupBookFile[];
  dbVersion: number;
  appVersion: string;
  now?: string;
}

export interface BackupContents {
  manifest: BackupManifest;
  database: Uint8Array;
  books: Array<{ entry: BackupBookEntry; data: Uint8Array }>;
}

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupValidationError';
  }
}

const BOOK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_HASH_RE = /^[a-f0-9]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') throw new BackupValidationError(`${label} 必须是字符串`);
  return value;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new BackupValidationError(`${label} 必须是 >= ${min} 的整数`);
  }
  return value;
}

export function bookArchivePath(id: string, format: BookFormat): string {
  return `${BACKUP_BOOKS_DIR}/${id}.${format}`;
}

/** 校验并返回规范化副本；所有字段都不信任归档内容。 */
export function validateBackupManifest(input: unknown): BackupManifest {
  if (!isRecord(input)) throw new BackupValidationError('manifest 不是对象');
  if (input.format !== BACKUP_FORMAT) {
    throw new BackupValidationError('不是本应用的备份文件');
  }
  if (input.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupValidationError(
      `不支持的备份格式版本: ${String(input.formatVersion)}`,
    );
  }

  const appVersion = readString(input, 'appVersion', 'appVersion');
  const createdAt = readString(input, 'createdAt', 'createdAt');
  const dbVersion = readInteger(input, 'dbVersion', 'dbVersion', 0);

  if (!Array.isArray(input.books)) throw new BackupValidationError('books 必须是数组');

  const seenIds = new Set<string>();
  const books: BackupBookEntry[] = input.books.map((raw, index) => {
    const label = `books[${index}]`;
    if (!isRecord(raw)) throw new BackupValidationError(`${label} 不是对象`);

    const id = readString(raw, 'id', `${label}.id`);
    if (!BOOK_ID_RE.test(id)) throw new BackupValidationError(`${label}.id 不合法`);
    if (seenIds.has(id)) throw new BackupValidationError(`重复的书籍 id: ${id}`);
    seenIds.add(id);

    const title = readString(raw, 'title', `${label}.title`);
    const originalName = readString(raw, 'originalName', `${label}.originalName`);
    const format = readString(raw, 'format', `${label}.format`);
    if (format !== 'txt' && format !== 'epub') {
      throw new BackupValidationError(`${label}.format 只能是 txt 或 epub`);
    }

    const size = readInteger(raw, 'size', `${label}.size`, 0);
    if (size > MAX_BACKUP_FILE_BYTES) {
      throw new BackupValidationError(`${label}.size 超过 50MB 上限`);
    }

    const path = readString(raw, 'path', `${label}.path`);
    const expectedPath = bookArchivePath(id, format);
    if (path !== expectedPath) {
      throw new BackupValidationError(`${label}.path 必须是 ${expectedPath}`);
    }

    let fileHash: string | null = null;
    if (raw.fileHash != null) {
      const value = readString(raw, 'fileHash', `${label}.fileHash`);
      if (!FILE_HASH_RE.test(value)) {
        throw new BackupValidationError(`${label}.fileHash 不是合法的 sha256`);
      }
      fileHash = value.toLowerCase();
    }

    return { id, title, originalName, format, fileHash, size, path };
  });

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion,
    createdAt,
    dbVersion,
    books,
  };
}

export async function createBackupArchive(input: BackupArchiveInput): Promise<Uint8Array> {
  if (!(input.database instanceof Uint8Array)) {
    throw new BackupValidationError('database 必须是 Uint8Array');
  }
  if (input.database.byteLength > MAX_BACKUP_FILE_BYTES) {
    throw new BackupValidationError('数据库文件超过 50MB 上限');
  }

  const books: BackupBookFile[] = [];
  const seenIds = new Set<string>();
  for (const book of input.books) {
    if (!(book.data instanceof Uint8Array)) {
      throw new BackupValidationError(`书籍 ${book.id} 的 data 必须是 Uint8Array`);
    }
    if (book.data.byteLength > MAX_BACKUP_FILE_BYTES) {
      throw new BackupValidationError(`书籍 ${book.id} 超过 50MB 上限`);
    }
    if (seenIds.has(book.id)) {
      throw new BackupValidationError(`重复的书籍 id: ${book.id}`);
    }
    seenIds.add(book.id);
    books.push(book);
  }

  const manifest = validateBackupManifest({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: input.appVersion,
    createdAt: input.now ?? new Date().toISOString(),
    dbVersion: input.dbVersion,
    books: books.map((book) => ({
      id: book.id,
      title: book.title,
      originalName: book.originalName,
      format: book.format,
      fileHash: book.fileHash ?? null,
      size: book.data.byteLength,
      path: bookArchivePath(book.id, book.format),
    })),
  });

  const zip = new JSZip();
  zip.file(BACKUP_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  zip.file(BACKUP_DATABASE_FILE, input.database);
  for (const book of books) {
    zip.file(bookArchivePath(book.id, book.format), book.data);
  }

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function readBackupArchive(archive: Uint8Array): Promise<BackupContents> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive);
  } catch {
    throw new BackupValidationError('备份文件不是有效的 ZIP');
  }

  const manifestEntry = zip.file(BACKUP_MANIFEST_FILE);
  if (!manifestEntry) throw new BackupValidationError('备份缺少 manifest.json');

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await manifestEntry.async('string'));
  } catch {
    throw new BackupValidationError('manifest.json 不是有效的 JSON');
  }
  const manifest = validateBackupManifest(rawManifest);

  const databaseEntry = zip.file(BACKUP_DATABASE_FILE);
  if (!databaseEntry) throw new BackupValidationError('备份缺少数据库文件');
  const database = await databaseEntry.async('uint8array');
  if (database.byteLength > MAX_BACKUP_FILE_BYTES) {
    throw new BackupValidationError('数据库文件超过 50MB 上限');
  }

  const books: BackupContents['books'] = [];
  for (const entry of manifest.books) {
    const file = zip.file(entry.path);
    if (!file) throw new BackupValidationError(`备份缺少书籍文件: ${entry.path}`);
    const data = await file.async('uint8array');
    if (data.byteLength !== entry.size) {
      throw new BackupValidationError(`书籍文件大小与 manifest 不一致: ${entry.path}`);
    }
    books.push({ entry, data });
  }

  return { manifest, database, books };
}
