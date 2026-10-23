import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/core/embedding/sha256';
import {
  EMBED_DIMS,
  EMBED_SIG_LENGTH,
  computeEmbedSig,
  normalizeBaseUrl,
} from '../src/core/embedding/signature';

describe('sha256Hex', () => {
  it('匹配已知测试向量', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('与 Node crypto 结果一致（含多块与 UTF-8）', () => {
    for (const input of ['你好，世界', 'a'.repeat(1000), '混合 text 123']) {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex');
      expect(sha256Hex(input)).toBe(expected);
    }
  });
});

describe('computeEmbedSig', () => {
  const config = {
    baseUrl: 'https://api.siliconflow.cn/v1/',
    model: 'BAAI/bge-large-zh-v1.5',
    dimensionsParam: 1024,
    dims: EMBED_DIMS,
  };

  it('Base URL 末尾斜杠不影响签名', () => {
    expect(computeEmbedSig(config)).toBe(
      computeEmbedSig({ ...config, baseUrl: 'https://api.siliconflow.cn/v1' }),
    );
  });

  it('签名为短哈希', () => {
    expect(computeEmbedSig(config)).toHaveLength(EMBED_SIG_LENGTH);
  });

  it('模型或 dimensions 参数变化会改变签名', () => {
    const base = computeEmbedSig(config);
    expect(computeEmbedSig({ ...config, model: 'other-model' })).not.toBe(base);
    expect(computeEmbedSig({ ...config, dimensionsParam: null })).not.toBe(base);
  });

  it('只接受 1024 维', () => {
    expect(() => computeEmbedSig({ ...config, dims: 2048 })).toThrow();
  });

  it('缺少 Base URL 或模型时报错', () => {
    expect(() => computeEmbedSig({ ...config, baseUrl: '  ' })).toThrow();
    expect(() => computeEmbedSig({ ...config, model: ' ' })).toThrow();
  });
});

describe('normalizeBaseUrl', () => {
  it('去除首尾空白与末尾斜杠', () => {
    expect(normalizeBaseUrl(' https://api.example.com/v1/// ')).toBe(
      'https://api.example.com/v1',
    );
  });
});
