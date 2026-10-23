import { sha256Hex } from '../embedding/sha256';

export interface NodeCache {
  get(unitKey: string, inputHash: string): Promise<unknown | null>;
  set(unitKey: string, inputHash: string, output: unknown): Promise<void>;
}

export interface CachedNodeResult<T> {
  value: T;
  cached: boolean;
}

/** 统一缓存包装：unit_hash 基于归一化输入文本，命中后完全不调用 LLM。 */
export async function cachedNode<T>(
  cache: NodeCache,
  unitKey: string,
  inputText: string,
  run: () => Promise<T>,
): Promise<CachedNodeResult<T>> {
  const inputHash = sha256Hex(inputText);
  const cached = await cache.get(unitKey, inputHash);
  if (cached !== null) {
    return { value: cached as T, cached: true };
  }

  const value = await run();
  await cache.set(unitKey, inputHash, value);
  return { value, cached: false };
}
