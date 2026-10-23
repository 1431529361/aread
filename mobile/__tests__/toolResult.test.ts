import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_STRING_LENGTH,
  parseToolArguments,
  serializeToolResult,
  truncateText,
} from '../src/core/agent/toolResult';

describe('parseToolArguments', () => {
  it('空参数视为空对象', () => {
    expect(parseToolArguments('')).toEqual({ ok: true, args: {} });
  });

  it('解析 JSON 对象', () => {
    expect(parseToolArguments('{"query":"自由"}')).toEqual({
      ok: true,
      args: { query: '自由' },
    });
  });

  it('非法 JSON 返回错误详情', () => {
    const parsed = parseToolArguments('{bad');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.detail).toBeTruthy();
  });

  it('数组或标量不是合法参数', () => {
    expect(parseToolArguments('[1,2]').ok).toBe(false);
    expect(parseToolArguments('"text"').ok).toBe(false);
  });
});

describe('serializeToolResult', () => {
  it('长字符串按字段截断但 JSON 合法', () => {
    const json = serializeToolResult({ text: 'x'.repeat(1000) });
    const parsed = JSON.parse(json) as { text: string };
    expect(parsed.text).toHaveLength(MAX_TOOL_STRING_LENGTH + 6);
    expect(parsed.text).toContain('已截断');
  });

  it('超长数组截断并标注省略数量', () => {
    const json = serializeToolResult({
      results: Array.from({ length: 12 }, (_, index) => index),
    });
    const parsed = JSON.parse(json) as {
      results: Array<number | { __truncated__: boolean; omitted: number }>;
    };
    expect(parsed.results).toHaveLength(9);
    expect(parsed.results[8]).toEqual({ __truncated__: true, omitted: 4 });
  });

  it('极端超长结果仍返回可解析 JSON', () => {
    const json = serializeToolResult({
      rows: Array.from({ length: 50 }, () => 'y'.repeat(1000)),
    });
    expect(json.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 100);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('不可序列化的值返回错误对象', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => JSON.parse(serializeToolResult(circular))).not.toThrow();
  });
});

describe('truncateText', () => {
  it('短文本不变，长文本截断', () => {
    expect(truncateText('abc', 5)).toBe('abc');
    expect(truncateText('abcdef', 3)).toBe('abc…(已截断)');
  });
});
