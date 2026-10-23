import { describe, expect, it } from 'vitest';
import { runDag } from '../src/core/orchestrator/dag';
import type { NodeCache } from '../src/core/orchestrator/cache';
import type { OrchestratorLlm } from '../src/core/orchestrator/json';
import {
  buildNotesPlan,
  buildSinglePassNotesPlan,
  type NotesFinalValue,
} from '../src/core/orchestrator/notes';
import {
  NOTES_PROMPT_VERSION,
  NOTES_SINGLE_PROMPT_VERSION,
} from '../src/core/orchestrator/prompts';
import type { OrchestratorEnv } from '../src/core/orchestrator/types';

const CN = [
  '一',
  '二',
  '三',
  '四',
  '五',
  '六',
  '七',
  '八',
  '九',
  '十',
  '十一',
  '十二',
  '十三',
  '十四',
  '十五',
  '十六',
  '十七',
  '十八',
  '十九',
  '二十',
];

function makeBook(chapterCount: number, body = '内容'.repeat(50)): string {
  return Array.from(
    { length: chapterCount },
    (_, index) => `第${CN[index]}章 标题${index + 1}\n${body}`,
  ).join('\n\n');
}

class MemoryCache implements NodeCache {
  private readonly values = new Map<string, unknown>();

  async get(unitKey: string, inputHash: string): Promise<unknown | null> {
    return this.values.get(`${unitKey}|${inputHash}`) ?? null;
  }

  async set(unitKey: string, inputHash: string, output: unknown): Promise<void> {
    this.values.set(`${unitKey}|${inputHash}`, output);
  }
}

class NotesLlm implements OrchestratorLlm {
  calls = 0;
  batchCalls = 0;
  singleCalls = 0;
  singlePassMode: 'success' | 'incomplete' = 'success';
  batchMode: 'valid' | 'invalid' = 'valid';

  async complete(prompt: string): Promise<string> {
    this.calls++;
    if (prompt.includes('一次阅读完整本书')) {
      const titles = prompt.match(/^\[\d+\] .+$/gm) ?? [];
      const count =
        this.singlePassMode === 'incomplete' ? Math.max(0, titles.length - 1) : titles.length;
      return JSON.stringify({
        overview: '单次全书概览',
        structure: ['单次结构'],
        themes: ['单次主题'],
        critique: '单次点评',
        conclusion: '单次总结',
        chapterSummaries: Array.from({ length: count }, (_, index) => ({
          chapterIndex: index + 1,
          summary: `单次章节摘要 ${index + 1}`,
          keyPoints: ['要点'],
        })),
      });
    }
    if (prompt.includes('短章节') && prompt.includes('chapterIndex=')) {
      this.batchCalls++;
      const indices = [...prompt.matchAll(/【chapterIndex=(\d+)｜/g)].map(
        (match) => Number(match[1]),
      );
      return JSON.stringify(
        indices.map((chapterIndex) => ({
          chapterIndex: this.batchMode === 'invalid' ? 0 : chapterIndex,
          summary: `批量摘要${chapterIndex}`,
          keyEvents: ['事件'],
          entities: ['人物'],
        })),
      );
    }
    if (prompt.includes('片段摘要器')) {
      this.singleCalls++;
      const text = prompt.split('原文片段：')[1] ?? '';
      return JSON.stringify({
        summary: `片段摘要:${text.slice(0, 24)}`,
        keyEvents: ['事件'],
        entities: ['人物'],
      });
    }
    if (prompt.includes('章节摘要器')) {
      return JSON.stringify({
        summary: `章节摘要:${prompt.slice(-40)}`,
        keyPoints: ['要点'],
        characters: ['人物'],
      });
    }
    if (prompt.includes('分部摘要器')) {
      return JSON.stringify({ summary: '分部摘要' });
    }
    if (prompt.includes('资深读书笔记撰写者')) {
      return JSON.stringify({
        overview: '全书概览',
        structure: ['结构一', '结构二'],
        themes: ['主题'],
        critique: '点评',
        conclusion: '总结',
      });
    }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
  }
}

function makeEnv(
  llm: OrchestratorLlm,
  cache: NodeCache,
  promptVersion = NOTES_PROMPT_VERSION,
): OrchestratorEnv {
  return {
    bookId: 'b1',
    userId: 'local',
    bookTitle: '测试书',
    taskType: 'generate-notes',
    llm,
    cache,
    modelSig: 'model-sig',
    promptVersion,
  };
}

describe('buildNotesPlan', () => {
  it('覆盖全部章节（12 章，不是前 8 章），并生成分部节点', async () => {
    const content = makeBook(12);
    const llm = new NotesLlm();
    const plan = buildNotesPlan(makeEnv(llm, new MemoryCache()), content);

    expect(plan.chapters).toHaveLength(12);
    expect(plan.partCount).toBe(2);

    const result = await runDag(plan.nodes, { concurrency: 3 });
    expect(result.errors.size).toBe(0);

    const final = result.outputs.get(plan.finalNodeId) as NotesFinalValue;
    expect(final.coverage).toBe(1);
    expect(final.missingChapters).toEqual([]);
    expect(final.chapterSummaries).toHaveLength(12);
    expect(final.partCount).toBe(2);
    expect(final.markdown.match(/^### /gm)).toHaveLength(12);
    expect(final.markdown).toContain('第十二章');
    expect(final.markdown).toContain('txt:');
    expect(llm.batchCalls).toBe(4);
    expect(llm.singleCalls).toBe(0);
  });

  it('20 个短章批量 Map，调用次数从 20+ 降到约 7 次', async () => {
    const content = makeBook(20, '短章内容'.repeat(250));
    const llm = new NotesLlm();
    const plan = buildNotesPlan(makeEnv(llm, new MemoryCache()), content);

    expect(plan.chapters.every((chapter) => !chapter.isLong)).toBe(true);
    const result = await runDag(plan.nodes, { concurrency: 3 });
    const final = result.outputs.get(plan.finalNodeId) as NotesFinalValue;

    expect(result.errors.size).toBe(0);
    expect(final.coverage).toBe(1);
    expect(final.chapterSummaries).toHaveLength(20);
    expect(llm.batchCalls).toBe(7);
    expect(llm.singleCalls).toBe(0);
  });

  it('批量 chapterIndex 错位时重试并退化为逐章调用', async () => {
    const content = makeBook(3);
    const llm = new NotesLlm();
    llm.batchMode = 'invalid';
    const plan = buildNotesPlan(makeEnv(llm, new MemoryCache()), content);

    const result = await runDag(plan.nodes, { concurrency: 3 });
    const final = result.outputs.get(plan.finalNodeId) as NotesFinalValue;

    expect(final.coverage).toBe(1);
    expect(llm.batchCalls).toBe(2);
    expect(llm.singleCalls).toBe(3);
    expect(final.chapterSummaries.map((chapter) => chapter.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('片段摘要'),
      ]),
    );
  });

  it('长章节会切分为多个 chunk，不进入批量短章', () => {
    const content = `第一章 很长\n${'内容'.repeat(8000)}`;
    const plan = buildNotesPlan(makeEnv(new NotesLlm(), new MemoryCache()), content);
    expect(plan.chapters).toHaveLength(1);
    expect(plan.chapters[0].isLong).toBe(true);
    expect(plan.chapters[0].chunks.length).toBeGreaterThan(1);
  });

  it('缓存命中后不再调用 LLM', async () => {
    const content = makeBook(3);
    const llm = new NotesLlm();
    const cache = new MemoryCache();

    const firstPlan = buildNotesPlan(makeEnv(llm, cache), content);
    await runDag(firstPlan.nodes, { concurrency: 3 });
    const firstCalls = llm.calls;
    expect(firstCalls).toBeGreaterThan(0);

    const secondPlan = buildNotesPlan(makeEnv(llm, cache), content);
    await runDag(secondPlan.nodes, { concurrency: 3 });
    expect(llm.calls).toBe(firstCalls);
  });
});

describe('buildSinglePassNotesPlan', () => {
  it('一次调用生成全部章节并保留 locator', async () => {
    const content = makeBook(3);
    const llm = new NotesLlm();
    const plan = buildSinglePassNotesPlan(
      makeEnv(llm, new MemoryCache(), NOTES_SINGLE_PROMPT_VERSION),
      content,
    );

    const result = await runDag(plan.nodes, { concurrency: 1 });
    expect(result.errors.size).toBe(0);
    const final = result.outputs.get(plan.finalNodeId) as NotesFinalValue;

    expect(final.strategy).toBe('single-pass');
    expect(final.coverage).toBe(1);
    expect(final.chapterSummaries).toHaveLength(3);
    expect(final.markdown).toContain('单次章节摘要 3');
    expect(final.markdown).toContain('txt:');
    expect(llm.calls).toBe(1);
  });

  it('漏章时 coverage < 1，供上层降级', async () => {
    const content = makeBook(3);
    const llm = new NotesLlm();
    llm.singlePassMode = 'incomplete';
    const plan = buildSinglePassNotesPlan(
      makeEnv(llm, new MemoryCache(), NOTES_SINGLE_PROMPT_VERSION),
      content,
    );

    const result = await runDag(plan.nodes, { concurrency: 1 });
    const final = result.outputs.get(plan.finalNodeId) as NotesFinalValue;
    expect(final.coverage).toBeLessThan(1);
    expect(final.missingChapters).toHaveLength(1);
  });
});
