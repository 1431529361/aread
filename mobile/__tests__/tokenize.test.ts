import { describe, expect, it } from 'vitest';
import { toFtsDocument, tokenize } from '../src/core/rag/tokenize';

describe('tokenize', () => {
  it('空输入返回空数组', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('中文按单字 + bigram 切分', () => {
    expect(tokenize('你好世界')).toEqual(['你', '好', '世', '界', '你好', '好世', '世界']);
  });

  it('英文统一小写并按单词切分', () => {
    expect(tokenize('Hello WORLD')).toEqual(['hello', 'world']);
  });

  it('中英文混合时两路都要输出', () => {
    expect(tokenize('AI 阅读')).toEqual(['ai', '阅', '读', '阅读']);
  });

  it('保留英文单词内部的连字符与撇号', () => {
    expect(tokenize("don't stop-me")).toEqual(["don't", 'stop-me']);
  });

  it('纯标点不产生 token', () => {
    expect(tokenize('“”，。！？ - * "')).toEqual([]);
  });

  it('FTS 文档以空格连接 tokens', () => {
    expect(toFtsDocument('你好')).toBe('你 好 你好');
  });
});
