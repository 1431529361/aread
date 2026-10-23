import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb, insertBook } from '../__tests__/helpers/testDb';
import { LOCAL_USER_ID } from '../src/db/schema';
import { indexBook } from '../src/services/indexing';
import { retrieveInBook, retrieveInLibrary } from '../src/services/retrieval';
import { createLlmReranker } from '../src/core/rag/rerank';
import { embedTexts, type EmbeddingClientConfig } from '../src/core/embedding/client';
import { computeEmbedSig } from '../src/core/embedding/signature';
import {
  chat,
  complete,
  stream,
  type LlmClientConfig,
} from '../src/core/llm/client';
import { rewriteQuery } from '../src/core/rag/queryRewrite';
import { runAgentLoop, type AgentEvent } from '../src/core/agent/loop';
import {
  buildAgentSystemPrompt,
  buildAgentUserMessage,
} from '../src/core/llm/prompts';
import { parseCitationIds, buildEvidenceMessage } from '../src/core/citation';
import type { AgentToolContext } from '../src/core/agent/types';
import type { RetrievalHit } from '../src/core/types';
import { loadEvalEnv } from './env';
import {
  EVAL_BOOKS,
  EVAL_QUESTIONS,
  bookContent,
  type EvalQuestion,
} from './dataset';

interface VariantMetric {
  name: string;
  questions: number;
  recallAt5: number;
  locatorAccuracy: number;
  avgMs: number;
  p95Ms: number;
}

interface AgentMetric {
  questions: number;
  successes: number;
  citationRate: number;
  invalidCitationRate: number;
  faithfulness: number | null;
  refusalAccuracy: number;
  avgMs: number;
  p95Ms: number;
  errors: number;
}

interface QuestionDetail {
  id: string;
  bookId: string;
  type: string;
  question: string;
  variants: Record<
    string,
    {
      query: string;
      recall: boolean | null;
      locatorAccuracy: number;
      latencyMs: number;
      chunkIds: number[];
    }
  >;
  agent?: {
    answer: string;
    citations: number[];
    removedCitations: number[];
    citationValid: boolean;
    locatorAccuracy: number;
    faithful: boolean | null;
    score: number | null;
    latencyMs: number;
    error?: string;
  };
}

const VARIANT_NAMES = [
  'fts',
  'hybrid',
  'hybrid_rerank',
  'hybrid_rerank_rewrite',
  'library_hybrid',
] as const;

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[index];
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, '');
}

function containsGold(hits: readonly RetrievalHit[], goldSpan: string): boolean {
  const needle = normalize(goldSpan);
  return hits.some((hit) =>
    normalize(hit.parentText ?? hit.text).includes(needle),
  );
}

function locatorStats(
  hits: readonly RetrievalHit[],
  contentByBook: Map<string, string>,
): { valid: number; total: number } {
  let valid = 0;
  let total = 0;
  for (const hit of hits) {
    const content = contentByBook.get(hit.bookId);
    if (!content) continue;
    total++;
    if (content.slice(hit.loc.start, hit.loc.end) === hit.text) valid++;
  }
  return { valid, total };
}

function sampleQuestions(
  questions: readonly EvalQuestion[],
  limit: number,
): EvalQuestion[] {
  if (limit >= questions.length) return [...questions];
  if (limit <= 0) return [];
  const step = questions.length / limit;
  return Array.from({ length: limit }, (_, index) => questions[Math.floor(index * step)]);
}

function parseJudge(raw: string): { faithful: boolean; score: number } | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      faithful?: unknown;
      score?: unknown;
    };
    const score =
      typeof parsed.score === 'number'
        ? Math.max(0, Math.min(1, parsed.score))
        : null;
    if (typeof parsed.faithful !== 'boolean' || score === null) return null;
    return { faithful: parsed.faithful, score };
  } catch {
    return null;
  }
}

function buildJudgePrompt(
  question: EvalQuestion,
  answer: string,
  evidenceText: string,
): string {
  return `你是严格的阅读问答评审。请结合“参考答案”和“检索证据”判断助手回答；不要使用外部知识。

问题：${question.question}
参考答案：${question.goldAnswer}${question.goldSpan ? `\n原文关键句：${question.goldSpan}` : ''}

检索证据：
${evidenceText || '（无）'}

助手回答：${answer}

评分标准：
- 1.0：核心答案正确，所有事实细节都能在检索证据中找到依据
- 0.7：核心答案正确，但有个别细节超出证据
- 0.3：部分正确或遗漏关键信息
- 0：答错、答非所问或编造

只输出 JSON：{"faithful":true|false,"score":0到1,"reason":"简要理由"}`;
}

function isRefusalAnswer(text: string): boolean {
  return /未提及|未提到|没有提及|没有(?:提到|记载|出现)|无法回答|不知道/.test(
    text.replace(/[*_`]/g, ''),
  );
}

function buildReportMarkdown(report: {
  generatedAt: string;
  models: { chat: string; embed: string };
  index: Array<{
    title: string;
    status: string;
    chunks: number;
    embedded: number;
    durationMs: number;
  }>;
  retrieval: VariantMetric[];
  agent: AgentMetric;
  details: QuestionDetail[];
}): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const retrievalRows = report.retrieval
    .map(
      (item) =>
        `| ${item.name} | ${percent(item.recallAt5)} | ${percent(item.locatorAccuracy)} | ${item.avgMs.toFixed(0)} | ${item.p95Ms.toFixed(0)} |`,
    )
    .join('\n');
  const indexRows = report.index
    .map(
      (item) =>
        `| ${item.title} | ${item.status} | ${item.chunks} | ${item.embedded} | ${item.durationMs} |`,
    )
    .join('\n');

  return `# P1-6 评测报告

- 生成时间：${report.generatedAt}
- Chat 模型：${report.models.chat}
- Embedding 模型：${report.models.embed}

## 索引

| 书籍 | 状态 | 子块数 | 已向量化 | 耗时(ms) |
|---|---|---|---|---|
${indexRows}

## 检索（${report.retrieval[0]?.questions ?? 0} 题，Top-5）

| 变体 | Recall@5 | locator 正确率 | 平均延迟(ms) | p95(ms) |
|---|---|---|---|---|
${retrievalRows}

## Agent

- 题目数：${report.agent.questions}，成功：${report.agent.successes}，失败：${report.agent.errors}
- 引用有效率：${percent(report.agent.citationRate)}
- 无效引用出现率：${percent(report.agent.invalidCitationRate)}
- 忠实度均分：${report.agent.faithfulness == null ? 'N/A' : report.agent.faithfulness.toFixed(3)}
- 拒答正确率：${percent(report.agent.refusalAccuracy)}
- 平均延迟：${report.agent.avgMs.toFixed(0)}ms，p95：${report.agent.p95Ms.toFixed(0)}ms

## 说明

- 评测集为仓库内 3 本合成样书 × 10 题，覆盖事实、人物、跨章节、追问、拒答。
- 检索变体：FTS、混合检索、混合+rerank、混合+rerank+追问改写、书库混合检索。
- Agent 评测使用真实 chat 模型生成回答，并用同一模型作为 judge；judge 结果仅供回归对比。
- 报告不包含任何 API Key。
`;
}

describe('P1-6 evaluation', () => {
  it(
    'runs live retrieval and agent evaluation',
    async () => {
      const env = loadEvalEnv();
      const chatConfig: LlmClientConfig = {
        baseUrl: env.chatBaseUrl,
        apiKey: env.chatApiKey,
        model: env.chatModel,
      };
      const embedConfig: EmbeddingClientConfig = {
        baseUrl: env.embedBaseUrl,
        apiKey: env.embedApiKey,
        model: env.embedModel,
        dims: env.embedDims,
      };
      const extraBody = { enable_thinking: false };
      const chatLlm = {
        complete: (
          prompt: string,
          options?: { maxTokens?: number; temperature?: number },
        ) =>
          complete(chatConfig, prompt, {
            ...options,
            retries: 1,
            timeoutMs: 90000,
            extraBody,
          }),
      };
      const agentLlm = {
        chat: (config: LlmClientConfig, options: Parameters<typeof chat>[1]) =>
          chat(config, { ...options, extraBody }),
        stream: (config: LlmClientConfig, options: Parameters<typeof stream>[1]) =>
          stream(config, { ...options, extraBody }),
      };
      const reranker = createLlmReranker({ llm: chatLlm });
      const embedAll = (texts: readonly string[]) =>
        embedTexts(embedConfig, [...texts], {
          retries: 2,
          timeoutMs: 30000,
        });
      const embedSig = computeEmbedSig({
        baseUrl: env.embedBaseUrl,
        model: env.embedModel,
        dims: env.embedDims,
      });

      const { db, close } = await createTestDb();
      const reportDetails: QuestionDetail[] = [];
      const variantStats = new Map<
        string,
        {
          latencies: number[];
          recallHits: number;
          recallTotal: number;
          locatorValid: number;
          locatorTotal: number;
          questions: number;
        }
      >();
      for (const name of VARIANT_NAMES) {
        variantStats.set(name, {
          latencies: [],
          recallHits: 0,
          recallTotal: 0,
          locatorValid: 0,
          locatorTotal: 0,
          questions: 0,
        });
      }

      const embeddingsCache = new Map<string, number[]>();
      const retrievalCache = new Map<string, RetrievalHit[]>();
      const rewrittenQueries = new Map<string, string>();
      const contentByBook = new Map<string, string>();

      const embedQuery = async (query: string): Promise<number[]> => {
        const cached = embeddingsCache.get(query);
        if (cached) return cached;
        const [vector] = await embedAll([query]);
        embeddingsCache.set(query, vector);
        return vector;
      };

      const retrieveBook = async (
        bookId: string,
        query: string,
        options: { hybrid: boolean; rerank: boolean },
      ): Promise<RetrievalHit[]> => {
        const key = `${bookId}|${options.hybrid ? 'h' : 'f'}|${options.rerank ? 'r' : ''}|${query}`;
        const cached = retrievalCache.get(key);
        if (cached) return cached;

        const hits = await retrieveInBook(bookId, {
          db,
          query,
          topK: 5,
          expandParents: true,
          embedQuery: options.hybrid ? embedQuery : null,
          activeSig: options.hybrid ? embedSig : null,
          dims: env.embedDims,
          rerank: options.rerank ? reranker : null,
        });
        retrievalCache.set(key, hits);
        return hits;
      };

      const retrieveLibrary = async (query: string): Promise<RetrievalHit[]> => {
        const key = `library|${query}`;
        const cached = retrievalCache.get(key);
        if (cached) return cached;
        const hits = await retrieveInLibrary({
          db,
          query,
          topK: 5,
          expandParents: true,
          embedQuery,
          activeSig: embedSig,
          dims: env.embedDims,
        });
        retrievalCache.set(key, hits);
        return hits;
      };

      const indexStats: Array<{
        title: string;
        status: string;
        chunks: number;
        embedded: number;
        durationMs: number;
      }> = [];

      try {
        for (const book of EVAL_BOOKS) {
          const content = bookContent(book);
          contentByBook.set(book.id, content);
          await insertBook(db, { id: book.id, title: book.title });
          const startedAt = Date.now();
          const result = await indexBook({
            db,
            userId: LOCAL_USER_ID,
            bookId: book.id,
            content,
            embed: {
              embedSig,
              dims: env.embedDims,
              embedTexts: embedAll,
            },
          });
          indexStats.push({
            title: book.title,
            status: result.status,
            chunks: result.chunks,
            embedded: result.embedded,
            durationMs: Date.now() - startedAt,
          });
        }

        console.log('\n[index]', indexStats);
        expect(indexStats.every((item) => item.status === 'ready')).toBe(true);

        const agentLimit = Number(process.env.EVAL_AGENT_LIMIT || EVAL_QUESTIONS.length);
        const questionLimit = Number(
          process.env.EVAL_QUESTION_LIMIT || EVAL_QUESTIONS.length,
        );
        const evalQuestions = sampleQuestions(
          EVAL_QUESTIONS,
          Number.isFinite(questionLimit)
            ? Math.max(1, Math.min(EVAL_QUESTIONS.length, questionLimit))
            : EVAL_QUESTIONS.length,
        );
        const agentQuestions = sampleQuestions(
          evalQuestions,
          Number.isFinite(agentLimit)
            ? Math.max(1, Math.min(evalQuestions.length, agentLimit))
            : evalQuestions.length,
        );

        for (const question of evalQuestions) {
          const detail: QuestionDetail = {
            id: question.id,
            bookId: question.bookId,
            type: question.type,
            question: question.question,
            variants: {},
          };

          const recordVariant = (
            name: string,
            query: string,
            hits: RetrievalHit[],
            latencyMs: number,
          ): void => {
            const stats = variantStats.get(name)!;
            const locators = locatorStats(hits, contentByBook);
            const recall =
              question.goldSpan != null
                ? containsGold(hits, question.goldSpan)
                : null;

            stats.questions++;
            stats.latencies.push(latencyMs);
            stats.locatorValid += locators.valid;
            stats.locatorTotal += locators.total;
            if (recall != null) {
              stats.recallTotal++;
              if (recall) stats.recallHits++;
            }

            detail.variants[name] = {
              query,
              recall,
              locatorAccuracy:
                locators.total === 0 ? 1 : locators.valid / locators.total,
              latencyMs,
              chunkIds: hits.map((hit) => hit.chunkId),
            };
          };

          let startedAt = Date.now();
          const ftsHits = await retrieveBook(question.bookId, question.question, {
            hybrid: false,
            rerank: false,
          });
          recordVariant('fts', question.question, ftsHits, Date.now() - startedAt);

          startedAt = Date.now();
          const hybridHits = await retrieveBook(question.bookId, question.question, {
            hybrid: true,
            rerank: false,
          });
          recordVariant(
            'hybrid',
            question.question,
            hybridHits,
            Date.now() - startedAt,
          );

          startedAt = Date.now();
          const rerankHits = await retrieveBook(question.bookId, question.question, {
            hybrid: true,
            rerank: true,
          });
          recordVariant(
            'hybrid_rerank',
            question.question,
            rerankHits,
            Date.now() - startedAt,
          );

          if (question.priorTurns && question.priorTurns.length > 0) {
            startedAt = Date.now();
            const rewrite = await rewriteQuery({
              llm: chatLlm,
              question: question.question,
              messages: [
                ...question.priorTurns,
                { role: 'user', content: question.question },
              ],
            });
            rewrittenQueries.set(question.id, rewrite.query);
            const rewriteHits = await retrieveBook(question.bookId, rewrite.query, {
              hybrid: true,
              rerank: true,
            });
            recordVariant(
              'hybrid_rerank_rewrite',
              rewrite.query,
              rewriteHits,
              Date.now() - startedAt,
            );
          } else {
            const rerankLatency = detail.variants.hybrid_rerank.latencyMs;
            const rerankHitsForRewrite = await retrieveBook(
              question.bookId,
              question.question,
              { hybrid: true, rerank: true },
            );
            recordVariant(
              'hybrid_rerank_rewrite',
              question.question,
              rerankHitsForRewrite,
              rerankLatency,
            );
          }

          startedAt = Date.now();
          const libraryHits = await retrieveLibrary(question.question);
          recordVariant(
            'library_hybrid',
            question.question,
            libraryHits,
            Date.now() - startedAt,
          );

          reportDetails.push(detail);
        }

        const retrievalMetrics: VariantMetric[] = VARIANT_NAMES.map((name) => {
          const stats = variantStats.get(name)!;
          return {
            name,
            questions: stats.questions,
            recallAt5:
              stats.recallTotal === 0 ? 0 : stats.recallHits / stats.recallTotal,
            locatorAccuracy:
              stats.locatorTotal === 0
                ? 1
                : stats.locatorValid / stats.locatorTotal,
            avgMs: average(stats.latencies),
            p95Ms: percentile(stats.latencies, 0.95),
          };
        });

        console.log('\n[retrieval]', retrievalMetrics);

        const agentLatencies: number[] = [];
        let agentSuccesses = 0;
        let agentErrors = 0;
        let citationValidCount = 0;
        let invalidCitationCount = 0;
        let citationQuestionCount = 0;
        let refusalCorrect = 0;
        let refusalCount = 0;
        const judgeScores: number[] = [];

        for (const question of agentQuestions) {
          const book = EVAL_BOOKS.find((item) => item.id === question.bookId)!;
          const content = contentByBook.get(question.bookId)!;
          const messages = [
            {
              role: 'system' as const,
              content: buildAgentSystemPrompt({
                model: env.chatModel,
                bookName: book.title,
              }),
            },
            ...(question.priorTurns ?? []).map((turn) => ({
              role: turn.role,
              content: turn.content,
            })),
            {
              role: 'user' as const,
              content: buildAgentUserMessage({
                question: question.question,
                bookName: book.title,
              }),
            },
          ];

          const context: AgentToolContext = {
            db,
            userId: LOCAL_USER_ID,
            bookId: question.bookId,
            bookName: book.title,
            content,
            retrieve: (query) =>
              retrieveBook(question.bookId, query, { hybrid: true, rerank: true }),
            searchLibrary: retrieveLibrary,
          };

          const events: AgentEvent[] = [];
          const startedAt = Date.now();
          try {
            const result = await runAgentLoop({
              config: chatConfig,
              messages,
              question: question.question,
              context,
              retrieve: context.retrieve,
              rewriteQuery: async ({ question: q, messages: history }) => {
                const cached = rewrittenQueries.get(question.id);
                if (cached) return cached;
                const rewrite = await rewriteQuery({
                  llm: chatLlm,
                  question: q,
                  messages: history,
                });
                rewrittenQueries.set(question.id, rewrite.query);
                return rewrite.query;
              },
              maxIterations: 3,
              maxToolCallsPerName: 2,
              llm: agentLlm,
              onEvent: (event) => events.push(event),
            });

            const latencyMs = Date.now() - startedAt;
            agentLatencies.push(latencyMs);
            agentSuccesses++;

            const citationCheck = events.find(
              (event): event is Extract<AgentEvent, { type: 'citation_check' }> =>
                event.type === 'citation_check',
            );
            const citations = parseCitationIds(result.content);
            const validIds = result.evidence.map((item) => item.citationId);
            const removed = citationCheck?.removedIds ?? [];
            const locators = locatorStats(result.evidence.map((item) => item.hit), contentByBook);
            const locatorAccuracy =
              locators.total === 0 ? 1 : locators.valid / locators.total;

            let citationValid = false;
            let invalidCitation = false;
            let faithful: boolean | null = null;
            let score: number | null = null;

            if (question.type === 'refusal') {
              refusalCount++;
              const correct = isRefusalAnswer(result.content);
              if (correct) refusalCorrect++;
              faithful = correct;
              score = correct ? 1 : 0;
            } else {
              citationQuestionCount++;
              citationValid =
                citations.length > 0 &&
                citations.every((id) => validIds.includes(id)) &&
                removed.length === 0;
              invalidCitation =
                removed.length > 0 ||
                citations.some((id) => !validIds.includes(id));
              if (citationValid) citationValidCount++;
              if (invalidCitation) invalidCitationCount++;

              try {
                const judgeRaw = await chatLlm.complete(
                  buildJudgePrompt(
                    question,
                    result.content,
                    buildEvidenceMessage(result.evidence),
                  ),
                  { maxTokens: 200, temperature: 0 },
                );
                const judged = parseJudge(judgeRaw);
                if (judged) {
                  faithful = judged.faithful;
                  score = judged.score;
                  judgeScores.push(judged.score);
                }
              } catch (error) {
                console.warn(
                  `[judge] ${question.id} failed:`,
                  error instanceof Error ? error.message : error,
                );
              }
            }

            const detail = reportDetails.find((item) => item.id === question.id);
            if (detail) {
              detail.agent = {
                answer: result.content,
                citations,
                removedCitations: removed,
                citationValid,
                locatorAccuracy,
                faithful,
                score,
                latencyMs,
              };
            }
          } catch (error) {
            agentErrors++;
            const detail = reportDetails.find((item) => item.id === question.id);
            if (detail) {
              detail.agent = {
                answer: '',
                citations: [],
                removedCitations: [],
                citationValid: false,
                locatorAccuracy: 0,
                faithful: null,
                score: null,
                latencyMs: Date.now() - startedAt,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
        }

        expect(agentErrors).toBeLessThan(agentQuestions.length);

        const agentMetric: AgentMetric = {
          questions: agentQuestions.length,
          successes: agentSuccesses,
          citationRate:
            citationQuestionCount === 0
              ? 0
              : citationValidCount / citationQuestionCount,
          invalidCitationRate:
            citationQuestionCount === 0
              ? 0
              : invalidCitationCount / citationQuestionCount,
          faithfulness:
            judgeScores.length === 0 ? null : average(judgeScores),
          refusalAccuracy:
            refusalCount === 0 ? 0 : refusalCorrect / refusalCount,
          avgMs: average(agentLatencies),
          p95Ms: percentile(agentLatencies, 0.95),
          errors: agentErrors,
        };

        const generatedAt = new Date().toISOString();
        const report = {
          generatedAt,
          models: {
            chat: env.chatModel,
            embed: env.embedModel,
          },
          config: {
            chatBaseUrl: env.chatBaseUrl,
            embedBaseUrl: env.embedBaseUrl,
            embedDims: env.embedDims,
            dataset: `${EVAL_BOOKS.length} books x ${EVAL_QUESTIONS.length} questions`,
            agentQuestions: agentQuestions.length,
          },
          index: indexStats,
          retrieval: retrievalMetrics,
          agent: agentMetric,
          details: reportDetails,
        };

        const reportDir = path.resolve(process.cwd(), 'evals/reports');
        fs.mkdirSync(reportDir, { recursive: true });
        const stamp = generatedAt.replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(reportDir, `eval-${stamp}.json`),
          JSON.stringify(report, null, 2),
        );
        fs.writeFileSync(
          path.join(reportDir, 'latest.json'),
          JSON.stringify(report, null, 2),
        );
        const markdown = buildReportMarkdown(report);
        fs.writeFileSync(path.join(reportDir, `eval-${stamp}.md`), markdown);
        fs.writeFileSync(path.join(reportDir, 'latest.md'), markdown);

        console.log('\n[agent]', agentMetric);
        console.log(`\n报告已写入 ${reportDir}`);
      } finally {
        close();
      }
    },
    900000,
  );
});
