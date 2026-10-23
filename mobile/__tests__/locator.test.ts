import { describe, expect, it } from 'vitest';
import {
  clampLocator,
  createEpubLocator,
  createTxtLocator,
  isValidLocator,
  locatorFromRow,
  locatorKey,
  locatorToRow,
  normalizeLocator,
} from '../src/reader/locator';

describe('locator', () => {
  it('创建 TXT locator', () => {
    expect(createTxtLocator(3, 8)).toEqual({ kind: 'txt', href: null, start: 3, end: 8 });
  });

  it('EPUB locator 必须有 href', () => {
    expect(createEpubLocator('chapter2.xhtml', 0, 10)).toEqual({
      kind: 'epub',
      href: 'chapter2.xhtml',
      start: 0,
      end: 10,
    });
    expect(() => createEpubLocator('  ', 0, 1)).toThrow();
  });

  it('负数和反向区间被归一化', () => {
    expect(createTxtLocator(-5, -1)).toEqual({ kind: 'txt', href: null, start: 0, end: 0 });
    expect(normalizeLocator({ kind: 'txt', href: null, start: 9, end: 3 })).toEqual({
      kind: 'txt',
      href: null,
      start: 9,
      end: 9,
    });
  });

  it('clamp 到文本长度内', () => {
    expect(clampLocator(createTxtLocator(5, 20), 10)).toEqual({
      kind: 'txt',
      href: null,
      start: 5,
      end: 10,
    });
    expect(clampLocator(createTxtLocator(20, 30), 10)).toEqual({
      kind: 'txt',
      href: null,
      start: 10,
      end: 10,
    });
  });

  it('数据库字段往返', () => {
    const locator = createEpubLocator('text/chapter1.xhtml', 12, 34);
    expect(locatorFromRow(locatorToRow(locator))).toEqual(locator);
  });

  it('校验合法 locator', () => {
    expect(isValidLocator(createTxtLocator(0, 5))).toBe(true);
    expect(isValidLocator({ kind: 'epub', href: null, start: 0, end: 5 })).toBe(false);
    expect(isValidLocator({ kind: 'txt', href: null, start: 5, end: 4 })).toBe(false);
    expect(isValidLocator({ kind: 'txt', href: null, start: 1.5, end: 4 })).toBe(false);
  });

  it('locatorKey 对等价 locator 稳定', () => {
    expect(locatorKey(createTxtLocator(-1, -2))).toBe(locatorKey(createTxtLocator(0, 0)));
  });
});
