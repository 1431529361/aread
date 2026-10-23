import { sha256Hex } from './sha256';

export const EMBED_DIMS = 1024;
export const EMBED_SIG_LENGTH = 16;

export interface EmbedConfigLike {
  baseUrl: string;
  model: string;
  /** 可选的 dimensions 请求参数；留空表示请求体不携带该字段 */
  dimensionsParam?: number | null;
  dims?: number;
}

/** Base URL 只存前缀，统一去掉首尾空白与末尾斜杠。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function computeEmbedSig(config: EmbedConfigLike): string {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model.trim();
  const dims = config.dims ?? EMBED_DIMS;

  if (!baseUrl) throw new Error('Embedding Base URL 不能为空');
  if (!model) throw new Error('Embedding 模型不能为空');
  if (dims !== EMBED_DIMS) {
    throw new Error(`Embedding 维度固定为 ${EMBED_DIMS}，当前为 ${dims}`);
  }

  const dimensionsParam = config.dimensionsParam ?? '';
  return sha256Hex(`${baseUrl}|${model}|${dimensionsParam}|${dims}`).slice(0, EMBED_SIG_LENGTH);
}
