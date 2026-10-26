export interface VectorCandidate {
  chunkId: string | number;
  vector: ArrayLike<number>;
}

export interface VectorHit {
  chunkId: string | number;
  score: number;
}

/** L2 归一化。零向量返回全零，保证后续点积不会产生 NaN。 */
export function normalizeVector(input: ArrayLike<number>): Float32Array {
  const out = new Float32Array(input.length);
  let sumSquares = 0;
  for (let i = 0; i < input.length; i++) {
    const value = input[i] ?? 0;
    out[i] = value;
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`向量维度不一致: ${a.length} vs ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** 归一化向量的点积即余弦相似度。 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`向量维度不一致: ${a.length} vs ${b.length}`);
  return dotProduct(normalizeVector(a), normalizeVector(b));
}

/**
 * 点积排序（向量入库前已归一化）。维度不一致的候选直接跳过，
 * 防止混入旧模型/旧 embed_sig 的向量。
 */
export function rankByDot(
  query: ArrayLike<number>,
  candidates: readonly VectorCandidate[],
  topN: number,
): VectorHit[] {
  const hits: VectorHit[] = [];

  for (const candidate of candidates) {
    if (candidate.vector.length !== query.length) continue;
    hits.push({ chunkId: candidate.chunkId, score: dotProduct(query, candidate.vector) });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(0, topN));
}

export function centroidVector(
  vectors: readonly ArrayLike<number>[],
  dims: number,
): Float32Array | null {
  if (vectors.length === 0) return null;
  const sum = new Float64Array(dims);
  let count = 0;
  for (const vector of vectors) {
    if (vector.length !== dims) continue;
    for (let index = 0; index < dims; index++) sum[index] += vector[index] ?? 0;
    count++;
  }
  if (count === 0) return null;
  return normalizeVector(sum);
}

/** float32 BLOB 编码，显式小端，避免跨平台端序差异。 */
export function vectorToBytes(vector: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) {
    view.setFloat32(i * 4, vector[i] ?? 0, true);
  }
  return bytes;
}

export function bytesToVector(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(Math.floor(bytes.byteLength / 4));
  for (let i = 0; i < vector.length; i++) {
    vector[i] = view.getFloat32(i * 4, true);
  }
  return vector;
}
