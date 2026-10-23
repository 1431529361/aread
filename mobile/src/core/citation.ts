import type { Evidence, Locator, RetrievalHit } from './types';

export const DEFAULT_EVIDENCE_MAX_CHARS = 3000;
export const DEFAULT_EVIDENCE_MAX_ITEMS = 5;

export function formatLocator(loc: Locator): string {
  if (loc.kind === 'epub') return `${loc.href ?? ''}:${loc.start}-${loc.end}`;
  return `txt:${loc.start}-${loc.end}`;
}

/**
 * 构造固定格式的证据块：[Cn] 书名/章节 | locator | 原文片段。
 * 返回的 citationId 从 1 开始，供最终答案引用与后处理校验。
 */
export function buildEvidenceBlocks(
  hits: readonly RetrievalHit[],
  options: { maxChars?: number; maxItems?: number } = {},
): Evidence[] {
  const maxChars = options.maxChars ?? DEFAULT_EVIDENCE_MAX_CHARS;
  const maxItems = options.maxItems ?? DEFAULT_EVIDENCE_MAX_ITEMS;
  const evidence: Evidence[] = [];
  let used = 0;

  for (const hit of hits.slice(0, maxItems)) {
    const citationId = evidence.length + 1;
    const header = `[C${citationId}] 《${hit.bookTitle || '未知书籍'}/${hit.chapter || '未知章节'} | ${formatLocator(hit.loc)} | `;
    const remaining = maxChars - used;
    if (remaining <= header.length + 20) break;

    const sourceText =
      hit.parentText && hit.parentText.trim() ? hit.parentText : hit.text;
    const textBudget = Math.min(sourceText.length, remaining - header.length);
    const text = sourceText.slice(0, textBudget).trim();
    if (!text) continue;

    evidence.push({ citationId, hit: { ...hit, text } });
    used += header.length + text.length + 1;
  }

  return evidence;
}

export function evidenceIds(evidence: readonly Evidence[]): number[] {
  return evidence.map((item) => item.citationId);
}

export function buildEvidenceMessage(evidence: readonly Evidence[]): string {
  if (evidence.length === 0) return '';

  const blocks = evidence
    .map(
      (item) =>
        `[C${item.citationId}] 《${item.hit.bookTitle || '未知书籍'}/${item.hit.chapter || '未知章节'} | ${formatLocator(item.hit.loc)} | ${item.hit.text}`,
    )
    .join('\n');

  return `以下是系统预检索到的书中证据（按相关度排序）。引用书中内容时必须基于这些证据，并在句末标注对应编号，如 [C1]；不要编造证据之外的书中细节。

${blocks}`;
}

/** 解析答案中的 [Cn] 引用编号（去重，保持出现顺序）。 */
export function parseCitationIds(answer: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const re = /\[C(\d+)\]/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(answer)) !== null) {
    const id = Number(match[1]);
    if (!Number.isInteger(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

export interface CitationSanitizeResult {
  answer: string;
  removedIds: number[];
}

/** 删除不存在的引用标记；合法标记统一成 [C1] 形式。 */
export function sanitizeCitations(
  answer: string,
  validIds: Iterable<number>,
): CitationSanitizeResult {
  const valid = new Set(validIds);
  const removed = new Set<number>();

  const sanitized = answer.replace(/\[C(\d+)\]/gi, (match, raw: string) => {
    const id = Number(raw);
    if (valid.has(id)) return `[C${id}]`;
    removed.add(id);
    return '';
  });

  return {
    answer: sanitized.replace(/[ \t]+\n/g, '\n').trim(),
    removedIds: [...removed],
  };
}
