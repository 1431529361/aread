import { describe, expect, it } from 'vitest';
import type { OrchestratorLlm } from '../src/core/orchestrator/json';
import type { LlmClientConfig } from '../src/core/llm/client';
import {
  cancelTask,
  isContextLengthError,
  isTaskRunning,
  startTask,
  type TaskEvent,
} from '../src/services/taskRunner';
import {
  getLatestTaskRun,
  getTaskResult,
} from '../src/db/repositories/taskRuns';
import { LOCAL_USER_ID } from '../src/db/schema';
import { createTestDb, insertBook } from './helpers/testDb';

const CN = ['一', '二', '三', '四', '五', '六'];

function makeBook(chapterCount = 2, suffix = ''): string {
  return Array.from(
    { length: chapterCount },
    (_, index) =>
      `第${CN[index]}章 标题${index + 1}\n林岚走进邮局。周叔在等。${suffix}`,
  ).join('\n\n');
}

const chatConfig: LlmClientConfig = {
  baseUrl: 'https://chat.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

class TaskLlm implements OrchestratorLlm {
  calls: string[] = [];
  singlePassMode: 'success' | 'context-error' | 'incomplete' = 'success';
  delayMs = 0;

  private async wait(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }

  async complete(prompt: string): Promise<string> {
    this.calls.push(prompt);
    await this.wait();

    if (prompt.includes('一次阅读完整本书')) {
      if (this.singlePassMode === 'context-error') {
        const error = new Error(
          'This model maximum context length is 200000 tokens',
        ) as Error & { status: number; body: unknown };
        error.status = 400;
        error.body = { error: { message: error.message } };
        throw error;
      }
      const titles = prompt.match(/^\[\d+\] .+$/gm) ?? [];
      const count =
        this.singlePassMode === 'incomplete'
          ? Math.max(0, titles.length - 1)
          : titles.length;
      return JSON.stringify({
        overview: '单次概览',
        structure: ['结构'],
        themes: ['主题'],
        critique: '点评',
        conclusion: '总结',
        chapterSummaries: Array.from({ length: count }, (_, index) => ({
          chapterIndex: index + 1,
          summary: `单次章节 ${index + 1}`,
          keyPoints: [],
        })),
      });
    }

    if (prompt.includes('短章节') && prompt.includes('chapterIndex=')) {
      const indices = [...prompt.matchAll(/【chapterIndex=(\d+)｜/g)].map(
        (match) => Number(match[1]),
      );
      return JSON.stringify(
        indices.map((chapterIndex) => ({
          chapterIndex,
          summary: `批量摘要${chapterIndex}:${prompt.length}`,
          keyEvents: ['事件'],
          entities: ['人物'],
        })),
      );
    }
    if (prompt.includes('片段摘要器')) {
      const text = prompt.split('原文片段：')[1] ?? '';
      return JSON.stringify({
        summary: `片段:${text.length}:${text.slice(-24)}`,
        keyEvents: ['事件'],
        entities: ['人物'],
      });
    }
    if (prompt.includes('章节摘要器')) {
      return JSON.stringify({
        summary: `章节:${prompt.slice(-60)}`,
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
        structure: ['结构'],
        themes: ['主题'],
        critique: '点评',
        conclusion: '总结',
      });
    }
    if (prompt.includes('按 chapterIndex 分组输出人物提及')) {
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
        arc: '成长',
        relationships: [{ target: '周叔', description: '互相帮助' }],
        citations: ['M1'],
      });
    }
    if (prompt.includes('人物关系分析器')) {
      return JSON.stringify({
        overview: '关系总览',
        network: [{ from: '林岚', to: '周叔', relation: '忘年交' }],
        conclusion: '关系总结',
      });
    }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
  }
}

async function setup() {
  const testDb = await createTestDb();
  await insertBook(testDb.db, { id: 'b1', title: '测试书' });
  return testDb;
}

describe('taskRunner notes', () => {
  it('小书走单次路径，保存结果与任务状态', async () => {
    const { db, close } = await setup();
    const llm = new TaskLlm();
    const events: TaskEvent[] = [];

    const result = await startTask({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      bookTitle: '测试书',
      content: makeBook(3),
      taskType: 'generate-notes',
      chatConfig,
      llm,
      onEvent: (event) => events.push(event),
    });

    expect(result.strategy).toBe('single-pass');
    expect(result.status).toBe('completed');
    expect(result.coverage).toBe(1);
    expect(result.chapterCount).toBe(3);
    expect(result.content).toContain('单次章节 3');
    expect(llm.calls).toHaveLength(1);

    const stored = await getTaskResult(db, {
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      taskType: 'generate-notes',
    });
    expect(stored).toBe(result.content);

    const run = await getLatestTaskRun(db, {
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      taskType: 'generate-notes',
    });
    expect(run?.status).toBe('completed');
    expect(events.some((event) => event.type === 'task_done')).toBe(true);
    close();
  });

  it('单次上下文超限时自动降级 map-reduce 并发出 fallback 事件', async () => {
    const { db, close } = await setup();
    const llm = new TaskLlm();
    llm.singlePassMode = 'context-error';
    const events: TaskEvent[] = [];

    const result = await startTask({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      bookTitle: '测试书',
      content: makeBook(2),
      taskType: 'generate-notes',
      chatConfig,
      llm,
      onEvent: (event) => events.push(event),
    });

    expect(result.strategy).toBe('single-pass-fallback');
    expect(result.fallbackReason).toBe('context_limit');
    expect(result.status).toBe('completed');
    expect(result.coverage).toBe(1);
    expect(result.content).toContain('## 章节摘要');
    expect(llm.calls.length).toBeGreaterThan(1);
    expect(
      events.some(
        (event) =>
          event.type === 'fallback' && event.to === 'map-reduce',
      ),
    ).toBe(true);
    close();
  });

  it('缓存命中不调用 LLM，改一章只重跑相关节点', async () => {
    const { db, close } = await setup();
    const llm = new TaskLlm();
    const baseOptions = {
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      bookTitle: '测试书',
      taskType: 'generate-notes' as const,
      chatConfig,
      llm,
      singlePassMaxTokens: 1,
    };

    const first = await startTask({
      ...baseOptions,
      content: makeBook(4, '初始版本'),
    });
    expect(first.strategy).toBe('map-reduce');
    expect(first.status).toBe('completed');
    const firstCalls = llm.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    const second = await startTask({
      ...baseOptions,
      content: makeBook(4, '初始版本'),
    });
    expect(llm.calls.length).toBe(firstCalls);
    expect(second.cacheHits).toBeGreaterThan(0);

    const changed = `${makeBook(
      3,
      '初始版本',
    )}\n\n第四章 标题4\n林岚走进邮局。周叔在等。修改后的版本`;
    const third = await startTask({ ...baseOptions, content: changed });
    const thirdCalls = llm.calls.length - firstCalls;
    expect(thirdCalls).toBeGreaterThan(0);
    expect(thirdCalls).toBeLessThan(firstCalls);
    expect(third.cacheHits).toBeGreaterThan(0);
    close();
  });

  it('取消后状态为 cancelled，缓存保留', async () => {
    const { db, close } = await setup();
    const llm = new TaskLlm();
    llm.delayMs = 20;
    let runId = '';
    let cancelResult = false;

    const result = await startTask({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      bookTitle: '测试书',
      content: makeBook(2),
      taskType: 'generate-notes',
      chatConfig,
      llm,
      singlePassMaxTokens: 1,
      onEvent: (event) => {
        if (event.type === 'task_start') {
          runId = event.runId;
          setTimeout(() => {
            cancelResult = cancelTask(runId);
          }, 5);
        }
      },
    });

    expect(result.status).toBe('cancelled');
    expect(cancelResult).toBe(true);
    expect(isTaskRunning(runId)).toBe(false);
    close();
  });
});

describe('taskRunner characters', () => {
  it('运行人物关系分析并保存 Markdown', async () => {
    const { db, close } = await setup();
    const llm = new TaskLlm();

    const result = await startTask({
      db,
      userId: LOCAL_USER_ID,
      bookId: 'b1',
      bookTitle: '测试书',
      content: makeBook(2),
      taskType: 'character-analysis',
      chatConfig,
      llm,
    });

    expect(result.status).toBe('completed');
    expect(result.strategy).toBe('map-reduce');
    expect(result.characterCount).toBe(2);
    expect(result.mentionCount).toBeGreaterThanOrEqual(4);
    expect(result.content).toContain('人物关系分析');
    expect(result.content).toContain('关系网络');
    close();
  });
});

describe('isContextLengthError', () => {
  it('识别 400 context/length 错误', () => {
    const error = new Error('maximum context length exceeded') as Error & {
      status: number;
    };
    error.status = 400;
    expect(isContextLengthError(error)).toBe(true);

    const other = new Error('invalid api key') as Error & { status: number };
    other.status = 401;
    expect(isContextLengthError(other)).toBe(false);
  });
});
