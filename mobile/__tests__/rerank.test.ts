import { describe, expect, it } from 'vitest';
import {
  buildRerankPrompt,
  createLlmReranker,
  createNativeReranker,
  parseRerankOrder,
  reorderByIndex,
  type RerankLlm,
} from '../src/core/rag/rerank';
import type { FetchLike } from '../src/core/http';
import type { RetrievalHit } from '../src/core/types';

function hit(id: number, text: string): RetrievalHit {
  return {
    chunkId: id,
    bookId: 'b1',
    bookTitle: '测试书',
    chapter: `第${id}章`,
    text,
    loc: { kind: 'txt', href: null, start: id * 10, end: id * 10 + text.length },
    score: 1 / id,
    sources: ['fts'],
  };
}

class FakeLlm implements RerankLlm {
  readonly prompts: string[] = [];
  private readonly output: string | Error;

  constructor(output: string | Error) {
    this.output = output;
  }

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.output instanceof Error) throw this.output;
    return this.output;
  }
}

describe('buildRerankPrompt', () => {
  it('包含查询、候选编号与文本', () => {
    const prompt = buildRerankPrompt('自由是什么', [
      hit(1, '自由是重要的价值'),
      hit(2, '爱情故事'),
    ]);

    expect(prompt).toContain('自由是什么');
    expect(prompt).toContain('[0]');
    expect(prompt).toContain('[1]');
    expect(prompt).toContain('自由是重要的价值');
    expect(prompt).toContain('[2,0,1]');
  });
});

describe('parseRerankOrder', () => {
  it('解析数字数组并补齐缺失编号', () => {
    expect(parseRerankOrder('[2,0]', 3)).toEqual([2, 0, 1]);
  });

  it('支持对象形式的 candidateIndex', () => {
    expect(
      parseRerankOrder('[{"candidateIndex":1},{"index":0}]', 3),
    ).toEqual([1, 0, 2]);
  });

  it('忽略重复与越界编号', () => {
    expect(parseRerankOrder('[5,1,1,-1,0]', 3)).toEqual([1, 0, 2]);
  });

  it('无有效编号时报错', () => {
    expect(() => parseRerankOrder('not json', 3)).toThrow();
    expect(() => parseRerankOrder('[]', 3)).toThrow();
  });
});

describe('reorderByIndex', () => {
  it('按编号重排', () => {
    const hits = [hit(1, 'A'), hit(2, 'B'), hit(3, 'C')];
    expect(reorderByIndex(hits, [2, 0, 1]).map((item) => item.chunkId)).toEqual([
      3, 1, 2,
    ]);
  });
});

describe('createLlmReranker', () => {
  const hits = [hit(1, 'A'), hit(2, 'B'), hit(3, 'C')];

  it('用现有对话模型重排候选', async () => {
    const llm = new FakeLlm('[2,0,1]');
    const reranked = await createLlmReranker({ llm })('查询', hits);

    expect(reranked.map((item) => item.chunkId)).toEqual([3, 1, 2]);
    expect(llm.prompts).toHaveLength(1);
  });

  it('请求失败时回退原顺序', async () => {
    const llm = new FakeLlm(new Error('429'));
    const reranked = await createLlmReranker({ llm })('查询', hits);
    expect(reranked).toEqual(hits);
  });

  it('模型返回非法结果时回退原顺序', async () => {
    const llm = new FakeLlm('我无法排序');
    const reranked = await createLlmReranker({ llm })('查询', hits);
    expect(reranked).toEqual(hits);
  });

  it('只有一个候选时不调用模型', async () => {
    const llm = new FakeLlm('[0]');
    const reranked = await createLlmReranker({ llm })('查询', [hits[0]]);
    expect(reranked).toEqual([hits[0]]);
    expect(llm.prompts).toHaveLength(0);
  });
});

describe('createNativeReranker', () => {
  const hits = [hit(1, '自由是重要的价值'), hit(2, '爱情故事'), hit(3, '制度保障自由')];

  function rerankResponse(results: Array<{ index: number; score: number }>): Response {
    return new Response(
      JSON.stringify({
        results: results.map((item) => ({
          index: item.index,
          relevance_score: item.score,
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('调用 /rerank 并按 relevance_score 重排', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return rerankResponse([
        { index: 2, score: 0.9 },
        { index: 0, score: 0.4 },
        { index: 1, score: 0.1 },
      ]);
    };

    const reranker = createNativeReranker(
      {
        baseUrl: 'https://api.siliconflow.cn/v1/',
        apiKey: 'test-key',
        model: 'BAAI/bge-reranker-v2-m3',
      },
      { fetchImpl },
    );

    const result = await reranker!('自由是什么', hits);
    expect(result.map((item) => item.chunkId)).toEqual([3, 1, 2]);
    expect(url).toBe('https://api.siliconflow.cn/v1/rerank');
    expect(body).toMatchObject({
      model: 'BAAI/bge-reranker-v2-m3',
      query: '自由是什么',
      documents: ['自由是重要的价值', '爱情故事', '制度保障自由'],
      top_n: 3,
    });
  });

  it('模型留空时不启用', () => {
    expect(
      createNativeReranker({
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: 'key',
        model: '  ',
      }),
    ).toBeNull();
  });

  it('网络失败时回退原顺序', async () => {
    const reranker = createNativeReranker(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'key', model: 'rerank' },
      {
        fetchImpl: async () => {
          throw new Error('offline');
        },
      },
    );

    expect(await reranker!('查询', hits)).toEqual(hits);
  });

  it('只返回部分候选时补齐其余候选', async () => {
    const reranker = createNativeReranker(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'key', model: 'rerank' },
      {
        fetchImpl: async () => rerankResponse([{ index: 1, score: 0.9 }]),
      },
    );

    expect((await reranker!('查询', hits)).map((item) => item.chunkId)).toEqual([
      2, 1, 3,
    ]);
  });

  it('文档按 maxDocumentChars 截断', async () => {
    let body: { documents?: string[] } = {};
    const reranker = createNativeReranker(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'key', model: 'rerank' },
      {
        maxDocumentChars: 3,
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return rerankResponse([{ index: 0, score: 1 }]);
        },
      },
    );

    await reranker!('查询', hits);
    expect(body.documents).toEqual(['自由是', '爱情故', '制度保']);
  });
});
