import { describe, expect, it } from 'vitest';
import {
  decodeTxtBytes,
  formatFileSize,
  titleFromFilename,
  TxtDecodeError,
} from '../src/core/import/txt';

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf16Bytes(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const bytes: number[] = [];
  if (bom) bytes.push(littleEndian ? 0xff : 0xfe, littleEndian ? 0xfe : 0xff);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (littleEndian) bytes.push(code & 0xff, code >> 8);
    else bytes.push(code >> 8, code & 0xff);
  }
  return new Uint8Array(bytes);
}

describe('decodeTxtBytes', () => {
  it('解码 UTF-8 并统一换行符', () => {
    const decoded = decodeTxtBytes(utf8Bytes('第一行\r\n第二行\r第三行'));
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.text).toBe('第一行\n第二行\n第三行');
  });

  it('识别 UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes('正文')]);
    const decoded = decodeTxtBytes(bytes);
    expect(decoded.encoding).toBe('utf-8-bom');
    expect(decoded.text).toBe('正文');
  });

  it('识别带 BOM 的 UTF-16LE / UTF-16BE', () => {
    const le = decodeTxtBytes(utf16Bytes('阅读器', true, true));
    expect(le).toEqual({ text: '阅读器', encoding: 'utf-16le' });

    const be = decodeTxtBytes(utf16Bytes('阅读器', false, true));
    expect(be).toEqual({ text: '阅读器', encoding: 'utf-16be' });
  });

  it('无 BOM 的 ASCII UTF-16LE 会被 NUL 模式识别', () => {
    const decoded = decodeTxtBytes(utf16Bytes('ABC DEF GHI', true, false));
    expect(decoded).toEqual({ text: 'ABC DEF GHI', encoding: 'utf-16le' });
  });

  it('GBK 字节明确报错，不把乱码写入书库', () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // “中文”的 GBK 编码
    try {
      decodeTxtBytes(gbk);
      throw new Error('应当抛出 TxtDecodeError');
    } catch (error) {
      expect(error).toBeInstanceOf(TxtDecodeError);
      expect((error as TxtDecodeError).code).toBe('NON_UTF8');
      expect((error as TxtDecodeError).message).toContain('GBK');
    }
  });

  it('二进制内容会被拒绝', () => {
    const binary = new Uint8Array([0x61, 0x62, 0x63, 0x00, 0x64, 0x65, 0x66]);
    expect(() => decodeTxtBytes(binary)).toThrow(TxtDecodeError);
    try {
      decodeTxtBytes(binary);
    } catch (error) {
      expect((error as TxtDecodeError).code).toBe('BINARY');
    }
  });

  it('空文件与非法 UTF-8 都会报错', () => {
    expect(() => decodeTxtBytes(new Uint8Array())).toThrow(TxtDecodeError);
    expect(() =>
      decodeTxtBytes(new Uint8Array([0xff, 0xff, 0xff])),
    ).toThrow(TxtDecodeError);
  });
});

describe('文件名与大小', () => {
  it('从文件名推导书名', () => {
    expect(titleFromFilename('/sdcard/Download/三体.txt')).toBe('三体');
    expect(titleFromFilename('百年孤独.TEXT')).toBe('百年孤独');
    expect(titleFromFilename('   ')).toBe('未命名书籍');
  });

  it('格式化文件大小', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatFileSize(-1)).toBe('0 B');
  });
});
