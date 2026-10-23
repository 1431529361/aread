import type { Locator, LocatorKind, LocatorRow } from '../core/types';

export type { Locator, LocatorKind, LocatorRow };

export function createTxtLocator(start: number, end: number): Locator {
  return normalizeLocator({ kind: 'txt', href: null, start, end });
}

export function createEpubLocator(href: string, start: number, end: number): Locator {
  if (!href.trim()) throw new Error('EPUB locator 需要非空 href');
  return normalizeLocator({ kind: 'epub', href, start, end });
}

export function normalizeLocator(locator: Locator): Locator {
  const start = Number.isFinite(locator.start) ? Math.max(0, Math.floor(locator.start)) : 0;
  const end = Number.isFinite(locator.end) ? Math.max(start, Math.floor(locator.end)) : start;
  return {
    kind: locator.kind === 'epub' ? 'epub' : 'txt',
    href: locator.kind === 'epub' ? locator.href : null,
    start,
    end,
  };
}

export function isValidLocator(locator: Locator): boolean {
  if (locator.kind !== 'txt' && locator.kind !== 'epub') return false;
  if (locator.kind === 'epub' && !locator.href) return false;
  return (
    Number.isInteger(locator.start) &&
    Number.isInteger(locator.end) &&
    locator.start >= 0 &&
    locator.end >= locator.start
  );
}

/** 将 locator 夹到文本长度范围内（引用跳转、重新渲染时使用）。 */
export function clampLocator(locator: Locator, textLength: number): Locator {
  const max = Math.max(0, Math.floor(textLength));
  const start = Math.min(Math.max(0, Math.floor(locator.start)), max);
  const end = Math.min(Math.max(start, Math.floor(locator.end)), max);
  return { ...normalizeLocator(locator), start, end };
}

export function locatorToRow(locator: Locator): LocatorRow {
  const normalized = normalizeLocator(locator);
  return {
    loc_kind: normalized.kind,
    loc_href: normalized.href,
    loc_start: normalized.start,
    loc_end: normalized.end,
  };
}

export function locatorFromRow(row: LocatorRow): Locator {
  return normalizeLocator({
    kind: row.loc_kind,
    href: row.loc_href,
    start: row.loc_start,
    end: row.loc_end,
  });
}

/** 划线去重/定位用的稳定 key。 */
export function locatorKey(locator: Locator): string {
  const normalized = normalizeLocator(locator);
  return `${normalized.kind}:${normalized.href ?? ''}:${normalized.start}:${normalized.end}`;
}
