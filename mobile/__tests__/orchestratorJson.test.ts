import { describe, expect, it } from 'vitest';
import {
  completeJson,
  parseJsonValue,
  type OrchestratorLlm,
} from '../src/core/orchestrator/json';

class FakeLlm implements OrchestratorLlm {
  readonly prompts: string[] = [];
  private readonly responses: string[];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.responses.shift() ?? '';
  }
}

describe('parseJsonValue', () => {
  it('解析代码块与前后说明', () => {
    expect(parseJsonValue('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonValue('说明文字 {"a":2} 结束')).toEqual({ a: 2 });
    expect(parseJsonValue('[{"b":3}]')).toEqual([{ b: 3 }]);
  });

  it('非法 JSON 返回 null', () => {
    expect(parseJsonValue('not json')).toBeNull();
  });
});

describe('completeJson', () => {
  it('首次失败后修复为 JSON', async () => {
    const llm = new FakeLlm(['不是 JSON', '{"summary":"修复成功"}']);
    const result = await completeJson<{ summary: string }>({
      llm,
      prompt: 'prompt',
      schemaHint: '{"summary":"..."}',
      maxTokens: 100,
    });

    expect(result.data).toEqual({ summary: '修复成功' });
    expect(result.repaired).toBe(true);
    expect(result.degraded).toBe(false);
    expect(llm.prompts[1]).toContain('格式不合法');
  });

  it('修复仍失败时降级并保留原文', async () => {
    const llm = new FakeLlm(['不是 JSON', '还是不是 JSON']);
    const result = await completeJson({
      llm,
      prompt: 'prompt',
      schemaHint: '{"summary":"..."}',
      maxTokens: 100,
    });

    expect(result.data).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.raw).toBe('不是 JSON');
  });
});
