import { normalizeText } from '../rag/chunk';

export const MAX_TXT_BYTES = 50 * 1024 * 1024;

export type TxtEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

export type TxtDecodeErrorCode = 'TOO_LARGE' | 'NON_UTF8' | 'BINARY';

export class TxtDecodeError extends Error {
  readonly code: TxtDecodeErrorCode;

  constructor(code: TxtDecodeErrorCode, message: string) {
    super(message);
    this.name = 'TxtDecodeError';
    this.code = code;
  }
}

function hasBom(bytes: Uint8Array, bom: readonly number[]): boolean {
  if (bytes.length < bom.length) return false;
  return bom.every((value, index) => bytes[index] === value);
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean, offset: number): string {
  const codes: number[] = [];
  for (let i = offset; i + 1 < bytes.length; i += 2) {
    const code = littleEndian
      ? bytes[i] | (bytes[i + 1] << 8)
      : (bytes[i] << 8) | bytes[i + 1];
    codes.push(code);
  }
  let result = '';
  const CHUNK = 8192;
  for (let i = 0; i < codes.length; i += CHUNK) {
    result += String.fromCharCode(...codes.slice(i, i + CHUNK));
  }
  return result;
}

/** 严格 UTF-8 解码；遇到非法序列返回 null，用于区分 UTF-8 与 GBK。 */
function decodeUtf8Strict(bytes: Uint8Array, offset: number): string | null {
  const codes: number[] = [];
  for (let i = offset; i < bytes.length; ) {
    const first = bytes[i];
    if (first < 0x80) {
      codes.push(first);
      i++;
      continue;
    }

    let needed = 0;
    let codePoint = 0;
    let min = 0;
    if ((first & 0xe0) === 0xc0) {
      needed = 1;
      codePoint = first & 0x1f;
      min = 0x80;
    } else if ((first & 0xf0) === 0xe0) {
      needed = 2;
      codePoint = first & 0x0f;
      min = 0x800;
    } else if ((first & 0xf8) === 0xf0) {
      needed = 3;
      codePoint = first & 0x07;
      min = 0x10000;
    } else {
      return null;
    }

    if (i + needed >= bytes.length) return null;
    for (let j = 1; j <= needed; j++) {
      const next = bytes[i + j];
      if ((next & 0xc0) !== 0x80) return null;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < min || codePoint > 0x10ffff) return null;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
    codes.push(codePoint);
    i += needed + 1;
  }

  let result = '';
  const CHUNK = 8192;
  for (let i = 0; i < codes.length; i += CHUNK) {
    result += String.fromCodePoint(...codes.slice(i, i + CHUNK));
  }
  return result;
}

function looksLikeUtf16(bytes: Uint8Array): 'le' | 'be' | null {
  const sample = Math.min(bytes.length, 4096);
  if (sample < 8) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < sample; i += 2) {
    pairs++;
    if (bytes[i] === 0) evenZeros++;
    if (bytes[i + 1] === 0) oddZeros++;
  }
  if (pairs === 0) return null;
  if (oddZeros / pairs > 0.3 && evenZeros / pairs < 0.05) return 'le';
  if (evenZeros / pairs > 0.3 && oddZeros / pairs < 0.05) return 'be';
  return null;
}

function containsNul(value: string): boolean {
  const sample = Math.min(value.length, 8192);
  for (let i = 0; i < sample; i++) {
    if (value.charCodeAt(i) === 0) return true;
  }
  return false;
}

export interface DecodedTxt {
  text: string;
  encoding: TxtEncoding;
}

/**
 * 导入时只接受 UTF-8 / UTF-16（含 BOM）。
 * GBK/GB18030 会在 M1 通过 iconv 处理；此处明确报错，避免乱码入库。
 */
export function decodeTxtBytes(bytes: Uint8Array): DecodedTxt {
  if (bytes.length > MAX_TXT_BYTES) {
    throw new TxtDecodeError('TOO_LARGE', '文件超过 50MB 上限，请拆分后再导入');
  }
  if (bytes.length === 0) {
    throw new TxtDecodeError('BINARY', '文件为空');
  }

  let text: string;
  let encoding: TxtEncoding;

  if (hasBom(bytes, [0xef, 0xbb, 0xbf])) {
    const decoded = decodeUtf8Strict(bytes, 3);
    if (decoded === null) {
      throw new TxtDecodeError('NON_UTF8', '文件标记为 UTF-8，但内容不是合法 UTF-8');
    }
    text = decoded;
    encoding = 'utf-8-bom';
  } else if (hasBom(bytes, [0xff, 0xfe])) {
    text = decodeUtf16(bytes, true, 2);
    encoding = 'utf-16le';
  } else if (hasBom(bytes, [0xfe, 0xff])) {
    text = decodeUtf16(bytes, false, 2);
    encoding = 'utf-16be';
  } else {
    const utf8 = decodeUtf8Strict(bytes, 0);
    if (utf8 !== null) {
      if (containsNul(utf8)) {
        // 无 BOM 的 UTF-16 往往能被 UTF-8 严格解码成带 NUL 的字符串
        const utf16 = looksLikeUtf16(bytes);
        if (utf16 === 'le') {
          text = decodeUtf16(bytes, true, 0);
          encoding = 'utf-16le';
        } else if (utf16 === 'be') {
          text = decodeUtf16(bytes, false, 0);
          encoding = 'utf-16be';
        } else {
          throw new TxtDecodeError('BINARY', '文件包含二进制内容，无法作为 TXT 阅读');
        }
      } else {
        text = utf8;
        encoding = 'utf-8';
      }
    } else {
      const utf16 = looksLikeUtf16(bytes);
      if (utf16 === 'le') {
        text = decodeUtf16(bytes, true, 0);
        encoding = 'utf-16le';
      } else if (utf16 === 'be') {
        text = decodeUtf16(bytes, false, 0);
        encoding = 'utf-16be';
      } else {
        throw new TxtDecodeError(
          'NON_UTF8',
          '检测到非 UTF-8 编码（可能是 GBK/GB18030）。当前版本仅支持 UTF-8 / UTF-16 TXT，GBK 将在 M1 支持。',
        );
      }
    }
  }

  return { text: normalizeText(text), encoding };
}

/** 从文件名推导书名：去掉扩展名和常见下载后缀空白。 */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.(txt|text)$/i, '').trim();
  return base || '未命名书籍';
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
