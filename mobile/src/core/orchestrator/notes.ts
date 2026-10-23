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
  NOTES_PROMPT_VERSION,
  buildChapterBatchSummaryPrompt,
  buildChapterSummaryPrompt,
  buildChunkSummaryPrompt,
  buildNotesOverviewPrompt,
  buildPartSummaryPrompt,
  buildSinglePassNotesPrompt,
} from './prompts';
import type { OrchestratorEnv } from './types';

const NOTE_CHUNK_SIZE = 6000;
const NOTE_CHUNK_OVERLAP = 300;
const MAX_UNITS_PER_PART = 10;

export interface NotesChunkPlan {
  chapterIndex: number;
  chunkIndex: number;
  chapterTitle: string;
  text: string;
  loc: Locator;
}

export interface NotesChapterPlan {
  chapterIndex: number;
  title: string;
  text: string;
  loc: Locator;
  isLong: boolean;
  chunks: NotesChunkPlan[];
}

export interface NotesPlan {
  nodes: DagNode[];
  finalNodeId: string;
  chapters: NotesChapterPlan[];
  chunkCount: number;
  partCount: number;
}

interface ChunkSummaryData {
  summary: string;
  keyEvents: string[];
  entities: string[];
  degraded: boolean;
}

export interface ChunkSummaryValue extends ChunkSummaryData {
  chapterIndex: number;
  chunkIndex: number;
  chapterTitle: string;
  loc: Locator;
}

export interface ChapterSummaryValue {
  chapterIndex: number;
  title: string;
  loc: Locator;
  summary: string;
  keyPoints: string[];
  characters: string[];
  chunkCount: number;
  missingChunks: number;
  degraded: boolean;
}

interface NotesOverviewData {
  overview: string;
  structure: string[];
  themes: string[];
  critique: string;
  conclusion: string;
}

export interface NotesFinalValue {
  markdown: string;
  coverage: number;
  missingChapters: number[];
  degraded: boolean;
  chapterCount: number;
  chunkCount: number;
  partCount: number;
  chapterSummaries: ChapterSummaryValue[];
  strategy: 'single-pass' | 'map-reduce';
}

function chunkNodeId(chapterIndex: number, chunkIndex: number): string {
  return `chunk:${chapterIndex}:${chunkIndex}`;
}

function chapterNodeId(chapterIndex: number): string {
  return `chapter:${chapterIndex}`;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChunkData(value: unknown): ChunkSummaryData | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const summary = asString(record.summary);
  if (!summary) return null;
  return {
    summary,
    keyEvents: asStringArray(record.keyEvents),
    entities: asStringArray(record.entities),
    degraded: Boolean(record.degraded),
  };
}

function normalizeChapterData(
  value: unknown,
): Omit<ChapterSummaryValue, 'chapterIndex' | 'title' | 'loc' | 'chunkCount' | 'missingChunks'> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const summary = asString(record.summary);
  if (!summary) return null;
  return {
    summary,
    keyPoints: asStringArray(record.keyPoints),
    characters: asStringArray(record.characters),
    degraded: Boolean(record.degraded),
  };
}

function normalizeOverview(value: unknown): NotesOverviewData | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const overview = asString(record.overview);
  if (!overview) return null;
  return {
    overview,
    structure: asStringArray(record.structure),
    themes: asStringArray(record.themes),
    critique: asString(record.critique),
    conclusion: asString(record.conclusion),
  };
}

export function assembleNotesMarkdown(
  bookTitle: string,
  overview: NotesOverviewData,
  chapters: readonly ChapterSummaryValue[],
): string {
  const lines: string[] = [`# 《${bookTitle}》读书笔记`, '', '## 书籍概览', '', overview.overview, ''];

  lines.push('## 结构大纲', '');
  if (overview.structure.length > 0) {
    for (const item of overview.structure) lines.push(`- ${item}`);
  } else {
    for (const chapter of chapters) lines.push(`- ${chapter.title}`);
  }
  lines.push('');

  lines.push('## 章节摘要', '');
  for (const chapter of chapters) {
    lines.push(`### ${chapter.title}`);
    lines.push('');
    lines.push(chapter.summary);
    if (chapter.keyPoints.length > 0) {
      lines.push('');
      for (const point of chapter.keyPoints) lines.push(`- ${point}`);
    }
    lines.push('');
    lines.push(`> 位置：${formatLocator(chapter.loc)}`);
    lines.push('');
  }

  lines.push('## 主题与点评', '');
  if (overview.themes.length > 0) {
    for (const theme of overview.themes) lines.push(`- ${theme}`);
    lines.push('');
  }
  lines.push(overview.critique || '（点评生成失败）', '');

  lines.push('## 总结', '');
  lines.push(overview.conclusion || '（总结生成失败）', '');

  return lines.join('\n');
}

export function buildNotesPlan(env: OrchestratorEnv, content: string): NotesPlan {
  const chapterSource = splitChapters(content);
  const chapters: NotesChapterPlan[] = chapterSource.map((chapter, chapterIndex) => {
    const loc: Locator = {
      kind: 'txt',
      href: null,
      start: chapter.start,
      end: chapter.end,
    };
    const isLong = !isShortChapter(chapter.text);
    const chunks = isLong
      ? chunkText(chapter.text, {
          chunkSize: NOTE_CHUNK_SIZE,
          overlap: NOTE_CHUNK_OVERLAP,
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
      loc,
      isLong,
      chunks,
    };
  });

  const nodes: DagNode[] = [];

  for (const chapter of chapters) {
    if (!chapter.isLong) continue;
    for (const chunk of chapter.chunks) {
      const id = chunkNodeId(chapter.chapterIndex, chunk.chunkIndex);
      nodes.push({
        id,
        name: `片段 ${chapter.chapterIndex + 1}-${chunk.chunkIndex + 1}`,
        deps: [],
        async run(context) {
          const result = await cachedNode<ChunkSummaryData>(
            env.cache,
            id,
            `${env.bookTitle}|${chapter.title}|${chunk.text}`,
            async () => {
              const completion = await completeJson<ChunkSummaryData>({
                llm: env.llm,
                prompt: buildChunkSummaryPrompt({
                  bookTitle: env.bookTitle,
                  chapterTitle: chapter.title,
                  text: chunk.text,
                }),
                schemaHint:
                  '{"summary":"200~300字","keyEvents":["..."],"entities":["..."]}',
                maxTokens: 600,
                temperature: 0.2,
                signal: context.signal,
              });
              const data = normalizeChunkData(completion.data);
              return (
                data ?? {
                  summary: truncateToTokenBudget(completion.raw, 400),
                  keyEvents: [],
                  entities: [],
                  degraded: true,
                }
              );
            },
          );
          context.progress({
            stage: 'map',
            done: chunk.chunkIndex + 1,
            total: chapter.chunks.length,
            cached: result.cached,
          });
          return {
            ...result.value,
            chapterIndex: chapter.chapterIndex,
            chunkIndex: chunk.chunkIndex,
            chapterTitle: chapter.title,
            loc: chunk.loc,
          } satisfies ChunkSummaryValue;
        },
      });
    }
  }

  const SHORT_MAP_ID = 'map:short-chapters';
  const shortChapters = chapters.filter((chapter) => !chapter.isLong);

  if (shortChapters.length > 0) {
    nodes.push({
      id: SHORT_MAP_ID,
      name: '短章节批量摘要',
      deps: [],
      async run(context) {
        const results = new Map<number, ChunkSummaryData>();
        const total = shortChapters.length;
        let done = 0;
        const tick = (): void => {
          done++;
          context.progress({ stage: 'short-map', done, total });
        };
        const uncached: NotesChapterPlan[] = [];

        for (const chapter of shortChapters) {
          const unitKey = `map:chapter:${chapter.chapterIndex}`;
          const inputHash = sha256Hex(
            `${env.bookTitle}|${chapter.title}|${chapter.text}`,
          );
          const cached = await env.cache.get(unitKey, inputHash);
          const data = normalizeChunkData(cached);
          if (data) {
            results.set(chapter.chapterIndex, data);
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
          let mapped: Map<number, ChunkSummaryData> | null = null;

          for (let attempt = 0; attempt < 2 && mapped === null; attempt++) {
            try {
              const completion = await completeJson<unknown>({
                llm: env.llm,
                prompt: buildChapterBatchSummaryPrompt({
                  bookTitle: env.bookTitle,
                  chapters: batch,
                }),
                schemaHint:
                  '[{"chapterIndex":0,"summary":"200~300字","keyEvents":["..."],"entities":["..."]}]',
                maxTokens: 2200,
                temperature: 0.2,
                signal: context.signal,
              });
              const candidate = validateChapterBatch<{
                chapterIndex: number;
                summary?: unknown;
                keyEvents?: unknown;
                entities?: unknown;
              }>(completion.data, expected);
              if (!candidate) continue;

              const normalized = new Map<number, ChunkSummaryData>();
              let valid = true;
              for (const index of expected) {
                const item = candidate.get(index);
                const data = item
                  ? normalizeChunkData({
                      summary: item.summary,
                      keyEvents: item.keyEvents,
                      entities: item.entities,
                    })
                  : null;
                if (!data) {
                  valid = false;
                  break;
                }
                normalized.set(index, data);
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
                `map:chapter:${chapter.chapterIndex}`,
                sha256Hex(`${env.bookTitle}|${chapter.title}|${chapter.text}`),
                data,
              );
              tick();
            }
            return;
          }

          // 批量结果错位/缺失时退化为逐章调用，绝不按错误顺序落库
          for (const item of batch) {
            if (context.signal?.aborted) throw new Error('任务已取消');
            const chapter = shortChapters.find(
              (entry) => entry.chapterIndex === item.chapterIndex,
            )!;
            const unitKey = `map:chapter:${chapter.chapterIndex}`;
            const inputHash = sha256Hex(
              `${env.bookTitle}|${chapter.title}|${chapter.text}`,
            );
            let data: ChunkSummaryData;
            try {
              const completion = await completeJson<unknown>({
                llm: env.llm,
                prompt: buildChunkSummaryPrompt({
                  bookTitle: env.bookTitle,
                  chapterTitle: chapter.title,
                  text: chapter.text,
                }),
                schemaHint:
                  '{"summary":"200~300字","keyEvents":["..."],"entities":["..."]}',
                maxTokens: 800,
                temperature: 0.2,
                signal: context.signal,
              });
              data =
                normalizeChunkData(completion.data) ?? {
                  summary: truncateToTokenBudget(chapter.text, 400),
                  keyEvents: [],
                  entities: [],
                  degraded: true,
                };
            } catch {
              data = {
                summary: truncateToTokenBudget(chapter.text, 400),
                keyEvents: [],
                entities: [],
                degraded: true,
              };
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
          chapters: Object.fromEntries(results) as Record<number, ChunkSummaryData>,
        };
      },
    });
  }

  const chapterNodeIds: string[] = [];

  for (const chapter of chapters) {
    if (!chapter.isLong) {
      const id = chapterNodeId(chapter.chapterIndex);
      chapterNodeIds.push(id);
      nodes.push({
        id,
        name: `章节 ${chapter.chapterIndex + 1}`,
        deps: [SHORT_MAP_ID],
        async run(context) {
          const shortMap = context.getOutput<{
            chapters: Record<number, ChunkSummaryData>;
          }>(SHORT_MAP_ID);
          const data = shortMap?.chapters[chapter.chapterIndex];
          return {
            chapterIndex: chapter.chapterIndex,
            title: chapter.title,
            loc: chapter.loc,
            summary:
              data?.summary ||
              truncateToTokenBudget(chapter.text || '（本章内容为空）', 450),
            keyPoints: data?.keyEvents ?? [],
            characters: data?.entities ?? [],
            chunkCount: 1,
            missingChunks: 0,
            degraded: data?.degraded ?? !data,
          } satisfies ChapterSummaryValue;
        },
      });
      continue;
    }

    const depIds = chapter.chunks.map((chunk) =>
      chunkNodeId(chapter.chapterIndex, chunk.chunkIndex),
    );
    const id = chapterNodeId(chapter.chapterIndex);
    chapterNodeIds.push(id);
    nodes.push({
      id,
      name: `章节 ${chapter.chapterIndex + 1}`,
      deps: depIds,
      async run(context) {
        const chunkOutputs = depIds
          .map((chunkId) => context.getOutput<ChunkSummaryValue>(chunkId))
          .filter((item): item is ChunkSummaryValue => item != null);
        const missingChunks = depIds.length - chunkOutputs.length;
        const fallbackSummary =
          truncateToTokenBudget(
            chunkOutputs.map((item) => item.summary).join('\n') ||
              chapter.text ||
              '（本章内容为空）',
            450,
          );
        const inputText = `${chapter.title}\n${chunkOutputs
          .map((item) => item.summary)
          .join('\n')}`;

        const result = await cachedNode(
          env.cache,
          id,
          `${env.bookTitle}|${inputText}`,
          async () => {
            if (chunkOutputs.length === 0) {
              return {
                summary: fallbackSummary,
                keyPoints: [],
                characters: [],
                degraded: true,
              };
            }

            const completion = await completeJson<unknown>({
              llm: env.llm,
              prompt: buildChapterSummaryPrompt({
                bookTitle: env.bookTitle,
                chapterTitle: chapter.title,
                chunkSummaries: chunkOutputs.map((item) => ({
                  chunkIndex: item.chunkIndex,
                  summary: item.summary,
                  keyEvents: item.keyEvents,
                  loc: item.loc,
                })),
              }),
              schemaHint:
                '{"summary":"400字以内","keyPoints":["..."],"characters":["..."]}',
              maxTokens: 800,
              temperature: 0.2,
              signal: context.signal,
            });
            const data = normalizeChapterData(completion.data);
            return (
              data ?? {
                summary: fallbackSummary,
                keyPoints: [],
                characters: [],
                degraded: true,
              }
            );
          },
        );

        context.progress({ stage: 'chapter', cached: result.cached });
        return {
          chapterIndex: chapter.chapterIndex,
          title: chapter.title,
          loc: chapter.loc,
          summary: result.value.summary,
          keyPoints: result.value.keyPoints,
          characters: result.value.characters,
          chunkCount: depIds.length,
          missingChunks,
          degraded: result.value.degraded,
        } satisfies ChapterSummaryValue;
      },
    });
  }

  let currentUnits = [...chapterNodeIds];
  let partLevel = 1;
  let partCount = 0;

  while (currentUnits.length > MAX_UNITS_PER_PART && partLevel <= 5) {
    const groups: string[][] = [];
    for (let index = 0; index < currentUnits.length; index += MAX_UNITS_PER_PART) {
      groups.push(currentUnits.slice(index, index + MAX_UNITS_PER_PART));
    }

    const nextUnits: string[] = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      if (group.length <= 1) {
        nextUnits.push(...group);
        continue;
      }

      const id = `part:${partLevel}:${groupIndex}`;
      nodes.push({
        id,
        name: `分部 ${partLevel}-${groupIndex + 1}`,
        deps: group,
        async run(context) {
          const summaries = group
            .map((unitId) => {
              const value = context.getOutput<ChapterSummaryValue>(unitId);
              return value
                ? {
                    title: value.title,
                    summary: value.summary,
                    loc: value.loc,
                  }
                : null;
            })
            .filter(
              (item): item is { title: string; summary: string; loc: Locator } =>
                item != null,
            );

          if (summaries.length === 0) {
            return { summary: '（本部分摘要生成失败）', degraded: true };
          }

          const inputText = summaries
            .map((item) => `${item.title}\n${item.summary}`)
            .join('\n');
          const result = await cachedNode(
            env.cache,
            id,
            `${env.bookTitle}|${inputText}`,
            async () => {
              const completion = await completeJson<unknown>({
                llm: env.llm,
                prompt: buildPartSummaryPrompt({
                  bookTitle: env.bookTitle,
                  partIndex: groupIndex,
                  summaries,
                }),
                schemaHint: '{"summary":"500字以内"}',
                maxTokens: 900,
                temperature: 0.2,
                signal: context.signal,
              });
              const record = completion.data as
                | Record<string, unknown>
                | null;
              const summary =
                record && typeof record.summary === 'string'
                  ? record.summary.trim()
                  : '';
              return summary
                ? { summary, degraded: false }
                : {
                    summary: truncateToTokenBudget(
                      summaries.map((item) => item.summary).join('\n'),
                      600,
                    ),
                    degraded: true,
                  };
            },
          );

          context.progress({ stage: 'part', cached: result.cached });
          return result.value;
        },
      });
      nextUnits.push(id);
      partCount++;
    }

    if (nextUnits.length >= currentUnits.length) break;
    currentUnits = nextUnits;
    partLevel++;
  }

  const finalDeps = [...new Set([...chapterNodeIds, ...currentUnits])];
  const finalNodeId = 'final:notes';
  nodes.push({
    id: finalNodeId,
    name: '全书整合',
    deps: finalDeps,
    async run(context) {
      const chapterSummaries: ChapterSummaryValue[] = chapters.map((chapter) => {
        const saved = context.getOutput<ChapterSummaryValue>(
          chapterNodeId(chapter.chapterIndex),
        );
        if (saved) {
          return {
            ...saved,
            loc: chapter.loc,
          };
        }

        const chunkOutputs = chapter.chunks
          .map((chunk) =>
            context.getOutput<ChunkSummaryValue>(
              chunkNodeId(chapter.chapterIndex, chunk.chunkIndex),
            ),
          )
          .filter((item): item is ChunkSummaryValue => item != null);
        return {
          chapterIndex: chapter.chapterIndex,
          title: chapter.title,
          loc: chapter.loc,
          summary:
            truncateToTokenBudget(
              chunkOutputs.map((item) => item.summary).join('\n') ||
                chapter.text ||
                '（本章摘要生成失败）',
              450,
            ),
          keyPoints: [],
          characters: [],
          chunkCount: chapter.isLong ? chapter.chunks.length : 1,
          missingChunks: chapter.chunks.length - chunkOutputs.length,
          degraded: true,
        };
      });

      const topSummaries = currentUnits
        .map((unitId) => context.getOutput<{ summary: string }>(unitId))
        .filter((item): item is { summary: string } => item != null);

      const inputText = `${chapterSummaries
        .map((item) => `${item.title}\n${item.summary}`)
        .join('\n')}\n${topSummaries.map((item) => item.summary).join('\n')}`;

      const overviewResult = await cachedNode<NotesOverviewData>(
        env.cache,
        finalNodeId,
        `${env.bookTitle}|${inputText}`,
        async () => {
          const completion = await completeJson<NotesOverviewData>({
            llm: env.llm,
            prompt: buildNotesOverviewPrompt({
              bookTitle: env.bookTitle,
              chapterTitles: chapters.map((item) => item.title),
              summaries:
                topSummaries.length > 0
                  ? topSummaries.map((item, index) => ({
                      title: `综合摘要 ${index + 1}`,
                      summary: item.summary,
                    }))
                  : chapterSummaries.map((item) => ({
                      title: item.title,
                      summary: item.summary,
                    })),
            }),
            schemaHint:
              '{"overview":"...","structure":["..."],"themes":["..."],"critique":"...","conclusion":"..."}',
            maxTokens: 1800,
            temperature: 0.4,
            signal: context.signal,
          });
          const data = normalizeOverview(completion.data);
          return (
            data ?? {
              overview: truncateToTokenBudget(
                topSummaries.map((item) => item.summary).join('\n'),
                600,
              ),
              structure: chapters.map((item) => item.title),
              themes: [],
              critique: '',
              conclusion: '',
            }
          );
        },
      );

      context.progress({ stage: 'final', cached: overviewResult.cached });
      const missingChapters = chapterSummaries
        .filter((item) => !item.summary.trim())
        .map((item) => item.chapterIndex);
      const coverage =
        chapters.length === 0
          ? 0
          : chapterSummaries.filter((item) => item.summary.trim()).length /
            chapters.length;

      return {
        markdown: assembleNotesMarkdown(
          env.bookTitle,
          overviewResult.value,
          chapterSummaries,
        ),
        coverage,
        missingChapters,
        degraded:
          overviewResult.value.overview === '' ||
          chapterSummaries.some((item) => item.degraded),
        chapterCount: chapters.length,
        chunkCount: chapters.reduce(
          (sum, chapter) => sum + (chapter.isLong ? chapter.chunks.length : 1),
          0,
        ),
        partCount,
        chapterSummaries,
        strategy: 'map-reduce',
      } satisfies NotesFinalValue;
    },
  });

  return {
    nodes,
    finalNodeId,
    chapters,
    chunkCount: chapters.reduce(
      (sum, chapter) => sum + (chapter.isLong ? chapter.chunks.length : 1),
      0,
    ),
    partCount,
  };
}

export { NOTES_PROMPT_VERSION };

interface SinglePassChapterData {
  chapterIndex: number;
  summary: string;
  keyPoints: string[];
}

interface SinglePassData {
  overview: string;
  structure: string[];
  themes: string[];
  critique: string;
  conclusion: string;
  chapterSummaries: SinglePassChapterData[];
}

function normalizeSinglePassData(
  value: unknown,
): SinglePassData | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const overview = asString(record.overview);
  if (!overview) return null;

  const rawChapters = Array.isArray(record.chapterSummaries)
    ? record.chapterSummaries
    : [];
  const chapterSummaries: SinglePassChapterData[] = [];
  for (const item of rawChapters) {
    if (!item || typeof item !== 'object') continue;
    const chapter = item as Record<string, unknown>;
    const chapterIndex = Number(chapter.chapterIndex);
    const summary = asString(chapter.summary);
    if (!Number.isFinite(chapterIndex) || !summary) continue;
    chapterSummaries.push({
      chapterIndex: Math.floor(chapterIndex),
      summary,
      keyPoints: asStringArray(chapter.keyPoints),
    });
  }

  return {
    overview,
    structure: asStringArray(record.structure),
    themes: asStringArray(record.themes),
    critique: asString(record.critique),
    conclusion: asString(record.conclusion),
    chapterSummaries,
  };
}

/**
 * 长上下文单次路径：一次 LLM 调用生成全书笔记。
 * 只用于中小书或显式长上下文优先；漏章/上下文超限由 taskRunner 降级到 map-reduce。
 */
export function buildSinglePassNotesPlan(
  env: OrchestratorEnv,
  content: string,
): NotesPlan {
  const chapters = splitChapters(content).map((chapter, chapterIndex) => ({
    chapterIndex,
    title: chapter.title,
    text: chapter.text,
    loc: {
      kind: 'txt' as const,
      href: null,
      start: chapter.start,
      end: chapter.end,
    },
    isLong: false,
    chunks: [],
  }));
  const finalNodeId = 'final:notes:single';

  const nodes: DagNode[] = [
    {
      id: finalNodeId,
      name: '单次全书笔记',
      deps: [],
      async run(context) {
        const inputText = `${chapters.map((chapter) => chapter.title).join('\n')}\n${content}`;
        const result = await cachedNode<SinglePassData>(
          env.cache,
          finalNodeId,
          `${env.bookTitle}|${inputText}`,
          async () => {
            const completion = await completeJson<unknown>({
              llm: env.llm,
              prompt: buildSinglePassNotesPrompt({
                bookTitle: env.bookTitle,
                chapterTitles: chapters.map((chapter) => chapter.title),
                content,
              }),
              schemaHint:
                '{"overview":"...","structure":["..."],"themes":["..."],"critique":"...","conclusion":"...","chapterSummaries":[{"chapterIndex":1,"summary":"...","keyPoints":["..."]}]}',
              maxTokens: 4000,
              temperature: 0.3,
              signal: context.signal,
              repairMaxTokens: 1200,
            });
            const data = normalizeSinglePassData(completion.data);
            return (
              data ?? {
                overview: truncateToTokenBudget(completion.raw, 600),
                structure: chapters.map((chapter) => chapter.title),
                themes: [],
                critique: '',
                conclusion: '',
                chapterSummaries: [],
              }
            );
          },
        );

        context.progress({ stage: 'single-pass', cached: result.cached });
        const byIndex = new Map<number, SinglePassChapterData>();
        for (const item of result.value.chapterSummaries) {
          // 兼容模型返回 0-based 索引
          const usesZeroBased =
            item.chapterIndex === 0 &&
            !result.value.chapterSummaries.some(
              (chapter) => chapter.chapterIndex === chapters.length,
            );
          const index = usesZeroBased ? item.chapterIndex : item.chapterIndex - 1;
          if (index >= 0 && index < chapters.length) {
            byIndex.set(index, item);
          }
        }

        const chapterSummaries: ChapterSummaryValue[] = chapters.map((chapter) => {
          const data = byIndex.get(chapter.chapterIndex);
          return {
            chapterIndex: chapter.chapterIndex,
            title: chapter.title,
            loc: chapter.loc,
            summary: data?.summary ?? '',
            keyPoints: data?.keyPoints ?? [],
            characters: [],
            chunkCount: 0,
            missingChunks: 0,
            degraded: !data,
          };
        });
        const missingChapters = chapterSummaries
          .filter((chapter) => !chapter.summary)
          .map((chapter) => chapter.chapterIndex);
        const coverage =
          chapters.length === 0
            ? 0
            : (chapters.length - missingChapters.length) / chapters.length;

        return {
          markdown: assembleNotesMarkdown(
            env.bookTitle,
            {
              overview: result.value.overview,
              structure: result.value.structure,
              themes: result.value.themes,
              critique: result.value.critique,
              conclusion: result.value.conclusion,
            },
            chapterSummaries,
          ),
          coverage,
          missingChapters,
          degraded: missingChapters.length > 0,
          chapterCount: chapters.length,
          chunkCount: 0,
          partCount: 0,
          chapterSummaries,
          strategy: 'single-pass',
        } satisfies NotesFinalValue;
      },
    },
  ];

  return {
    nodes,
    finalNodeId,
    chapters,
    chunkCount: 0,
    partCount: 0,
  };
}
