import { describe, expect, it } from 'vitest';
import { LOCAL_USER_ID } from '../src/db/schema';
import {
  clearMemories,
  consolidateMemories,
  countMemories,
  deleteMemory,
  evictMemories,
  getMemoryById,
  insertMemory,
  listMemories,
  markMemorySuperseded,
  recallSimilarMemories,
  recordMemoryUsage,
  updateMemory,
} from '../src/db/repositories/memories';
import { createTestDb } from './helpers/testDb';

describe('memory repository', () => {
  it('写入、读取并按 conflict 更新同内容记忆', async () => {
    const { db, close } = await createTestDb();

    const id = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好简洁回答',
      salience: 0.8,
      sourceConv: 'conv-1',
      now: '2026-10-01T00:00:00.000Z',
    });
    expect(id).toBeGreaterThan(0);

    const secondId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好简洁回答',
      salience: 0.95,
      now: '2026-10-02T00:00:00.000Z',
    });

    expect(secondId).toBe(id);
    const memories = await listMemories(db, LOCAL_USER_ID);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id,
      layer: 'profile',
      status: 'active',
      salience: 0.95,
      sourceConv: 'conv-1',
    });
    close();
  });

  it('更新、supersede 与 active 过滤', async () => {
    const { db, close } = await createTestDb();

    const oldId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好长回答',
      salience: 0.7,
    });
    const newId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好短回答',
      salience: 0.9,
    });

    await updateMemory(db, LOCAL_USER_ID, oldId, {
      content: '用户偏好适中回答',
      salience: 0.8,
    });
    expect((await getMemoryById(db, LOCAL_USER_ID, oldId))?.content).toBe(
      '用户偏好适中回答',
    );

    await markMemorySuperseded(db, {
      userId: LOCAL_USER_ID,
      id: oldId,
      supersededBy: newId,
    });

    const active = await listMemories(db, LOCAL_USER_ID);
    expect(active.map((memory) => memory.id)).toEqual([newId]);

    const all = await listMemories(db, LOCAL_USER_ID, { includeSuperseded: true });
    const old = all.find((memory) => memory.id === oldId);
    expect(old).toMatchObject({ status: 'superseded', supersededBy: newId });

    await deleteMemory(db, LOCAL_USER_ID, newId);
    expect(await clearMemories(db, LOCAL_USER_ID)).toBe(1);
    close();
  });

  it('记录使用次数', async () => {
    const { db, close } = await createTestDb();
    const id = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'fact',
      layer: 'profile',
      content: '用户是研究生',
      salience: 1,
    });

    await recordMemoryUsage(db, {
      userId: LOCAL_USER_ID,
      ids: [id, id],
      now: '2026-10-23T00:00:00.000Z',
    });

    const memory = await getMemoryById(db, LOCAL_USER_ID, id);
    expect(memory?.useCount).toBe(1);
    expect(memory?.lastUsedAt).toBe('2026-10-23T00:00:00.000Z');
    close();
  });

  it('召回相似记忆：token 重叠与向量余弦', async () => {
    const { db, close } = await createTestDb();

    const historyId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'interest',
      layer: 'episodic',
      content: '明清史与明代政治',
      salience: 0.8,
    });
    await insertMemory(db, LOCAL_USER_ID, {
      kind: 'interest',
      layer: 'episodic',
      content: '量子物理与宇宙学',
      salience: 0.8,
    });

    const tokenHits = await recallSimilarMemories(db, {
      userId: LOCAL_USER_ID,
      content: '明清史',
    });
    expect(tokenHits[0].memory.id).toBe(historyId);

    await updateMemory(db, LOCAL_USER_ID, historyId, {
      embedding: Float32Array.from([1, 0, 0]),
    });
    const vectorHits = await recallSimilarMemories(db, {
      userId: LOCAL_USER_ID,
      content: '任意查询',
      queryEmbedding: Float32Array.from([1, 0, 0]),
    });
    expect(vectorHits[0].memory.id).toBe(historyId);
    close();
  });

  it('淘汰时优先删除 superseded 记录', async () => {
    const { db, close } = await createTestDb();

    const oldId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'fact',
      layer: 'profile',
      content: '旧记忆',
      salience: 0.1,
      now: '2026-01-01T00:00:00.000Z',
    });
    const keepA = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'fact',
      layer: 'profile',
      content: '保留 A',
      salience: 1,
      now: '2026-10-01T00:00:00.000Z',
    });
    const keepB = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'fact',
      layer: 'profile',
      content: '保留 B',
      salience: 1,
      now: '2026-10-02T00:00:00.000Z',
    });

    await markMemorySuperseded(db, {
      userId: LOCAL_USER_ID,
      id: oldId,
      supersededBy: keepA,
    });
    const deleted = await evictMemories(db, {
      userId: LOCAL_USER_ID,
      max: 2,
      now: '2026-10-23T00:00:00.000Z',
    });

    expect(deleted).toEqual([oldId]);
    const remaining = await listMemories(db, LOCAL_USER_ID, {
      includeSuperseded: true,
    });
    expect(remaining.map((memory) => memory.id).sort()).toEqual(
      [keepA, keepB].sort(),
    );
    close();
  });

  it('整理重复记忆并将低分记录标记 superseded', async () => {
    const { db, close } = await createTestDb();

    const firstId = await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好简洁回答',
      salience: 1,
    });
    await insertMemory(db, LOCAL_USER_ID, {
      kind: 'preference',
      layer: 'profile',
      content: '用户偏好 简洁回答！',
      salience: 0.5,
    });

    const result = await consolidateMemories(db, { userId: LOCAL_USER_ID });
    expect(result.merged).toBe(1);

    const active = await listMemories(db, LOCAL_USER_ID);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(firstId);
    expect(await countMemories(db, LOCAL_USER_ID, { activeOnly: true })).toBe(1);
    close();
  });
});
