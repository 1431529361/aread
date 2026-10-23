import { formatLocator } from '../citation';
import { truncateToTokenBudget } from '../context/tokens';
import { sha256Hex } from '../embedding/sha256';
import { splitChapters } from '../rag/chapters';
import { chunkText } from '../rag/chunk';
import type { Locator } from '../types';
import {
  isShortChapter,
  planChapterBatches,
  validateChapterBatch,
} from './batchPlan';
import { cachedNode } from './cache';
import type { DagNode } from './dag';
import { completeJson } from './json';
import {
  CHARACTERS_PROMPT_VERSION,
  buildCharacterAnalysisPrompt,
  buildCharacterMentionPrompt,
  buildChapterBatchMentionPrompt,
  buildRelationshipReportPrompt,
} from './prompts';
import type { OrchestratorEnv } from './types';

const CHARACTER_CHUNK_SIZE = 6000;
const CHARACTER_CHUNK_OVERLAP = 300;
const MAX_MAIN_CHARACTERS = 8;
const MAX_MENTIONS_PER_CHARACTER = 12;
const MAX_MENTION_CHARS = 6000;

const STOP_NAMES = new Set([
  '他',
  '她',
  '它',
  '他们',
  '她们',
  '我们',
  '你们',
  '我',
  '你',
  '自己',
  '大家',
  '众人',
  '有人',
  '作者',
]);

export interface CharacterChunkPlan {
  chapterIndex: number;
  chunkIndex: number;
  chapterTitle: string;
  text: string;
  loc: Locator;
}

interface RawMention {
  name: string;
  aliases: string[];
  quote: string;
  roleHint?: string;
}

export interface CharacterMention {
  name: string;
  aliases: string[];
  quote: string;
  roleHint?: string;
  chapterIndex: number;
  chapterTitle: string;
  loc: Locator;
}

export interface CharacterAggregate {
  name: string;
  aliases: string[];
  mentionCount: number;
  chapterCount: number;
  mentions: CharacterMention[];
}

export interface SelectedMention {
  id: string;
  quote: string;
  chapterTitle: string;
  loc: Locator;
  roleHint?: string;
}

export interface CharacterAnalysisValue {
  name: string;
  aliases: string[];
  mentionCount: number;
  chapterCount: number;
  overview: string;
  traits: string[];
  arc: string;
  relationships: Array<{ target: string; description: string }>;
  citations: SelectedMention[];
  degraded: boolean;
}

export interface CharacterFinalValue {
  markdown: string;
  coverage: number;
  missingChunks: string[];
  degraded: boolean;
  characterCount: number;
  mentionCount: number;
  analyses: CharacterAnalysisValue[];
}

export interface CharacterPlan {
  nodes: DagNode[];
  finalNodeId: string;
  chunkCount: number;
}

export function normalizePersonName(name: string): string {
  return name
    .replace(/[“”"'「」『』《》〈〉（）()【】\[\]\s·•.,，。!！?？:：;；、\-—_]/g, '')
    .toLowerCase();
}

function isUsableName(name: string): boolean {
  const normalized = normalizePersonName(name);
  return normalized.length >= 2 && normalized.length <= 40 && !STOP_NAMES.has(normalized);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMentions(value: unknown): RawMention[] {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { mentions?: unknown }).mentions)
      ? ((value as { mentions: unknown[] }).mentions)
      : [];

  const mentions: RawMention[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    if (!isUsableName(name)) continue;
    const aliases = asStringArray(record.aliases).filter(isUsableName);
    const quote = asString(record.quote).substring(0, 220);
    if (!quote) continue;
    mentions.push({
      name,
      aliases,
      quote,
      roleHint: asString(record.roleHint) || undefined,
    });
  }
  return mentions;
}

export function normalizeRawMentionCache(
  value: unknown,
): { mentions: RawMention[]; degraded: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { mentions?: unknown; degraded?: unknown };
  if (!Array.isArray(record.mentions)) return null;
  return {
    mentions: parseMentions(record.mentions),
    degraded: Boolean(record.degraded),
  };
}

export function locateQuote(
  chunk: CharacterChunkPlan,
  quote: string,
): Locator {
  const index = chunk.text.indexOf(quote);
  if (index < 0) return chunk.loc;
  return {
    kind: chunk.loc.kind,
    href: chunk.loc.href,
    start: chunk.loc.start + index,
    end: chunk.loc.start + index + quote.length,
  };
}

function dedupeMentions(mentions: readonly CharacterMention[]): CharacterMention[] {
  const seen = new Set<string>();
  const result: CharacterMention[] = [];
  for (const mention of mentions) {
    const key = `${normalizePersonName(mention.name)}|${mention.loc.kind}|${mention.loc.href ?? ''}|${mention.loc.start}|${mention.loc.end}|${mention.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(mention);
  }
  return result;
}

/** 确定性别名合并：同一提及中的 name/aliases 连边，按出现频率选规范名。 */
export function aggregateCharacterMentions(
  mentions: readonly CharacterMention[],
): CharacterAggregate[] {
  const parent = new Map<string, string>();

  const find = (value: string): string => {
    let current = value;
    while (parent.get(current) !== current) current = parent.get(current)!;
    while (parent.get(value) !== current) {
      const next = parent.get(value)!;
      parent.set(value, current);
      value = next;
    }
    return current;
  };

  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const mention of mentions) {
    const variants = [mention.name, ...mention.aliases]
      .map((name) => ({ display: name.trim(), normalized: normalizePersonName(name) }))
      .filter((item) => isUsableName(item.display));
    if (variants.length === 0) continue;

    for (const variant of variants) {
      if (!parent.has(variant.normalized)) parent.set(variant.normalized, variant.normalized);
    }

    for (const variant of variants.slice(1)) {
      union(variants[0].normalized, variant.normalized);
    }
  }

  const canonicalByRoot = new Map<string, string>();
  for (const normalized of parent.keys()) {
    const root = find(normalized);
    if (!canonicalByRoot.has(root)) canonicalByRoot.set(root, normalized);
  }

  const groups = new Map<string, CharacterMention[]>();
  for (const mention of mentions) {
    const normalized = normalizePersonName(mention.name);
    if (!isUsableName(mention.name) || !parent.has(normalized)) continue;
    const root = find(normalized);
    const group = groups.get(root) ?? [];
    group.push(mention);
    groups.set(root, group);
  }

  const characters: CharacterAggregate[] = [];

  for (const [root, group] of groups) {
    const variants = new Map<string, number>();
    const nameCounts = new Map<string, number>();

    for (const mention of group) {
      const name = mention.name.trim();
      if (isUsableName(name)) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      for (const display of [mention.name, ...mention.aliases]) {
        if (!isUsableName(display)) continue;
        variants.set(display.trim(), (variants.get(display.trim()) ?? 0) + 1);
      }
    }

    const canonical =
      [...nameCounts.entries()].sort(
        (a, b) => b[1] - a[1] || b[0].length - a[0].length,
      )[0]?.[0] ??
      [...variants.entries()].sort(
        (a, b) => b[1] - a[1] || b[0].length - a[0].length,
      )[0]?.[0] ??
      canonicalByRoot.get(root) ??
      '未知人物';
    const aliases = [...variants.keys()]
      .filter((name) => name !== canonical)
      .sort((a, b) => b.length - a.length)
      .slice(0, 6);
    const deduped = dedupeMentions(group).sort(
      (a, b) =>
        a.chapterIndex - b.chapterIndex || a.loc.start - b.loc.start,
    );
    const chapters = new Set(deduped.map((mention) => mention.chapterIndex));

    characters.push({
      name: canonical,
      aliases,
      mentionCount: deduped.length,
      chapterCount: chapters.size,
      mentions: deduped,
    });
  }

  return characters.sort((a, b) => b.mentionCount - a.mentionCount);
}

function selectMentions(
  mentions: readonly CharacterMention[],
): SelectedMention[] {
  const byChapter = new Map<number, CharacterMention[]>();
  for (const mention of mentions) {
    const group = byChapter.get(mention.chapterIndex) ?? [];
    group.push(mention);
    byChapter.set(mention.chapterIndex, group);
  }

  const selected: CharacterMention[] = [];
  let chars = 0;
  const chapterIndices = [...byChapter.keys()].sort((a, b) => a - b);
  const chapterSample =
    chapterIndices.length <= MAX_MENTIONS_PER_CHARACTER
      ? chapterIndices
      : Array.from({ length: MAX_MENTIONS_PER_CHARACTER }, (_, index) =>
          chapterIndices[
            Math.floor((index * chapterIndices.length) / MAX_MENTIONS_PER_CHARACTER)
          ],
        );

  const add = (mention: CharacterMention): boolean => {
    if (selected.length >= MAX_MENTIONS_PER_CHARACTER) return false;
    if (selected.includes(mention)) return false;
    if (chars + mention.quote.length > MAX_MENTION_CHARS) return false;
    selected.push(mention);
    chars += mention.quote.length;
    return true;
  };

  // 先保证跨章节覆盖（每个抽样章节 1 条），再补第二条，最后填满预算
  for (const chapterIndex of chapterSample) {
    const mention = (byChapter.get(chapterIndex) ?? [])[0];
    if (mention) add(mention);
  }
  for (const chapterIndex of chapterSample) {
    const mentions = byChapter.get(chapterIndex) ?? [];
    if (mentions[1]) add(mentions[1]);
  }
  for (const mention of mentions) {
    if (selected.length >= MAX_MENTIONS_PER_CHARACTER) break;
    add(mention);
  }

  return selected.map((mention, index) => ({
    id: `M${index + 1}`,
    quote: mention.quote,
    chapterTitle: mention.chapterTitle,
    loc: mention.loc,
    roleHint: mention.roleHint,
  }));
}

function normalizeCharacterAnalysis(
  value: unknown,
  selected: readonly SelectedMention[],
): {
  overview: string;
  traits: string[];
  arc: string;
  relationships: Array<{ target: string; description: string }>;
  citationIds: string[];
} | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const overview = asString(record.overview);
  if (!overview) return null;
  const relationships = Array.isArray(record.relationships)
    ? record.relationships
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object',
        )
        .map((item) => ({
          target: asString(item.target),
          description: asString(item.description),
        }))
        .filter((item) => item.target && item.description)
    : [];
  const validIds = new Set(selected.map((mention) => mention.id));
  const citationIds = asStringArray(record.citations).filter((id) =>
    validIds.has(id),
  );
  return {
    overview,
    traits: asStringArray(record.traits),
    arc: asString(record.arc),
    relationships,
    citationIds:
      citationIds.length > 0
        ? citationIds
        : selected.slice(0, 3).map((mention) => mention.id),
  };
}

function assembleCharacterMarkdown(params: {
  bookTitle: string;
  totalMentions: number;
  characters: CharacterAggregate[];
  analyses: CharacterAnalysisValue[];
  report: {
    overview: string;
    network: Array<{ from: string; to: string; relation: string }>;
    conclusion: string;
  };
}): string {
  const lines = [
    `# 《${params.bookTitle}》人物关系分析`,
    '',
    '## 人物概览',
    '',
    params.report.overview ||
      `全书共识别 ${params.characters.length} 个主要人物，累计提及 ${params.totalMentions} 次。`,
    '',
    '## 人物分析',
    '',
  ];

  for (const analysis of params.analyses) {
    lines.push(
      `### ${analysis.name}${
        analysis.aliases.length ? `（${analysis.aliases.join('、')}）` : ''
      }`,
      '',
      `- 全书提及：${analysis.mentionCount} 次，覆盖 ${analysis.chapterCount} 章`,
      '',
      analysis.overview,
      '',
    );
    if (analysis.traits.length > 0) {
      lines.push(`**性格特点**：${analysis.traits.join('、')}`, '');
    }
    if (analysis.arc) lines.push(`**人物弧光**：${analysis.arc}`, '');
    if (analysis.relationships.length > 0) {
      lines.push('**人物关系**：');
      for (const relation of analysis.relationships) {
        lines.push(`- ${relation.target}：${relation.description}`);
      }
      lines.push('');
    }
    if (analysis.citations.length > 0) {
      lines.push('**原文引用**：');
      for (const citation of analysis.citations) {
        lines.push(
          `- “${citation.quote}” — ${citation.chapterTitle}，${formatLocator(citation.loc)}`,
        );
      }
      lines.push('');
    }
  }

  lines.push('## 关系网络', '');
  if (params.report.network.length > 0) {
    for (const relation of params.report.network) {
      lines.push(`- ${relation.from} ↔ ${relation.to}：${relation.relation}`);
    }
  } else {
    for (const analysis of params.analyses) {
      for (const relation of analysis.relationships) {
        lines.push(`- ${analysis.name} ↔ ${relation.target}：${relation.description}`);
      }
    }
  }
  lines.push('', '## 总结', '', params.report.conclusion || '（总结生成失败）', '');

  return lines.join('\n');
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function buildCharacterPlan(
  env: OrchestratorEnv,
  content: string,
): CharacterPlan {
  const chapters = splitChapters(content).map((chapter, chapterIndex) => {
    const isLong = !isShortChapter(chapter.text);
    const chunks = isLong
      ? chunkText(chapter.text, {
          chunkSize: CHARACTER_CHUNK_SIZE,
          overlap: CHARACTER_CHUNK_OVERLAP,
        }).map((chunk, chunkIndex) => ({
          chapterIndex,
          chunkIndex,
          chapterTitle: chapter.title,
          text: chunk.text,
          loc: {
            kind: 'txt' as const,
            href: null,
            start: chapter.start + chunk.loc_start,
            end: chapter.start + chunk.loc_end,
          },
        }))
      : [];

    return {
      chapterIndex,
      title: chapter.title,
      text: chapter.text,
      loc: {
        kind: 'txt' as const,
        href: null,
        start: chapter.start,
        end: chapter.end,
      },
      isLong,
      chunks,
    };
  });

  const nodes: DagNode[] = [];
  const mentionNodeIds: string[] = [];

  const SHORT_MENTION_MAP_ID = 'mention:short-chapters';
  const shortChapters = chapters.filter((chapter) => !chapter.isLong);

  if (shortChapters.length > 0) {
    nodes.push({
      id: SHORT_MENTION_MAP_ID,
      name: '短章节批量人物提及',
      deps: [],
      async run(context) {
        const results = new Map<
          number,
          { mentions: RawMention[]; degraded: boolean }
        >();
        const total = shortChapters.length;
        let done = 0;
        const tick = (): void => {
          done++;
          context.progress({ stage: 'mentions', done, total });
        };
        const uncached: typeof shortChapters = [];

        for (const chapter of shortChapters) {
          const unitKey = `mention:chapter:${chapter.chapterIndex}`;
          const inputHash = sha256Hex(
            `${env.bookTitle}|${chapter.title}|${chapter.text}`,
          );
          const cached = await env.cache.get(unitKey, inputHash);
          const normalized = normalizeRawMentionCache(cached);
          if (normalized) {
            results.set(chapter.chapterIndex, normalized);
            tick();
          } else {
            uncached.push(chapter);
          }
        }

        const batches = planChapterBatches(
          uncached.map((chapter) => ({
            chapterIndex: chapter.chapterIndex,
            title: chapter.title,
            text: chapter.text,
          })),
        );

        const processBatch = async (
          batch: (typeof batches)[number],
        ): Promise<void> => {
          if (context.signal?.aborted) throw new Error('任务已取消');
          const expected = batch.map((item) => item.chapterIndex);
          let mapped: Map<
            number,
            { mentions: RawMention[]; degraded: boolean }
          > | null = null;

          for (let attempt = 0; attempt < 2 && mapped === null; attempt++) {
            try {
              const completion = await completeJson<unknown>({
                llm: env.llm,
                prompt: buildChapterBatchMentionPrompt({
                  bookTitle: env.bookTitle,
                  chapters: batch,
                }),
                schemaHint:
                  '[{"chapterIndex":0,"mentions":[{"name":"...","aliases":["..."],"quote":"...","roleHint":"..."}]}]',
                maxTokens: 2600,
                temperature: 0.1,
                signal: context.signal,
              });
              const candidate = validateChapterBatch<{
                chapterIndex: number;
                mentions?: unknown;
              }>(completion.data, expected);
              if (!candidate) continue;

              const normalized = new Map<
                number,
                { mentions: RawMention[]; degraded: boolean }
              >();
              let valid = true;
              for (const index of expected) {
                const item = candidate.get(index);
                if (!item || !Array.isArray(item.mentions)) {
                  valid = false;
                  break;
                }
                normalized.set(index, {
                  mentions: parseMentions(item.mentions),
                  degraded: false,
                });
              }
              if (valid) mapped = normalized;
            } catch {
              // 下一轮尝试或逐章降级
            }
          }

          if (mapped) {
            for (const item of batch) {
              const chapter = shortChapters.find(
                (entry) => entry.chapterIndex === item.chapterIndex,
              )!;
              const data = mapped.get(item.chapterIndex)!;
              results.set(item.chapterIndex, data);
              await env.cache.set(
                `mention:chapter:${chapter.chapterIndex}`,
                sha256Hex(`${env.bookTitle}|${chapter.title}|${chapter.text}`),
                data,
              );
              tick();
            }
            return;
          }

          // 批量结果错位/缺失时逐章重抽，避免跨章错配
          for (const item of batch) {
            if (context.signal?.aborted) throw new Error('任务已取消');
            const chapter = shortChapters.find(
              (entry) => entry.chapterIndex === item.chapterIndex,
            )!;
            const unitKey = `mention:chapter:${chapter.chapterIndex}`;
            const inputHash = sha256Hex(
              `${env.bookTitle}|${chapter.title}|${chapter.text}`,
            );
            let data: { mentions: RawMention[]; degraded: boolean };
            try {
              const completion = await completeJson<unknown>({
                llm: env.llm,
                prompt: buildCharacterMentionPrompt({
                  bookTitle: env.bookTitle,
                  chapterTitle: chapter.title,
                  text: chapter.text,
                }),
                schemaHint:
                  '[{"name":"...","aliases":["..."],"quote":"...","roleHint":"..."}]',
                maxTokens: 1200,
                temperature: 0.1,
                signal: context.signal,
              });
              data = {
                mentions: parseMentions(completion.data),
                degraded:
                  completion.data === null &&
                  parseMentions(completion.data).length === 0,
              };
            } catch {
              data = { mentions: [], degraded: true };
            }
            results.set(chapter.chapterIndex, data);
            await env.cache.set(unitKey, inputHash, data);
            tick();
          }
        };

        const batchConcurrency = chapters.some((chapter) => chapter.isLong)
          ? 1
          : 3;
        for (let i = 0; i < batches.length; i += batchConcurrency) {
          await Promise.all(
            batches.slice(i, i + batchConcurrency).map(processBatch),
          );
        }

        return {
          chapters: Object.fromEntries(results) as Record<
            number,
            { mentions: RawMention[]; degraded: boolean }
          >,
        };
      },
    });
  }

  for (const chapter of chapters) {
    if (!chapter.isLong) continue;
    for (const chunk of chapter.chunks) {
      const id = `mention:${chapter.chapterIndex}:${chunk.chunkIndex}`;
      mentionNodeIds.push(id);
      nodes.push({
        id,
        name: `人物提及 ${chapter.chapterIndex + 1}-${chunk.chunkIndex + 1}`,
        deps: [],
        async run(context) {
          const result = await cachedNode<{
            mentions: RawMention[];
            degraded: boolean;
          }>(env.cache, id, `${env.bookTitle}|${chapter.title}|${chunk.text}`, async () => {
            const completion = await completeJson<unknown>({
              llm: env.llm,
              prompt: buildCharacterMentionPrompt({
                bookTitle: env.bookTitle,
                chapterTitle: chapter.title,
                text: chunk.text,
              }),
              schemaHint:
                '[{"name":"...","aliases":["..."],"quote":"...","roleHint":"..."}]',
              maxTokens: 800,
              temperature: 0.1,
              signal: context.signal,
            });
            const parsed = parseMentions(completion.data);
            return {
              mentions: parsed,
              degraded: completion.data === null && parsed.length === 0,
            };
          });

          const mentions = dedupeMentions(
            result.value.mentions.map((mention) => ({
              ...mention,
              chapterIndex: chapter.chapterIndex,
              chapterTitle: chapter.title,
              loc: locateQuote(chunk, mention.quote),
            })),
          );
          context.progress({
            stage: 'mentions',
            done: chunk.chunkIndex + 1,
            total: chapter.chunks.length,
            cached: result.cached,
          });
          return { mentions, degraded: result.value.degraded };
        },
      });
    }
  }

  for (const chapter of shortChapters) {
    const id = `mention:${chapter.chapterIndex}:0`;
    mentionNodeIds.push(id);
    nodes.push({
      id,
      name: `人物提及 ${chapter.chapterIndex + 1}`,
      deps: [SHORT_MENTION_MAP_ID],
      async run(context) {
        const shortMap = context.getOutput<{
          chapters: Record<
            number,
            { mentions: RawMention[]; degraded: boolean }
          >;
        }>(SHORT_MENTION_MAP_ID);
        const data = shortMap?.chapters[chapter.chapterIndex];
        const chapterChunk: CharacterChunkPlan = {
          chapterIndex: chapter.chapterIndex,
          chunkIndex: 0,
          chapterTitle: chapter.title,
          text: chapter.text,
          loc: chapter.loc,
        };
        const mentions = dedupeMentions(
          (data?.mentions ?? []).map((mention) => ({
            ...mention,
            chapterIndex: chapter.chapterIndex,
            chapterTitle: chapter.title,
            loc: locateQuote(chapterChunk, mention.quote),
          })),
        );
        return {
          mentions,
          degraded: data?.degraded ?? !data,
        };
      },
    });
  }

  const aggregateId = 'aggregate:characters';
  nodes.push({
    id: aggregateId,
    name: '人物聚合',
    deps: mentionNodeIds,
    async run(context) {
      const mentions: CharacterMention[] = [];
      let successfulChunks = 0;
      const missingChunks: string[] = [];

      for (const id of mentionNodeIds) {
        const output = context.getOutput<{
          mentions: CharacterMention[];
          degraded: boolean;
        }>(id);
        if (!output) {
          missingChunks.push(id);
          continue;
        }
        successfulChunks++;
        mentions.push(...output.mentions);
      }

      const characters = aggregateCharacterMentions(mentions);
      const mainCharacters = (
        characters.filter((character) => character.mentionCount >= 2).length > 0
          ? characters.filter((character) => character.mentionCount >= 2)
          : characters
      )
        .slice(0, MAX_MAIN_CHARACTERS)
        .map((character) => ({
          ...character,
          selectedMentions: selectMentions(character.mentions),
        }));

      return {
        characters,
        mainCharacters,
        totalMentions: mentions.length,
        successfulChunks,
        missingChunks,
      };
    },
  });

  const analyzeId = 'analyze:characters';
  nodes.push({
    id: analyzeId,
    name: '人物分析',
    deps: [aggregateId],
    async run(context) {
      const aggregate = context.getOutput<{
        characters: CharacterAggregate[];
        mainCharacters: Array<
          CharacterAggregate & { selectedMentions: SelectedMention[] }
        >;
        totalMentions: number;
        successfulChunks: number;
        missingChunks: string[];
      }>(aggregateId);
      if (!aggregate) {
        return {
          analyses: [],
          characters: [],
          totalMentions: 0,
          successfulChunks: 0,
          missingChunks: mentionNodeIds,
        };
      }

      const analyses = await runWithConcurrency(
        aggregate.mainCharacters,
        3,
        async (character) => {
          const unitKey = `character:${normalizePersonName(character.name)}`;
          const inputText = character.selectedMentions
            .map(
              (mention) =>
                `${mention.id}|${mention.chapterTitle}|${formatLocator(mention.loc)}|${mention.quote}`,
            )
            .join('\n');

          try {
            const result = await cachedNode<{
              overview: string;
              traits: string[];
              arc: string;
              relationships: Array<{ target: string; description: string }>;
              citationIds: string[];
              degraded: boolean;
            }>(env.cache, unitKey, `${env.bookTitle}|${character.name}|${inputText}`, async () => {
              const completion = await completeJson<unknown>({
                llm: env.llm,
                prompt: buildCharacterAnalysisPrompt({
                  bookTitle: env.bookTitle,
                  name: character.name,
                  aliases: character.aliases,
                  mentions: character.selectedMentions,
                }),
                schemaHint:
                  '{"overview":"...","traits":["..."],"arc":"...","relationships":[{"target":"...","description":"..."}],"citations":["M1"]}',
                maxTokens: 1200,
                temperature: 0.3,
                signal: context.signal,
              });
              const data = normalizeCharacterAnalysis(
                completion.data,
                character.selectedMentions,
              );
              return data
                ? { ...data, degraded: false }
                : {
                    overview: truncateToTokenBudget(completion.raw, 600),
                    traits: [],
                    arc: '',
                    relationships: [],
                    citationIds: character.selectedMentions
                      .slice(0, 3)
                      .map((mention) => mention.id),
                    degraded: true,
                  };
            });

            context.progress({
              stage: 'character',
              cached: result.cached,
            });
            const citations = character.selectedMentions.filter((mention) =>
              result.value.citationIds.includes(mention.id),
            );

            return {
              name: character.name,
              aliases: character.aliases,
              mentionCount: character.mentionCount,
              chapterCount: character.chapterCount,
              overview: result.value.overview,
              traits: result.value.traits,
              arc: result.value.arc,
              relationships: result.value.relationships,
              citations,
              degraded: result.value.degraded,
            } satisfies CharacterAnalysisValue;
          } catch {
            return {
              name: character.name,
              aliases: character.aliases,
              mentionCount: character.mentionCount,
              chapterCount: character.chapterCount,
              overview: '（人物分析失败）',
              traits: [],
              arc: '',
              relationships: [],
              citations: character.selectedMentions.slice(0, 3),
              degraded: true,
            } satisfies CharacterAnalysisValue;
          }
        },
      );

      return { ...aggregate, analyses };
    },
  });

  const finalNodeId = 'final:characters';
  nodes.push({
    id: finalNodeId,
    name: '关系报告',
    deps: [analyzeId],
    async run(context) {
      const aggregate = context.getOutput<{
        characters: CharacterAggregate[];
        totalMentions: number;
        successfulChunks: number;
        missingChunks: string[];
        analyses: CharacterAnalysisValue[];
      }>(analyzeId);

      if (!aggregate) {
        return {
          markdown: `# 《${env.bookTitle}》人物关系分析\n\n（人物分析失败）\n`,
          coverage: 0,
          missingChunks: mentionNodeIds,
          degraded: true,
          characterCount: 0,
          mentionCount: 0,
          analyses: [],
        } satisfies CharacterFinalValue;
      }

      const inputText = aggregate.analyses
        .map(
          (analysis) =>
            `${analysis.name}\n${analysis.overview}\n${analysis.relationships
              .map((relation) => `${relation.target}:${relation.description}`)
              .join(';')}`,
        )
        .join('\n');

      const report = await cachedNode<{
        overview: string;
        network: Array<{ from: string; to: string; relation: string }>;
        conclusion: string;
        degraded: boolean;
      }>(env.cache, finalNodeId, `${env.bookTitle}|${inputText}`, async () => {
        const completion = await completeJson<unknown>({
          llm: env.llm,
          prompt: buildRelationshipReportPrompt({
            bookTitle: env.bookTitle,
            characters: aggregate.analyses.map((analysis) => ({
              name: analysis.name,
              aliases: analysis.aliases,
              mentionCount: analysis.mentionCount,
              overview: analysis.overview,
              relationships: analysis.relationships,
            })),
          }),
          schemaHint:
            '{"overview":"...","network":[{"from":"A","to":"B","relation":"..."}],"conclusion":"..."}',
          maxTokens: 1600,
          temperature: 0.4,
          signal: context.signal,
        });
        const data = completion.data as Record<string, unknown> | null;
        const overview = data ? asString(data.overview) : '';
        const network = Array.isArray(data?.network)
          ? (data.network as unknown[])
              .filter(
                (item): item is Record<string, unknown> =>
                  Boolean(item) && typeof item === 'object',
              )
              .map((item) => ({
                from: asString(item.from),
                to: asString(item.to),
                relation: asString(item.relation),
              }))
              .filter((item) => item.from && item.to && item.relation)
          : [];
        return overview
          ? {
              overview,
              network,
              conclusion: asString(data?.conclusion),
              degraded: false,
            }
          : {
              overview: '',
              network: [],
              conclusion: '',
              degraded: true,
            };
      });

      context.progress({ stage: 'final', cached: report.cached });
      const markdown = assembleCharacterMarkdown({
        bookTitle: env.bookTitle,
        totalMentions: aggregate.totalMentions,
        characters: aggregate.characters,
        analyses: aggregate.analyses,
        report: report.value,
      });
      const totalChunks = mentionNodeIds.length;
      const coverage =
        totalChunks === 0 ? 0 : aggregate.successfulChunks / totalChunks;

      return {
        markdown,
        coverage,
        missingChunks: aggregate.missingChunks,
        degraded:
          report.value.degraded ||
          aggregate.analyses.some((analysis) => analysis.degraded),
        characterCount: aggregate.characters.length,
        mentionCount: aggregate.totalMentions,
        analyses: aggregate.analyses,
      } satisfies CharacterFinalValue;
    },
  });

  return {
    nodes,
    finalNodeId,
    chunkCount: mentionNodeIds.length,
  };
}

export { CHARACTERS_PROMPT_VERSION };
