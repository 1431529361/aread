import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb, insertBook } from '../__tests__/helpers/testDb';
import { LOCAL_USER_ID } from '../src/db/schema';
import { splitChapters } from '../src/core/rag/chapters';
import { complete, type LlmClientConfig } from '../src/core/llm/client';
import { startTask, type TaskRunResult } from '../src/services/taskRunner';
import { loadEvalEnv } from './env';

interface BookSpec {
  key: string;
  id: string;
  title: string;
  file: string;
}

const BOOKS: BookSpec[] = [
  {
    key: 'bainian',
    id: 'p15-bainian',
    title: '百年孤独',
    file: '../books/__defaults/百年孤独.txt',
  },
  {
    key: 'chanhui',
    id: 'p15-chanhui',
    title: '忏悔录',
    file: '../books/18cd62ce-fafc-48c5-bad7-fb77d8ada1de/36384271-091d-457e-93d5-bd0af1bdd5c9.txt',
  },
];

function loadBook(spec: BookSpec): string {
  const fullPath = path.resolve(process.cwd(), spec.file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`测试书不存在: ${fullPath}`);
  }
  return fs.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function locatorStats(markdown: string, content: string): {
  total: number;
  valid: number;
} {
  const matches = [...markdown.matchAll(/txt:(\d+)-(\d+)/g)];
  let valid = 0;
  for (const match of matches) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start &&
      end <= content.length &&
      content.slice(start, end).trim().length > 0
    ) {
      valid++;
    }
  }
  return { total: matches.length, valid };
}

function summarize(result: TaskRunResult, content: string) {
  return {
    status: result.status,
    strategy: result.strategy,
    fallbackReason: result.fallbackReason ?? null,
    coverage: result.coverage,
    chapterCount: result.chapterCount,
    chunkCount: result.chunkCount,
    partCount: result.partCount ?? null,
    characterCount: result.characterCount ?? null,
    mentionCount: result.mentionCount ?? null,
    missingChapters: result.missingChapters,
    missingChunks: result.missingChunks.length,
    errors: result.errors,
    cacheHits: result.cacheHits,
    totalNodes: result.totalNodes,
    completedNodes: result.completedNodes,
    durationMs: result.durationMs,
    contentLength: result.content.length,
    chapterHeadings: (result.content.match(/^### /gm) ?? []).length,
    numberedChapterHeadings: (result.content.match(/^### (?:第|Chapter)/gim) ?? []).length,
    locator: locatorStats(result.content, content),
    preview: result.content.slice(0, 600),
  };
}

describe('P1-5 real-book integration', () => {
  it(
    'runs notes and character analysis on real books',
    async () => {
      const env = loadEvalEnv();
      const chatConfig: LlmClientConfig = {
        baseUrl: env.chatBaseUrl,
        apiKey: env.chatApiKey,
        model: env.chatModel,
      };
      const llm = {
        complete: (
          prompt: string,
          options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
        ) =>
          complete(chatConfig, prompt, {
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
            timeoutMs: 120000,
            retries: 2,
            signal: options?.signal,
            extraBody: { enable_thinking: false },
          }),
      };

      const selectedKeys = (process.env.P15_BOOK || 'both').split(',');
      const books = BOOKS.filter(
        (book) => selectedKeys.includes('both') || selectedKeys.includes(book.key),
      );
      const skipSmoke = process.env.P15_SKIP_SMOKE === '1';
      const smokeOnly = process.env.P15_SMOKE_ONLY === '1';
      const taskFilter = process.env.P15_TASK || 'both';
      const runNotes = taskFilter !== 'characters';
      const runCharacters = taskFilter !== 'notes';
      const progressFile = process.env.P15_PROGRESS_FILE;
      const progress = (message: string): void => {
        if (progressFile) fs.appendFileSync(progressFile, `${message}\n`);
      };
      const { db, close } = await createTestDb();
      const report: Array<Record<string, unknown>> = [];

      try {
        for (const book of books) {
          const content = loadBook(book);
          const chapters = splitChapters(content);
          console.log(
            `\n[book] ${book.title}: ${content.length} chars, ${chapters.length} chapters`,
          );
          progress(
            `book ${book.title} chars=${content.length} chapters=${chapters.length}`,
          );
          await insertBook(db, { id: book.id, title: book.title });

          let smoke: Record<string, unknown> | null = null;
          if (!skipSmoke && chapters.length > 3) {
            const smokeContent = content.slice(0, chapters[2].end);
            const smokeNotes = runNotes
              ? await startTask({
                  db,
                  userId: LOCAL_USER_ID,
                  bookId: book.id,
                  bookTitle: book.title,
                  content: smokeContent,
                  taskType: 'generate-notes',
                  chatConfig,
                  llm,
                  // 小样强制走 map-reduce，提前验证 chunk/chapter prompt，并为全书缓存预热
                  singlePassMaxTokens: 10000,
                  onEvent: (event) => {
                    if (event.type === 'node_error') {
                      progress(
                        `smoke notes node_error ${event.id}: ${event.error}`,
                      );
                    }
                    if (event.type === 'fallback') {
                      progress(`smoke notes fallback: ${event.reason}`);
                    }
                  },
                })
              : null;
            const smokeCharacters = runCharacters
              ? await startTask({
                  db,
                  userId: LOCAL_USER_ID,
                  bookId: book.id,
                  bookTitle: book.title,
                  content: smokeContent,
                  taskType: 'character-analysis',
                  chatConfig,
                  llm,
                  onEvent: (event) => {
                    if (event.type === 'node_error') {
                      progress(
                        `smoke characters node_error ${event.id}: ${event.error}`,
                      );
                    }
                  },
                })
              : null;
            smoke = {
              chapters: splitChapters(smokeContent).length,
              notes: smokeNotes ? summarize(smokeNotes, smokeContent) : null,
              characters: smokeCharacters
                ? summarize(smokeCharacters, smokeContent)
                : null,
            };
            progress(
              `smoke done notes=${smokeNotes?.status ?? 'skipped'} characters=${smokeCharacters?.status ?? 'skipped'}`,
            );
            console.log(
              `[smoke] ${book.title}: notes=${smokeNotes?.status ?? 'skipped'}/${smokeNotes?.coverage ?? '-'}, characters=${smokeCharacters?.status ?? 'skipped'}/${smokeCharacters?.coverage ?? '-'}`,
            );
            if (smokeOnly) {
              report.push({
                book: book.title,
                chars: content.length,
                chapters: chapters.length,
                smoke,
              });
              continue;
            }
          }

          const notes = runNotes
            ? await startTask({
                db,
                userId: LOCAL_USER_ID,
                bookId: book.id,
                bookTitle: book.title,
                content,
                taskType: 'generate-notes',
                chatConfig,
                llm,
                onEvent: (event) => {
                  if (event.type === 'node_error') {
                    progress(`notes node_error ${event.id}: ${event.error}`);
                  }
                  if (event.type === 'fallback') {
                    progress(`notes fallback: ${event.reason}`);
                  }
                  if (event.type === 'progress' && event.percent % 10 === 0) {
                    progress(`notes progress ${event.percent}%`);
                  }
                },
              })
            : null;
          if (notes) {
            progress(
              `notes done ${notes.status} coverage=${notes.coverage} chapters=${notes.chapterCount} cache=${notes.cacheHits} ms=${notes.durationMs}`,
            );
            console.log(
              `[notes] ${book.title}: ${notes.status} strategy=${notes.strategy} coverage=${notes.coverage} chapters=${notes.chapterCount} cacheHits=${notes.cacheHits} ${notes.durationMs}ms`,
            );
          }

          const characters = runCharacters
            ? await startTask({
                db,
                userId: LOCAL_USER_ID,
                bookId: book.id,
                bookTitle: book.title,
                content,
                taskType: 'character-analysis',
                chatConfig,
                llm,
                onEvent: (event) => {
                  if (event.type === 'node_error') {
                    progress(
                      `characters node_error ${event.id}: ${event.error}`,
                    );
                  }
                  if (event.type === 'progress' && event.percent % 10 === 0) {
                    progress(`characters progress ${event.percent}%`);
                  }
                },
              })
            : null;
          if (characters) {
            progress(
              `characters done ${characters.status} coverage=${characters.coverage} characters=${characters.characterCount} mentions=${characters.mentionCount} cache=${characters.cacheHits} ms=${characters.durationMs}`,
            );
            console.log(
              `[characters] ${book.title}: ${characters.status} coverage=${characters.coverage} characters=${characters.characterCount} mentions=${characters.mentionCount} cacheHits=${characters.cacheHits} ${characters.durationMs}ms`,
            );
          }

          const entry = {
            book: book.title,
            chars: content.length,
            chapters: chapters.length,
            smoke,
            notes: notes ? summarize(notes, content) : null,
            characters: characters ? summarize(characters, content) : null,
          };
          report.push(entry);

          if (notes) {
            expect(notes.status).not.toBe('failed');
            expect(notes.coverage).toBeGreaterThan(0);
          }
          if (characters) {
            expect(characters.status).not.toBe('failed');
            expect(characters.coverage).toBeGreaterThan(0);
          }
        }

        const reportDir = path.resolve(process.cwd(), 'evals/reports');
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(
          path.join(reportDir, 'p1-5.json'),
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              model: env.chatModel,
              books: report,
            },
            null,
            2,
          ),
        );
        console.log(`\n报告已写入 ${path.join(reportDir, 'p1-5.json')}`);
      } finally {
        close();
      }
    },
    900000,
  );
});
