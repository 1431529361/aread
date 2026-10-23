export const MAX_TOOL_RESULT_CHARS = 3000;
export const MAX_TOOL_ARRAY_ITEMS = 8;
export const MAX_TOOL_STRING_LENGTH = 600;
export const MAX_TOOL_OBJECT_KEYS = 20;

export interface ToolResultLimits {
  maxArrayItems?: number;
  maxStringLength?: number;
  maxObjectKeys?: number;
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(已截断)`;
}

export type ParsedToolArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; detail: string };

export function parseToolArguments(raw: string | null | undefined): ParsedToolArguments {
  if (!raw || !raw.trim()) return { ok: true, args: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'JSON 解析失败',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: '工具参数必须是 JSON 对象' };
  }

  return { ok: true, args: parsed as Record<string, unknown> };
}

function sanitizeForJson(
  value: unknown,
  depth: number,
  limits: Required<ToolResultLimits>,
): unknown {
  if (depth > 6) return '…(深度已截断)';

  if (typeof value === 'string') {
    return truncateText(value, limits.maxStringLength);
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, limits.maxArrayItems)
      .map((item) => sanitizeForJson(item, depth + 1, limits));
    if (value.length > limits.maxArrayItems) {
      items.push({
        __truncated__: true,
        omitted: value.length - limits.maxArrayItems,
      });
    }
    return items;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, limits.maxObjectKeys)) {
      result[key] = sanitizeForJson(entry, depth + 1, limits);
    }
    if (entries.length > limits.maxObjectKeys) result.__truncated__ = true;
    return result;
  }

  return value;
}

/**
 * 工具结果按字段截断，始终保持合法 JSON。
 * 极端情况下退化为 { truncated, preview }，而不是截断 JSON 字符串。
 */
export function serializeToolResult(
  value: unknown,
  limits: ToolResultLimits = {},
): string {
  const resolved: Required<ToolResultLimits> = {
    maxArrayItems: limits.maxArrayItems ?? MAX_TOOL_ARRAY_ITEMS,
    maxStringLength: limits.maxStringLength ?? MAX_TOOL_STRING_LENGTH,
    maxObjectKeys: limits.maxObjectKeys ?? MAX_TOOL_OBJECT_KEYS,
  };

  let json: string;
  try {
    json = JSON.stringify(sanitizeForJson(value, 0, resolved)) ?? 'null';
  } catch {
    return JSON.stringify({ error: 'tool_result_not_serializable' });
  }

  if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
  return JSON.stringify({
    truncated: true,
    preview: json.slice(0, MAX_TOOL_RESULT_CHARS),
  });
}
