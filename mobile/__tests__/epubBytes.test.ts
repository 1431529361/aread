import { describe, expect, it } from 'vitest';
import { bytesToBase64, decodeUtf8Lenient, decodeXmlBytes } from '../src/core/text/bytes';

function utf16Bytes(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const out: number[] = [];
  if (bom) out.push(littleEndian ? 0xff : 0xfe, littleEndian ? 0xfe : 0xff);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out.push(littleEndian ? code & 0xff : code >> 8, littleEndian ? code >> 8 : code & 0xff);
  }
  return new Uint8Array(out);
}

describe('bytesToBase64', () => {
  it('与 Node Buffer 结果一致（含 1 / 2 / 3 字节余数）', () => {
    const cases: number[][] = [
      [],
      [0x00],
      [0x41, 0x42],
      [0x41, 0x42, 0x43],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      Array.from({ length: 300 }, (_, i) => (i * 37) % 256),
    ];
    for (const values of cases) {
      const bytes = new Uint8Array(values);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('decodeUtf8Lenient', () => {
  it('解码多字节 UTF-8 与代理对', () => {
    const text = '正文与 emoji 😀 混排';
    const bytes = new TextEncoder().encode(text);
    expect(decodeUtf8Lenient(bytes)).toBe(text);
  });

  it('非法序列替换为 U+FFFD 而不是抛错', () => {
    expect(decodeUtf8Lenient(new Uint8Array([0xff, 0x41]))).toBe('\uFFFDA');
    expect(decodeUtf8Lenient(new Uint8Array([0xe4, 0xb8]))).toBe('\uFFFD\uFFFD');
  });
});

describe('decodeXmlBytes', () => {
  it('识别 UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<p>正文</p>')]);
    expect(decodeXmlBytes(bytes)).toEqual({ text: '<p>正文</p>', encoding: 'utf-8-bom' });
  });

  it('识别 UTF-16LE / UTF-16BE', () => {
    expect(decodeXmlBytes(utf16Bytes('<p>书</p>', true, true))).toEqual({
      text: '<p>书</p>',
      encoding: 'utf-16le',
    });
    expect(decodeXmlBytes(utf16Bytes('<p>书</p>', false, true))).toEqual({
      text: '<p>书</p>',
      encoding: 'utf-16be',
    });
  });

  it('无 BOM 时按 UTF-8 处理', () => {
    const bytes = new TextEncoder().encode('<p>plain</p>');
    expect(decodeXmlBytes(bytes)).toEqual({ text: '<p>plain</p>', encoding: 'utf-8' });
  });
});