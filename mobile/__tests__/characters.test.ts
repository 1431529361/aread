import { describe, expect, it } from 'vitest';
import { runDag } from '../src/core/orchestrator/dag';
import type { NodeCache } from '../src/core/orchestrator/cache';
import type { OrchestratorLlm } from '../src/core/orchestrator/json';
import {
  aggregateCharacterMentions,
  buildCharacterPlan,
  locateQuote,
  normalizePersonName,
  type CharacterFinalValue,
  type CharacterMention,
} from '../src/core/orchestrator/characters';
import { CHARACTERS_PROMPT_VERSION } from '../src/core/orchestrator/prompts';
import type { OrchestratorEnv } from '../src/core/orchestrator/types';

const location = (start: number, end: number) => ({
  kind: 'txt' as const,
  href: null,
  start,
  end,
});

function mention(
  name: string,
  aliases: string[],
  chapterIndex: number,
  quote: string,
  start: number,
): CharacterMention {
  return {
    name,
    aliases,
    quote,
    chapterIndex,
    chapterTitle: `第${chapterIndex + 1}章`,
    loc: location(start, start + quote.length),
  };
}

describe('aggregateCharacterMentions', () => {
  it('合并别名、保留跨章节全量提及并选规范名', () => {
    const mentions = [
      mention('林岚', ['小岚'], 0, '林岚走进邮局。', 10),
      mention('小岚', [], 1, '小岚看见周叔。', 100),
      mention('周叔', [], 0, '周叔在等。', 30),
    ];

    const characters = aggregateCharacterMentions(mentions);
    const lin = characters.find((character) => character.name === '林岚');
    expect(lin).toMatchObject({
      mentionCount: 2,
      chapterCount: 2,
    });
    expect(lin?.aliases).toContain('小岚');
    expect(characters.find((character) => character.name === '周叔')).toBeTruthy();
  });

  it('去重同一位置重复提及并过滤代词', () => {
    const mentions = [
      mention('林岚', [], 0, '林岚走进邮局。', 10),
      mention('林岚', [], 0, '林岚走进邮局。', 10),
      mention('他', [], 0, '他走了。', 50),
    ];

    const characters = aggregateCharacterMentions(mentions);
    expect(characters).toHaveLength(1);
    expect(characters[0].mentionCount).toBe(1);
  });

  it('规范化姓名标点与大小写', () => {
    expect(normalizePersonName(' 林·岚 ')).toBe('林岚');
  });
});

describe('locateQuote', () => {
  const chunk = {
    chapterIndex: 0,
    chunkIndex: 0,
    chapterTitle: '第一章',
    text: '林岚走进邮局。周叔在等。',
    loc: location(100, 112),
  };

  it('用 quote 在 chunk 内偏移计算 locator', () => {
    expect(locateQuote(chunk, '周叔在等。')).toEqual(location(107, 112));
  });

  it('找不到 quote 时回退 chunk locator', () => {
    expect(locateQuote(chunk, '不存在的话')).toEqual(chunk.loc);
  });
});

class MemoryCache implements NodeCache {
  private readonly values = new Map<string, unknown>();

  async get(unitKey: string, inputHash: string): Promise<unknown | null> {
    return this.values.get(`${unitKey}|${inputHash}`) ?? null;
  }

  async set(unitKey: string, inputHash: string, output: unknown): Promise<void> {
    this.values.set(`${unitKey}|${inputHash}`, output);
  }
}

class CharactersLlm implements OrchestratorLlm {
  calls = 0;
  batchCalls = 0;
  singleCalls = 0;

  async complete(prompt: string): Promise<string> {
    this.calls++;
    if (prompt.includes('按 chapterIndex 分组输出人物提及')) {
      this.batchCalls++;
      const indices = [...prompt.matchAll(/【chapterIndex=(\d+)｜/g)].map(
        (match) => Number(match[1]),
      );
      const mentions: unknown[] = [];
      if (prompt.includes('林岚走进邮局')) {
        mentions.push({
          name: '林岚',
          aliases: ['小岚'],
          quote: '林岚走进邮局。',
          roleHint: '主角',
        });
      }
      if (prompt.includes('周叔在等')) {
        mentions.push({
          name: '周叔',
          aliases: [],
          quote: '周叔在等。',
          roleHint: '守塔人',
        });
      }
      return JSON.stringify(
        indices.map((chapterIndex) => ({ chapterIndex, mentions })),
      );
    }
    if (prompt.includes('人物提及抽取器')) {
      this.singleCalls++;
      const mentions: unknown[] = [];
      if (prompt.includes('林岚走进邮局')) {
        mentions.push({
          name: '林岚',
          aliases: ['小岚'],
          quote: '林岚走进邮局。',
          roleHint: '主角',
        });
      }
      if (prompt.includes('周叔在等')) {
        mentions.push({
          name: '周叔',
          aliases: [],
          quote: '周叔在等。',
          roleHint: '守塔人',
        });
      }
      return JSON.stringify(mentions);
    }
    if (prompt.includes('人物分析器')) {
      return JSON.stringify({
        overview: '人物分析',
        traits: ['勇敢'],
        arc: '逐渐成长',
        relationships: [{ target: '周叔', description: '互相帮助' }],
        citations: ['M1'],
      });
    }
    if (prompt.includes('人物关系分析器')) {
      return JSON.stringify({
        overview: '关系总览',
        network: [
          { from: '林岚', to: '周叔', relation: '忘年交' },
        ],
        conclusion: '关系总结',
      });
    }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
  }
}

function makeEnv(llm: OrchestratorLlm, cache: NodeCache): OrchestratorEnv {
  return {
    bookId: 'b1',
    userId: 'local',
    bookTitle: '测试书',
    taskType: 'character-analysis',
    llm,
    cache,
    modelSig: 'model-sig',
    promptVersion: CHARACTERS_PROMPT_VERSION,
  };
}

describe('buildCharacterPlan', () => {
  it('全书提及聚合、人物分析与关系报告', async () => {
    const content =
      '第一章 开端\n林岚走进邮局。周叔在等。\n\n第二章 发展\n林岚走进邮局。周叔在等。';
    const llm = new CharactersLlm();
    const plan = buildCharacterPlan(makeEnv(llm, new MemoryCache()), content);

    const result = await runDag(plan.nodes, { concurrency: 3 });
    expect(result.errors.size).toBe(0);
    const final = result.outputs.get(plan.finalNodeId) as CharacterFinalValue;

    expect(final.coverage).toBe(1);
    expect(final.characterCount).toBe(2);
    expect(final.mentionCount).toBeGreaterThanOrEqual(4);
    expect(final.analyses).toHaveLength(2);
    expect(final.markdown).toContain('林岚');
    expect(final.markdown).toContain('周叔');
    expect(final.markdown).toContain('关系网络');
    expect(final.markdown).toContain('txt:');
    expect(llm.batchCalls).toBe(1);
    expect(llm.singleCalls).toBe(0);
  });

  it('20 个短章人物提及按 3 章批量，减少调用次数', async () => {
    const content = Array.from(
      { length: 20 },
      (_, index) =>
        `第${index + 1}章\n林岚走进邮局。周叔在等。${'背景'.repeat(200)}`,
    ).join('\n\n');
    const llm = new CharactersLlm();
    const plan = buildCharacterPlan(
      makeEnv(llm, new MemoryCache()),
      content,
    );

    const result = await runDag(plan.nodes, { concurrency: 3 });
    expect(result.errors.size).toBe(0);
    expect(llm.batchCalls).toBe(7);
    expect(llm.singleCalls).toBe(0);
  });
});
