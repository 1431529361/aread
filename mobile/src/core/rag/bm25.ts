/**
 * FTS5 不可用时的纯 JS BM25 兜底打分。
 * 输入是已预分词的文档 tokens，调用方负责从 rag_lexical 读取。
 */
export interface LexicalDoc {
  id: number;
  tokens: readonly string[];
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export interface Bm25Hit {
  id: number;
  score: number;
}

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * 查询 token 内重复项只计一次；无命中的文档不返回。
 * 分数越大越相关，与 FTS5 的 bm25() 取反后语义一致。
 */
export function scoreBm25(
  queryTokens: readonly string[],
  docs: readonly LexicalDoc[],
  options: Bm25Options = {},
): Bm25Hit[] {
  if (docs.length === 0) return [];

  const query = [...new Set(queryTokens.filter(Boolean))];
  if (query.length === 0) return [];

  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;

  const tokenCounts = docs.map((doc) => countTokens(doc.tokens));
  const totalLength = tokenCounts.reduce((sum, counts) => {
    let length = 0;
    counts.forEach((value) => {
      length += value;
    });
    return sum + length;
  }, 0);
  const avgLength = totalLength / docs.length || 1;

  const docFreq = new Map<string, number>();
  for (const token of query) {
    let count = 0;
    for (const counts of tokenCounts) {
      if (counts.has(token)) count++;
    }
    docFreq.set(token, count);
  }

  const hits: Bm25Hit[] = [];
  docs.forEach((doc, index) => {
    const counts = tokenCounts[index];
    let docLength = 0;
    counts.forEach((value) => {
      docLength += value;
    });

    let score = 0;
    let matched = false;
    for (const token of query) {
      const tf = counts.get(token) ?? 0;
      if (tf === 0) continue;
      matched = true;
      const df = docFreq.get(token) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const denominator = tf + k1 * (1 - b + b * (docLength / avgLength));
      score += idf * ((tf * (k1 + 1)) / denominator);
    }

    if (matched) hits.push({ id: doc.id, score });
  });

  return hits.sort((a, bHit) => bHit.score - a.score || a.id - bHit.id);
}
