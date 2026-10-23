import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupValidationError,
  MAX_BACKUP_FILE_BYTES,
  createBackupArchive,
  readBackupArchive,
  validateBackupManifest,
} from '../src/services/backup';

function baseManifest(books: unknown[] = []) {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: '1.0.0',
    createdAt: '2026-10-23T00:00:00.000Z',
    dbVersion: 1,
    books,
  };
}

function validBook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'book-1',
    title: '测试书',
    originalName: '测试书.txt',
    format: 'txt',
    fileHash: null,
    size: 3,
    path: 'books/book-1.txt',
    ...overrides,
  };
}

async function buildZip(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('backup archive', () => {
  it('导出后可完整读回', async () => {
    const database = new Uint8Array([0, 1, 2, 3, 255]);
    const bookData = new TextEncoder().encode('第一章 内容');

    const archive = await createBackupArchive({
      database,
      dbVersion: 1,
      appVersion: '1.0.0',
      now: '2026-10-23T00:00:00.000Z',
      books: [
        {
          id: 'book-1',
          title: '测试书',
          originalName: '测试书.txt',
          format: 'txt',
          data: bookData,
        },
      ],
    });

    expect(archive.byteLength).toBeGreaterThan(0);
    expect(archive[0]).toBe(0x50);
    expect(archive[1]).toBe(0x4b);

    const contents = await readBackupArchive(archive);
    expect(contents.manifest).toMatchObject({
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      dbVersion: 1,
      appVersion: '1.0.0',
      createdAt: '2026-10-23T00:00:00.000Z',
    });
    expect(contents.manifest.books[0]).toMatchObject({
      id: 'book-1',
      title: '测试书',
      format: 'txt',
      size: bookData.byteLength,
      path: 'books/book-1.txt',
    });
    expect([...contents.database]).toEqual([...database]);
    expect([...contents.books[0].data]).toEqual([...bookData]);
  });

  it('非 ZIP 数据被拒绝', async () => {
    await expect(readBackupArchive(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      BackupValidationError,
    );
  });

  it('缺少 manifest 或数据库文件被拒绝', async () => {
    const noManifest = await buildZip({ 'data/reading.db': new Uint8Array([1]) });
    await expect(readBackupArchive(noManifest)).rejects.toThrow(/manifest/);

    const noDatabase = await buildZip({
      'manifest.json': JSON.stringify(baseManifest()),
    });
    await expect(readBackupArchive(noDatabase)).rejects.toThrow(/数据库/);
  });

  it('书籍文件大小与 manifest 不一致被拒绝', async () => {
    const archive = await buildZip({
      'manifest.json': JSON.stringify(baseManifest([validBook({ size: 5 })])),
      'data/reading.db': new Uint8Array([1]),
      'books/book-1.txt': new Uint8Array([1, 2, 3]),
    });

    await expect(readBackupArchive(archive)).rejects.toThrow(/大小/);
  });
});

describe('validateBackupManifest', () => {
  it('接受合法 manifest', () => {
    const manifest = validateBackupManifest(baseManifest([validBook()]));
    expect(manifest.books).toHaveLength(1);
  });

  it('拒绝其他应用的备份', () => {
    expect(() => validateBackupManifest({ ...baseManifest(), format: 'other' })).toThrow(
      BackupValidationError,
    );
  });

  it('拒绝路径穿越', () => {
    expect(() =>
      validateBackupManifest(baseManifest([validBook({ path: '../../evil.txt' })])),
    ).toThrow(/path/);
  });

  it('拒绝重复书籍 id', () => {
    expect(() =>
      validateBackupManifest(baseManifest([validBook(), validBook({ title: '重复' })])),
    ).toThrow(/重复/);
  });

  it('拒绝超过 50MB 的文件声明', () => {
    expect(() =>
      validateBackupManifest(
        baseManifest([validBook({ size: MAX_BACKUP_FILE_BYTES + 1 })]),
      ),
    ).toThrow(/50MB/);
  });

  it('拒绝非法书籍格式', () => {
    expect(() =>
      validateBackupManifest(baseManifest([validBook({ format: 'pdf' })])),
    ).toThrow(/txt 或 epub/);
  });
});
