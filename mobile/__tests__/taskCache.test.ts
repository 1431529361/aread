import { describe, expect, it } from 'vitest';
import {
  clearTaskCache,
  countTaskCache,
  getCachedNode,
  putCachedNode,
} from '../src/db/repositories/taskCache';
import { createTestDb } from './helpers/testDb';

const base = {
  bookId: 'b1',
  taskType: 'generate-notes' as const,
  unitKey: 'chunk:0:0',
  unitHash: 'hash-a',
  promptVersion: 'notes-v1',
  modelSig: 'model-a',
};

describe('task_node_cache', () => {
  it('命中相同输入，输入或模型签名变化则失效', async () => {
    const { db, close } = await createTestDb();
    await putCachedNode(db, { ...base, output: { summary: '缓存结果' } });

    expect(await getCachedNode(db, base)).toEqual({ summary: '缓存结果' });
    expect(await getCachedNode(db, { ...base, unitHash: 'hash-b' })).toBeNull();
    expect(await getCachedNode(db, { ...base, modelSig: 'model-b' })).toBeNull();
    expect(
      await getCachedNode(db, { ...base, promptVersion: 'notes-v2' }),
    ).toBeNull();
    close();
  });

  it('相同键重新写入时更新输出', async () => {
    const { db, close } = await createTestDb();
    await putCachedNode(db, { ...base, output: { value: 1 } });
    await putCachedNode(db, { ...base, output: { value: 2 } });

    expect(await getCachedNode(db, base)).toEqual({ value: 2 });
    expect(await countTaskCache(db, { bookId: 'b1' })).toBe(1);
    close();
  });

  it('可按任务清理缓存', async () => {
    const { db, close } = await createTestDb();
    await putCachedNode(db, { ...base, output: { value: 1 } });
    await putCachedNode(db, {
      ...base,
      taskType: 'character-analysis',
      output: { value: 2 },
    });

    expect(await clearTaskCache(db, { bookId: 'b1' })).toBe(2);
    expect(await countTaskCache(db, { bookId: 'b1' })).toBe(0);
    close();
  });
});
