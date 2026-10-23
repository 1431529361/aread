/**
 * 轻量中英文分词：英文按单词，中文输出单字 + bigram。
 * 分词结果既用于 BM25/FTS5 建索引，也用于查询构造。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];

  const tokens: string[] = [];

  const enWords = text.toLowerCase().match(/[a-z][a-z0-9'-]+/g) || [];
  tokens.push(...enWords);

  const cnSegments = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const segment of cnSegments) {
    for (const char of segment) tokens.push(char);
    for (let i = 0; i < segment.length - 1; i++) {
      tokens.push(segment.substring(i, i + 2));
    }
  }

  return tokens;
}

/** FTS5 文档存储格式：空格分隔的 tokens（中文已被预切分，避免 unicode61 把整句当一个词）。 */
export function toFtsDocument(text: string): string {
  return tokenize(text).join(' ');
}
