#!/usr/bin/env node
/**
 * generate-gbk-table.mjs
 *
 * 用 Node.js 内置的 TextDecoder('gb18030')（WHATWG 实现）扫描 GBK/GB18030
 * 的全部字节空间，导出两张紧凑映射表到 src/core/import/gbkTable.ts：
 *
 *   1. 双字节表：GBK 双字节序列 → 码位（126 * 190 = 23940 项，Uint16Array）
 *   2. 四字节分段表：GB18030 四字节指针 → 码位，按「步长恒为 1 的连续段」压缩
 *
 * 脚本可重复执行，结果稳定。
 */

import { writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, '../src/core/import/gbkTable.ts');

const decoder = new TextDecoder('gb18030', { fatal: true });

// ============================================================================
// 1. 双字节表 (GBK double-byte)
// ============================================================================
// 第一字节 0x81-0xFE（126 个），第二字节 0x40-0x7E / 0x80-0xFE（190 个，跳过 0x7F）
// 索引 = (byte1 - 0x81) * 190 + trailOffset

const DOUBLE_BYTE_COUNT = 23940;
const doubleByteTable = new Uint16Array(DOUBLE_BYTE_COUNT);

function doubleByteIndex(byte1, byte2) {
  const leadOffset = byte1 - 0x81;
  const trailOffset =
    byte2 <= 0x7e ? byte2 - 0x40 : 0x3f + (byte2 - 0x80);
  return leadOffset * 190 + trailOffset;
}

let doubleByteMapped = 0;
for (let byte1 = 0x81; byte1 <= 0xfe; byte1++) {
  for (let byte2 = 0x40; byte2 <= 0xfe; byte2++) {
    if (byte2 === 0x7f) continue;
    const idx = doubleByteIndex(byte1, byte2);
    try {
      const char = decoder.decode(new Uint8Array([byte1, byte2]));
      const codePoint = char.codePointAt(0);
      // 双字节只可能落在 BMP 内；超过 BMP 视为无映射
      if (codePoint !== undefined && codePoint <= 0xffff) {
        doubleByteTable[idx] = codePoint;
        doubleByteMapped++;
      }
    } catch {
      // 无映射，保持 0
    }
  }
}

console.log(`Double-byte: ${doubleByteMapped}/${DOUBLE_BYTE_COUNT} mapped`);

// ============================================================================
// 2. 四字节分段表 (GB18030 four-byte)
// ============================================================================
// 指针空间： pointer = ((byte1-0x81)*10 + (byte2-0x30))*1260 + (byte3-0x81)*10 + (byte4-0x30)
// 共 126*10*126*10 = 1587600 个指针。
//
// 实测：有效指针区间内码位严格随指针线性递增（步长恒为 1），
// 因此只需记录每一段的 [起始指针, 起始码位, 长度]，用二分查找定位。

const TOTAL_FOUR_BYTE = 126 * 10 * 126 * 10;

function pointerToFourBytes(pointer) {
  const byte4 = (pointer % 10) + 0x30;
  pointer = Math.floor(pointer / 10);
  const byte3 = (pointer % 126) + 0x81;
  pointer = Math.floor(pointer / 126);
  const byte2 = (pointer % 10) + 0x30;
  pointer = Math.floor(pointer / 10);
  const byte1 = pointer + 0x81;
  return [byte1, byte2, byte3, byte4];
}

function codePointAt(pointer) {
  try {
    const char = decoder.decode(new Uint8Array(pointerToFourBytes(pointer)));
    if (char.length === 0) return null;
    return char.codePointAt(0);
  } catch {
    return null;
  }
}

const segments = [];
let current = null;
let gapCount = 0;

for (let pointer = 0; pointer < TOTAL_FOUR_BYTE; pointer++) {
  const codePoint = codePointAt(pointer);
  if (codePoint === null) {
    if (current) segments.push(current);
    current = null;
    gapCount++;
    continue;
  }
  if (current === null) {
    current = { startPointer: pointer, startCodePoint: codePoint, length: 1 };
  } else if (codePoint === current.startCodePoint + (pointer - current.startPointer)) {
    current.length++;
  } else {
    segments.push(current);
    current = { startPointer: pointer, startCodePoint: codePoint, length: 1 };
  }
}
if (current) segments.push(current);

console.log(`Four-byte segments: ${segments.length} (gap pointers: ${gapCount})`);

// 全量校验：逐指针比对分段表与 TextDecoder 的结果
let verificationErrors = 0;
for (const seg of segments) {
  for (let i = 0; i < seg.length; i++) {
    const pointer = seg.startPointer + i;
    if (codePointAt(pointer) !== seg.startCodePoint + i) verificationErrors++;
  }
}
console.log(
  verificationErrors === 0
    ? 'Four-byte verification: OK'
    : `WARNING: ${verificationErrors} verification errors`,
);

// ============================================================================
// 3. 生成 gbkTable.ts
// ============================================================================

function base64Encode(uint16Array) {
  const bytes = new Uint8Array(uint16Array.buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

const doubleByteBase64 = base64Encode(doubleByteTable);
const segmentsTs = segments
  .map((s) => `  [${s.startPointer}, ${s.startCodePoint}, ${s.length}]`)
  .join(',\n');

const output = `/**
 * 自动生成的 GBK/GB18030 映射表
 *
 * 生成方式：运行 scripts/generate-gbk-table.mjs（基于 Node 的 TextDecoder('gb18030')）
 * 生成时间：${new Date().toISOString()}
 *
 * 本文件由脚本自动生成，请勿手动修改。
 */

// 双字节表：base64 编码的 Uint16Array（小端字节序）
// 索引 = (byte1 - 0x81) * 190 + trailOffset
//   trailOffset: 0x40-0x7E → 0-62，0x80-0xFE → 63-189
// 值 0 表示该序列无映射
export const DOUBLE_BYTE_BASE64 =
  '${doubleByteBase64}';

// 四字节分段表：[起始指针, 起始码位, 长度]
// pointer = ((byte1-0x81)*10 + (byte2-0x30))*1260 + (byte3-0x81)*10 + (byte4-0x30)
// codePoint = 起始码位 + (pointer - 起始指针)
export const FOUR_BYTE_SEGMENTS: ReadonlyArray<readonly [number, number, number]> = [
${segmentsTs},
];
`;

writeFileSync(outputPath, output, 'utf-8');

const stats = statSync(outputPath);
console.log(`Generated ${outputPath}`);
console.log(`File size: ${(stats.size / 1024).toFixed(2)} KB`);
console.log(`Status: ${stats.size < 120 * 1024 ? 'PASS' : 'FAIL (>= 120 KB)'}`);