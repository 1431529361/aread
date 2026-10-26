/**
 * GBK/GB18030 解码器
 *
 * 纯 JS 实现，不依赖 Buffer、TextDecoder 或 DOM API。
 * 适用于 Hermes (React Native) 环境。
 */

import { DOUBLE_BYTE_BASE64, FOUR_BYTE_SEGMENTS } from './gbkTable';

// 缓存解码后的双字节表
let doubleByteCache: Uint16Array | null = null;

/**
 * 自定义 base64 解码器（不依赖 atob）
 */
function decodeBase64(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  const bytes = new Uint8Array((base64.length * 3) / 4);
  let ptr = 0;

  for (let i = 0; i < base64.length; i += 4) {
    const a = lookup[base64.charCodeAt(i)];
    const b = lookup[base64.charCodeAt(i + 1)];
    const c = lookup[base64.charCodeAt(i + 2)];
    const d = lookup[base64.charCodeAt(i + 3)];

    bytes[ptr++] = (a << 2) | (b >> 4);
    if (base64[i + 2] !== '=') bytes[ptr++] = ((b & 15) << 4) | (c >> 2);
    if (base64[i + 3] !== '=') bytes[ptr++] = ((c & 3) << 6) | d;
  }

  return bytes.slice(0, ptr);
}

/**
 * 获取双字节表（懒加载并缓存）。
 *
 * 生成脚本与运行时都直接复用 Uint16Array 的原生字节序，因此这里无需再做端序转换。
 */
function getDoubleByteTable(): Uint16Array {
  if (doubleByteCache === null) {
    const bytes = decodeBase64(DOUBLE_BYTE_BASE64);
    doubleByteCache = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  }
  return doubleByteCache;
}

/**
 * 计算双字节索引
 */
function doubleByteIndex(byte1: number, byte2: number): number {
  const leadOffset = byte1 - 0x81;
  let trailOffset: number;
  if (byte2 >= 0x40 && byte2 <= 0x7e) {
    trailOffset = byte2 - 0x40;
  } else {
    // 0x80-0xFE
    trailOffset = 0x3f + (byte2 - 0x80);
  }
  return leadOffset * 190 + trailOffset;
}

/**
 * 查找四字节码位
 *
 * 分段表每段的码位都随指针线性递增（步长恒为 1），因此二分找到所属段即可直接计算。
 */
function lookupFourByte(byte1: number, byte2: number, byte3: number, byte4: number): number | null {
  const pointer = ((byte1 - 0x81) * 10 + (byte2 - 0x30)) * 1260 + (byte3 - 0x81) * 10 + (byte4 - 0x30);

  let left = 0;
  let right = FOUR_BYTE_SEGMENTS.length - 1;

  while (left <= right) {
    const mid = (left + right) >>> 1;
    const [startPointer, startCodePoint, length] = FOUR_BYTE_SEGMENTS[mid];

    if (pointer < startPointer) {
      right = mid - 1;
    } else if (pointer >= startPointer + length) {
      left = mid + 1;
    } else {
      return startCodePoint + (pointer - startPointer);
    }
  }

  return null;
}

/**
 * 解码 GBK / GB18030 字节序列
 *
 * @param bytes GBK 或 GB18030 编码的字节（ASCII 与双字节、四字节混排均可）
 * @returns 解码后的字符串；遇到非法字节序列返回 null
 */
export function decodeGb18030(bytes: Uint8Array): string | null {
  const table = getDoubleByteTable();
  const codes: number[] = [];

  for (let i = 0; i < bytes.length; ) {
    const byte1 = bytes[i];

    // ASCII
    if (byte1 < 0x80) {
      codes.push(byte1);
      i++;
      continue;
    }

    // 双字节 GBK
    if (byte1 >= 0x81 && byte1 <= 0xfe) {
      if (i + 1 >= bytes.length) return null;
      const byte2 = bytes[i + 1];

      // 检查第二字节是否合法
      if ((byte2 >= 0x40 && byte2 <= 0x7e) || (byte2 >= 0x80 && byte2 <= 0xfe)) {
        const idx = doubleByteIndex(byte1, byte2);
        const codePoint = table[idx];
        if (codePoint === 0) return null; // 无映射
        codes.push(codePoint);
        i += 2;
        continue;
      }

      // 可能是四字节序列
      if (byte2 >= 0x30 && byte2 <= 0x39) {
        if (i + 3 >= bytes.length) return null;
        const byte3 = bytes[i + 2];
        const byte4 = bytes[i + 3];

        // 检查第三、四字节是否合法
        if (byte3 >= 0x81 && byte3 <= 0xfe && byte4 >= 0x30 && byte4 <= 0x39) {
          const codePoint = lookupFourByte(byte1, byte2, byte3, byte4);
          if (codePoint === null) return null; // 无映射
          codes.push(codePoint);
          i += 4;
          continue;
        }
      }

      return null; // 非法序列
    }

    return null; // 非法字节
  }

  // 构建字符串（避免 O(n²)）
  let result = '';
  const CHUNK = 8192;
  for (let i = 0; i < codes.length; i += CHUNK) {
    result += String.fromCodePoint(...codes.slice(i, i + CHUNK));
  }

  return result;
}

/**
 * 二进制文件快速判定。
 *
 * 纯文本（含 GBK 中文）里出现 ASCII 控制字符的概率极低，
 * 而二进制格式（PDF / ZIP / 图片等）的控制字符占比通常远高于 5%。
 * 用它把误扩展名的二进制文件挡在 GB18030 解码之前，避免写入乱码正文。
 *
 * @param bytes 待检测的字节序列
 * @returns 如果看起来是二进制返回 true
 */
export function looksLikeBinaryText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  const sample = Math.min(bytes.length, 65536);
  let control = 0;
  for (let i = 0; i < sample; i++) {
    const byte = bytes[i];
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control++;
  }
  return control / sample > 0.05;
}
