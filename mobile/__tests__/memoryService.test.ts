import { describe, expect, it } from 'vitest';
import { LOCAL_USER_ID } from '../src/db/schema';
import {
  getMemoryById,
  insertMemory,
  listMemories,
} from '../src/db/repositories/memories';
import {
  buildMemoryInjection,
  consolidateMemoryStore,
  extractAndMergeMemories,
  maybeExtractAndMergeMemories,
  type MemoryLlmClient,
} from '../src/services/memory';
import { createTestDb } from './helpers/testDb';

class FakeLlm implements MemoryLlmClient {
  readonly prompts: string[] = [];
  private readonly responses: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.responses = [...responses];
  }

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (!response) throw new Error('no fake response');
    if (response instanceof Error) throw response;
    return response;
  }
}

const candidatesResponse = (content: string, layer = 'profile') =>
  JSON.stringify([
    {
      layer,
      kind: 'preference',
      content,
      evidence: '用户原话',
      confidence: 0.9,
      salience: 0.9,
    },
  ]);

const decisionsResponse = (
  op: 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'NOOP',
  targetId: number | null,
  content?: string,
) =>
  JSON.stringify([
    { candidateIndex: 0, op, targetId, content: content ?? null, reason: 'test' },
  ]);

describe('extractAndMergeMemories', () => {
  it('ADD 新记忆并记录来源', async () => {
    const { db, close } = await createTestDb();
    const llm = new FakeLlm([
      candidatesResponse('用户偏好分点回答'),
      decisionsResponse('ADD', null, '用户偏好分点回答'),
    ]);

    const result = await extractAndMergeMemories(
      {
        db,
        userId: LOCAL_USER_ID,
        llm,
        now: () => '2026-10-23T00:00:00.000Z',
      },
      {
        conversationId: 'conv-1',
        sourceMessageId: 12,
        messages: [
          { role: 'user', content: '以后回答请分点' },
          { role: 'assistant', content: '好的' },
        ],
      },
    );

    expect(result).toMatchObject({
      extracted: 1,
      added: 1,
      updated: 0,
      superseded: 0,
      noop: 0,
    });
    expect(llm.prompts[0]).toContain('长期记忆抽取器');
    expect(llm.prompts[1]).toContain('记忆合并判定器');

    const memories = await listMemories(db, LOCAL_USER_ID);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      layer: 'profile',
      content: '用户偏好分点回答',
      sourceConv: 'conv-1',
      sourceMessageId: 12,
      validFrom: '2026-10-23T00:00:00.000Z',
    });
    close();
  });

  it('UPDATE 覆盖已有记忆且不新增', async () => {
    const { db, close } = await createTestDb();
    const existingId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好简洁回答',
      salience: 0.6,
    });
    const llm = new FakeLlm([
      candidatesResponse('用户偏好更简洁的回答'),
      decisionsResponse('UPDATE', existingId, '用户偏好更简洁的回答'),
    ]);

    const result = await extractAndMergeMemories(
      { db, userId: LOCAL_USER_ID, llm },
      {
        conversationId: 'conv-2',
        messages: [{ role: 'user', content: '回答再简短一点' }],
      },
    );

    expect(result).toMatchObject({ updated: 1, added: 0 });
    const memories = await listMemories(db, LOCAL_USER_ID);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id: existingId,
      content: '用户偏好更简洁的回答',
    });
    close();
  });

  it('SUPERSEDE 将旧记忆标记为失效', async () => {
    const { db, close } = await createTestDb();
    const oldId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好长回答',
      salience: 0.7,
    });
    const llm = new FakeLlm([
      candidatesResponse('用户偏好短回答'),
      decisionsResponse('SUPERSEDE', oldId, '用户偏好短回答'),
    ]);

    const result = await extractAndMergeMemories(
      { db, userId: LOCAL_USER_ID, llm },
      {
        conversationId: 'conv-3',
        messages: [{ role: 'user', content: '以后回答短一点' }],
      },
    );

    expect(result).toMatchObject({ superseded: 1, added: 0 });
    const old = await getMemoryById(db, LOCAL_USER_ID, oldId);
    expect(old?.status).toBe('superseded');
    expect(old?.supersededBy).toBeTruthy();

    const active = await listMemories(db, LOCAL_USER_ID);
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe('用户偏好短回答');
    close();
  });

  it('抽取失败返回 error 且不写入', async () => {
    const { db, close } = await createTestDb();
    const llm = new FakeLlm([new Error('rate limited')]);

    const result = await extractAndMergeMemories(
      { db, userId: LOCAL_USER_ID, llm },
      {
        conversationId: 'conv-4',
        messages: [{ role: 'user', content: '你好' }],
      },
    );

    expect(result.error).toContain('rate limited');
    expect(await listMemories(db, LOCAL_USER_ID)).toEqual([]);
    close();
  });

  it('判定结果无法解析时不写入', async () => {
    const { db, close } = await createTestDb();
    const llm = new FakeLlm([
      candidatesResponse('用户关注明清史', 'episodic'),
      'not json',
    ]);

    const result = await extractAndMergeMemories(
      { db, userId: LOCAL_USER_ID, llm },
      {
        conversationId: 'conv-5',
        messages: [{ role: 'user', content: '我在读明清史' }],
      },
    );

    expect(result.error).toBe('adjudication_parse_failed');
    expect(await listMemories(db, LOCAL_USER_ID)).toEqual([]);
    close();
  });
});

describe('maybeExtractAndMergeMemories', () => {
  it('未到门槛时跳过且不调用模型', async () => {
    const { db, close } = await createTestDb();
    const llm = new FakeLlm([]);

    const result = await maybeExtractAndMergeMemories(
      { db, userId: LOCAL_USER_ID, llm },
      {
        conversationId: 'conv-1',
        messages: [{ role: 'user', content: '你好' }],
        userTurnsSinceExtract: 3,
        idleMs: 1000,
      },
    );

    expect(result).toMatchObject({ skipped: true, reason: 'not_due' });
    expect(llm.prompts).toHaveLength(0);
    close();
  });

  it('达到轮次门槛时执行抽取', async () => {
    const { db, close } = await createTestDb();
    const llm = new FakeLlm([
      candidatesResponse('用户偏好分点回答'),
      decisionsResponse('ADD', null),
    ]);

    const result = await maybeExtractAndMergeMemories(
      { db, userId: LOCAL_USER_ID, llm },
      {
        conversationId: 'conv-1',
        messages: [{ role: 'user', content: '请分点回答' }],
        userTurnsSinceExtract: 10,
        idleMs: 0,
      },
    );

    expect(result.added).toBe(1);
    close();
  });
});

describe('buildMemoryInjection', () => {
  it('profile 常驻、episodic 相关、procedural 仅任务模式', async () => {
    const { db, close } = await createTestDb();
    const profileId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好简洁回答',
      salience: 1,
    });
    const episodicId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'interest',
      layer: 'episodic',
      content: '明清史与明代政治',
      salience: 1,
    });
    const proceduralId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'procedural',
      content: '笔记使用二级标题',
      salience: 1,
    });

    const normal = await buildMemoryInjection(
      { db, userId: LOCAL_USER_ID, llm: new FakeLlm([]) },
      { query: '明清史' },
    );

    expect(normal.ids).toContain(profileId);
    expect(normal.ids).toContain(episodicId);
    expect(normal.ids).not.toContain(proceduralId);
    expect(normal.text).toContain('【用户画像】');
    expect(normal.text).toContain('【相关阅读经历】');

    const usage = await getMemoryById(db, LOCAL_USER_ID, profileId);
    expect(usage?.useCount).toBe(1);

    const task = await buildMemoryInjection(
      { db, userId: LOCAL_USER_ID, llm: new FakeLlm([]) },
      { query: '明清史', taskType: 'generate-notes' },
    );
    expect(task.ids).toContain(proceduralId);
    expect(task.text).toContain('【任务偏好】');
    close();
  });

  it('整理入口合并重复记忆', async () => {
    const { db, close } = await createTestDb();
    await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好简洁回答',
      salience: 1,
    });
    await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好 简洁回答！',
      salience: 0.4,
    });

    const result = await consolidateMemoryStore({
      db,
      userId: LOCAL_USER_ID,
      llm: new FakeLlm([]),
    });
    expect(result.merged).toBe(1);
    expect(await listMemories(db, LOCAL_USER_ID)).toHaveLength(1);
    close();
  });
});
