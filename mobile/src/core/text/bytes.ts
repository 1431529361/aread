/**
 * 纯 JS 字节 ↔ 文本 / base64 工具。
 * Hermes 没有 Buffer / atob / btoa，这里全部自己实现，EPUB 解析与 TXT 导入共用。
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Uint8Array → base64（分块拼接，避免超大图片时的 O(n²) 字符串拼接）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  const full = bytes.length - (bytes.length % 3);

  for (; i < full; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(
      B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63],
    );
  }

  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    parts.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==');
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    parts.push(
      B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=',
    );
  }

  return parts.join('');
}

export interface DecodedBytes {
  text: string;
  /** utf-8 / utf-8-bom / utf-16le / utf-16be */
  encoding: string;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean, offset: number): string {
  const codes: number[] = [];
  for (let i = offset; i + 1 < bytes.length; i += 2) {
    codes.push(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
  }
  let result = '';
  const CHUNK = 8192;
  for (let i = 0; i < codes.length; i += CHUNK) {
    result += String.fromCharCode(...codes.slice(i, i + CHUNK));
  }
  return result;
}

/**
 * 宽松 UTF-8 解码：非法序列替换为 U+FFFD，与 TextDecoder 行为一致。
 * EPUB 的 XHTML 声明为 UTF-8 时使用。
 */
export function decodeUtf8Lenient(bytes: Uint8Array, offset = 0): string {
  const codes: number[] = [];
  let i = offset;

  while (i < bytes.length) {
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
      codes.push(0xfffd);
      i++;
      continue;
    }

    let valid = i + needed < bytes.length;
    if (valid) {
      for (let j = 1; j <= needed; j++) {
        const next = bytes[i + j];
        if ((next & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        codePoint = (codePoint << 6) | (next & 0x3f);
      }
    }
    if (valid && (codePoint < min || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))) {
      valid = false;
    }
    if (!valid) {
      codes.push(0xfffd);
      i++;
      continue;
    }

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

/** 按 BOM 与内容启发式解码 XML/XHTML 文本字节。 */
export function decodeXmlBytes(bytes: Uint8Array): DecodedBytes {
  if (hasPrefix(bytes, [0xef, 0xbb, 0xbf])) {
    return { text: decodeUtf8Lenient(bytes, 3), encoding: 'utf-8-bom' };
  }
  if (hasPrefix(bytes, [0xff, 0xfe])) {
    return { text: decodeUtf16(bytes, true, 2), encoding: 'utf-16le' };
  }
  if (hasPrefix(bytes, [0xfe, 0xff])) {
    return { text: decodeUtf16(bytes, false, 2), encoding: 'utf-16be' };
  }
  return { text: decodeUtf8Lenient(bytes, 0), encoding: 'utf-8' };
}