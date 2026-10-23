export interface OrchestratorLlm {
  complete(
    prompt: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): Promise<string>;
}

export interface JsonCompletion<T> {
  data: T | null;
  raw: string;
  repaired: boolean;
  degraded: boolean;
}

/** 宽松解析 JSON：支持代码块、前后说明文字、数组或对象。 */
export function parseJsonValue<T>(raw: string): T | null {
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), raw.trim()];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as T;
      return parsed ?? null;
    } catch {
      // 继续尝试截取
    }
  }

  const start = raw.search(/[{[]/);
  if (start >= 0) {
    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
    if (end > start) {
      try {
        return (JSON.parse(raw.slice(start, end + 1)) as T) ?? null;
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function buildJsonRepairPrompt(raw: string, schemaHint: string): string {
  return `下面内容本应是 JSON，但格式不合法。请只输出修复后的合法 JSON，不要解释、不要 Markdown。

期望结构：${schemaHint}

待修复内容：
${raw.slice(0, 6000)}`;
}

/**
 * 结构化输出：首次解析失败时调用一次“修复为 JSON”，仍失败则降级。
 * 降级不抛错，由调用方决定如何回退。
 */
export async function completeJson<T>(params: {
  llm: OrchestratorLlm;
  prompt: string;
  schemaHint: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  repairMaxTokens?: number;
}): Promise<JsonCompletion<T>> {
  const raw = await params.llm.complete(params.prompt, {
    maxTokens: params.maxTokens,
    temperature: params.temperature ?? 0.2,
    signal: params.signal,
  });

  const first = parseJsonValue<T>(raw);
  if (first !== null) {
    return { data: first, raw, repaired: false, degraded: false };
  }

  try {
    const repairedRaw = await params.llm.complete(
      buildJsonRepairPrompt(raw, params.schemaHint),
      {
        maxTokens: params.repairMaxTokens ?? 600,
        temperature: 0,
        signal: params.signal,
      },
    );
    const repaired = parseJsonValue<T>(repairedRaw);
    if (repaired !== null) {
      return {
        data: repaired,
        raw: repairedRaw,
        repaired: true,
        degraded: false,
      };
    }
  } catch {
    // 修复失败按降级处理
  }

  return { data: null, raw, repaired: true, degraded: true };
}
