export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RequestSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

/** 同时响应外部取消与超时。 */
export function createRequestSignal(
  timeoutMs: number,
  external?: AbortSignal,
): RequestSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}
