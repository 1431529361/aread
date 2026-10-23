import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX_CHARS,
  BATCH_MAX_CHAPTERS,
  isShortChapter,
  planChapterBatches,
  validateChapterBatch,
} from '../src/core/orchestrator/batchPlan';

function unit(
  chapterIndex: number,
  chars: number,
): { chapterIndex: number; title: string; text: string } {
  return {
    chapterIndex,
    title: `第${chapterIndex + 1}章`,
    text: '字'.repeat(chars),
  };
}

describe('planChapterBatches', () => {
  it('20 个 1.5k 短章打包为 7 次调用', () => {
    const units = Array.from({ length: 20 }, (_, index) => unit(index, 1500));
    const batches = planChapterBatches(units);

    expect(batches).toHaveLength(7);
    expect(batches.every((batch) => batch.length <= BATCH_MAX_CHAPTERS)).toBe(true);
    expect(batches.every((batch) => batch.reduce((sum, item) => sum + item.text.length, 0) <= BATCH_MAX_CHARS)).toBe(true);
    expect(batches.reduce((sum, batch) => sum + batch.length, 0)).toBe(20);
  });

  it('字符预算先到时提前结束批次', () => {
    const batches = planChapterBatches([
      unit(0, 7000),
      unit(1, 7000),
      unit(2, 1000),
    ]);
    expect(batches).toHaveLength(2);
    expect(batches[0].map((item) => item.chapterIndex)).toEqual([0]);
    expect(batches[1].map((item) => item.chapterIndex)).toEqual([1, 2]);
  });

  it('只打包传入的未缓存章节', () => {
    const batches = planChapterBatches([unit(2, 1000), unit(5, 1000)]);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((item) => item.chapterIndex)).toEqual([2, 5]);
  });

  it('超过 14k 的章节不算短章节', () => {
    expect(isShortChapter('字'.repeat(14000))).toBe(true);
    expect(isShortChapter('字'.repeat(14001))).toBe(false);
  });
});

describe('validateChapterBatch', () => {
  it('校验齐全、数量一致且无重复', () => {
    const result = validateChapterBatch<{ chapterIndex: number; value: string }>(
      [
        { chapterIndex: 2, value: 'b' },
        { chapterIndex: 0, value: 'a' },
      ],
      [0, 2],
    );
    expect(result?.get(0)).toMatchObject({ value: 'a' });
    expect(result?.get(2)).toMatchObject({ value: 'b' });
  });

  it('缺章、重复或额外章节都拒绝', () => {
    expect(validateChapterBatch([{ chapterIndex: 0 }], [0, 1])).toBeNull();
    expect(
      validateChapterBatch(
        [{ chapterIndex: 0 }, { chapterIndex: 0 }],
        [0, 1],
      ),
    ).toBeNull();
    expect(
      validateChapterBatch(
        [{ chapterIndex: 0 }, { chapterIndex: 1 }, { chapterIndex: 2 }],
        [0, 1],
      ),
    ).toBeNull();
    expect(validateChapterBatch([{ chapterIndex: 9 }], [0, 1])).toBeNull();
  });
});
