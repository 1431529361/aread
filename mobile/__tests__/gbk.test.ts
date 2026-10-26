import { describe, it, expect } from 'vitest';
import { decodeGb18030, looksLikeBinaryText } from '../src/core/import/gbk';

/** Node 内置的 GB18030 解码器，用作交叉验证的参考实现。 */
const gb18030Decoder = new TextDecoder('gb18030', { fatal: true });

// Helper: generate random valid GBK double-byte sequences
function randomGbkDoubleByte(): Uint8Array {
  const bytes: number[] = [];
  const length = 10 + Math.floor(Math.random() * 20);
  for (let i = 0; i < length; i++) {
    // Mix of ASCII and GBK double-byte
    if (Math.random() < 0.3) {
      bytes.push(Math.floor(Math.random() * 0x80)); // ASCII
    } else {
      const byte1 = 0x81 + Math.floor(Math.random() * 0x7e); // 0x81-0xFE
      let byte2: number;
      if (Math.random() < 0.5) {
        byte2 = 0x40 + Math.floor(Math.random() * 0x3f); // 0x40-0x7E
      } else {
        byte2 = 0x80 + Math.floor(Math.random() * 0x7f); // 0x80-0xFE
      }
      bytes.push(byte1, byte2);
    }
  }
  return new Uint8Array(bytes);
}

// Helper: generate random valid GB18030 four-byte sequences
function randomGb18030FourByte(): Uint8Array {
  const bytes: number[] = [];
  const length = 5 + Math.floor(Math.random() * 10);
  for (let i = 0; i < length; i++) {
    if (Math.random() < 0.4) {
      bytes.push(Math.floor(Math.random() * 0x80)); // ASCII
    } else if (Math.random() < 0.7) {
      const byte1 = 0x81 + Math.floor(Math.random() * 0x7e);
      let byte2: number;
      if (Math.random() < 0.5) {
        byte2 = 0x40 + Math.floor(Math.random() * 0x3f);
      } else {
        byte2 = 0x80 + Math.floor(Math.random() * 0x7f);
      }
      bytes.push(byte1, byte2);
    } else {
      // Four-byte sequence
      const byte1 = 0x81 + Math.floor(Math.random() * 0x7e);
      const byte2 = 0x30 + Math.floor(Math.random() * 0x0a);
      const byte3 = 0x81 + Math.floor(Math.random() * 0x7e);
      const byte4 = 0x30 + Math.floor(Math.random() * 0x0a);
      bytes.push(byte1, byte2, byte3, byte4);
    }
  }
  return new Uint8Array(bytes);
}

describe('decodeGb18030', () => {
  it('should decode ASCII', () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    expect(decodeGb18030(bytes)).toBe('Hello');
  });

  it('should decode ASCII+GBK mixed: 中文测试abc', () => {
    // 中 = D6 D0, 文 = CE C4, 测 = B2 E2, 试 = CA D4, a=61, b=62, c=63
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x61, 0x62, 0x63]);
    expect(decodeGb18030(bytes)).toBe('中文测试abc');
  });

  it('should decode GB2312 common characters', () => {
    // 啊 = B0 A1, 阿 = B0 A2, 埃 = B0 A3
    const bytes = new Uint8Array([0xb0, 0xa1, 0xb0, 0xa2, 0xb0, 0xa3]);
    const result = decodeGb18030(bytes);
    expect(result).toBe('啊阿埃');
  });

  it('should decode GBK common punctuation', () => {
    // " = A1 B0, " = A1 B1, 。 = A1 A3, ， = A3 AC
    const bytes = new Uint8Array([0xa1, 0xb0, 0xa3, 0xac, 0xa1, 0xb1, 0xa1, 0xa3]);
    const result = decodeGb18030(bytes);
    expect(result).toBe('\u201c\uff0c\u201d\u3002');
  });

  it('should decode GB18030 four-byte character: 𠀀 (U+20000)', () => {
    // 𠀀 U+20000 in GB18030: 95 32 82 36
    const bytes = new Uint8Array([0x95, 0x32, 0x82, 0x36]);
    const result = decodeGb18030(bytes);
    expect(result).toBe('𠀀');
  });

  it('should decode mixed ASCII + GBK double-byte + GB18030 four-byte', () => {
    // A (0x41) + 中 (D6 D0) + 𠀀 (95 32 82 36) + B (0x42)
    const bytes = new Uint8Array([0x41, 0xd6, 0xd0, 0x95, 0x32, 0x82, 0x36, 0x42]);
    const result = decodeGb18030(bytes);
    expect(result).toBe('A中𠀀B');
  });

  it('should return null for invalid leading byte 0xFF', () => {
    const bytes = new Uint8Array([0xff, 0x41]);
    expect(decodeGb18030(bytes)).toBeNull();
  });

  it('should return null for truncated double-byte sequence', () => {
    const bytes = new Uint8Array([0xd6]); // Missing second byte
    expect(decodeGb18030(bytes)).toBeNull();
  });

  it('should return null for invalid second byte in double-byte', () => {
    const bytes = new Uint8Array([0xd6, 0x30]); // 0x30 is not valid as second byte of double-byte
    expect(decodeGb18030(bytes)).toBeNull();
  });

  it('should return null for truncated four-byte sequence', () => {
    const bytes = new Uint8Array([0x90, 0x30, 0x81]); // Missing fourth byte
    expect(decodeGb18030(bytes)).toBeNull();
  });

  it('should return null for unmapped double-byte sequence', () => {
    // Find a double-byte that maps to 0 in our table
    // Most double-byte sequences in the valid range are mapped, but let's try
    // an edge case: the table should have all 23940 entries mapped based on our generation
    // Actually, since all 23940 are mapped, we need to test with truly invalid bytes
    // Let's test with byte2 = 0x7F which is skipped
    const bytes = new Uint8Array([0x81, 0x7f]);
    expect(decodeGb18030(bytes)).toBeNull();
  });

  it('should decode empty bytes as empty string', () => {
    const bytes = new Uint8Array([]);
    expect(decodeGb18030(bytes)).toBe('');
  });

  it('should handle large input efficiently', () => {
    // Create a large input with repeated GBK characters
    const bytes = new Uint8Array(10000);
    for (let i = 0; i < bytes.length; i += 2) {
      bytes[i] = 0xd6; // 中
      bytes[i + 1] = 0xd0;
    }
    const result = decodeGb18030(bytes);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(5000);
  });

  // 50+ sample comparison with Node's TextDecoder
  it('should match Node TextDecoder for 50+ random GBK double-byte samples', () => {
    const failures: string[] = [];
    let tested = 0;

    for (let i = 0; i < 60; i++) {
      const bytes = randomGbkDoubleByte();
      try {
        const expected = gb18030Decoder.decode(bytes);
        const actual = decodeGb18030(bytes);
        if (actual !== expected) {
          failures.push(`Sample ${i}: expected "${expected.slice(0, 20)}...", got "${actual?.slice(0, 20) ?? 'null'}..."`);
        }
        tested++;
      } catch {
        // TextDecoder failed (fatal mode), skip this sample
        // But our decoder should also return null
        const actual = decodeGb18030(bytes);
        if (actual !== null) {
          failures.push(`Sample ${i}: expected null, got "${actual?.slice(0, 20)}..."`);
        }
        tested++;
      }
    }

    expect(tested).toBeGreaterThanOrEqual(50);
    if (failures.length > 0) {
      throw new Error(`${failures.length} failures:\n${failures.slice(0, 5).join('\n')}`);
    }
  });

  it('should match Node TextDecoder for 50+ random GB18030 four-byte samples', () => {
    const failures: string[] = [];
    let tested = 0;

    for (let i = 0; i < 60; i++) {
      const bytes = randomGb18030FourByte();
      try {
        const expected = gb18030Decoder.decode(bytes);
        const actual = decodeGb18030(bytes);
        if (actual !== expected) {
          failures.push(`Sample ${i}: expected "${expected.slice(0, 20)}...", got "${actual?.slice(0, 20) ?? 'null'}..."`);
        }
        tested++;
      } catch {
        const actual = decodeGb18030(bytes);
        if (actual !== null) {
          failures.push(`Sample ${i}: expected null, got "${actual?.slice(0, 20)}..."`);
        }
        tested++;
      }
    }

    expect(tested).toBeGreaterThanOrEqual(50);
    if (failures.length > 0) {
      throw new Error(`${failures.length} failures:\n${failures.slice(0, 5).join('\n')}`);
    }
  });

  it('should correctly decode known GBK test strings', () => {
    // Test with a variety of known GBK-encoded strings
    const testCases: Array<{ bytes: Uint8Array; expected: string }> = [
      // 测试 = B2 E2 CA D4
      { bytes: new Uint8Array([0xb2, 0xe2, 0xca, 0xd4]), expected: '测试' },
      // 你好 = C4 E3 BA C3
      { bytes: new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), expected: '你好' },
      // 世界 = CA C0 BD E7
      { bytes: new Uint8Array([0xca, 0xc0, 0xbd, 0xe7]), expected: '世界' },
      // Hello世界 = 48 65 6C 6C 6F CA C0 BD E7
      { bytes: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xca, 0xc0, 0xbd, 0xe7]), expected: 'Hello世界' },
    ];

    for (const { bytes, expected } of testCases) {
      const actual = decodeGb18030(bytes);
      expect(actual).toBe(expected);
    }
  });
});

describe('looksLikeBinaryText', () => {
  it('空输入不算二进制', () => {
    expect(looksLikeBinaryText(new Uint8Array([]))).toBe(false);
  });

  it('纯 ASCII 文本不算二进制', () => {
    const bytes = new TextEncoder().encode('Hello, world!\nsecond line\tindented');
    expect(looksLikeBinaryText(bytes)).toBe(false);
  });

  it('GBK 中文正文不算二进制', () => {
    // 中文测试中文测试：连续 GBK 双字节，无控制字符
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
    expect(looksLikeBinaryText(bytes)).toBe(false);
  });

  it('控制字符密集的二进制会被判定', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;
    expect(looksLikeBinaryText(bytes)).toBe(true);
  });

  it('偶发控制字符仍视为文本', () => {
    // 200 字节中仅 2 个控制字符（1%）
    const bytes = new Uint8Array(200).fill(0x41);
    bytes[10] = 0x01;
    bytes[11] = 0x02;
    expect(looksLikeBinaryText(bytes)).toBe(false);
  });
});
