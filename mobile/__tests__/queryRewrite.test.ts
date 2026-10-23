import { describe, expect, it } from 'vitest';
import {
  buildRewriteHistory,
  normalizeRewrittenQuery,
  rewriteQuery,
  type QueryRewriteLlm,
} from '../src/core/rag/queryRewrite';

class FakeLlm implements QueryRewriteLlm {
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

const currentQuestion = '他后来怎么样了？';

const pronounMessages = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '福贵为什么离开家乡？' },
  { role: 'assistant', content: '因为他被抓去当壮丁。' },
  { role: 'user', content: currentQuestion },
];

describe('rewriteQuery', () => {
  it('没有历史时不调用模型', async () => {
    const llm = new FakeLlm('不会用到');
    const result = await rewriteQuery({
      llm,
      question: currentQuestion,
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: currentQuestion },
      ],
    });

    expect(result).toMatchObject({
      query: currentQuestion,
      rewritten: false,
      reason: 'no_history',
    });
    expect(llm.prompts).toHaveLength(0);
  });

  it('代词追问改写成独立问题', async () => {
    const llm = new FakeLlm('福贵后来怎么样了？');
    const result = await rewriteQuery({
      llm,
      question: currentQuestion,
      messages: pronounMessages,
    });

    expect(result).toMatchObject({
      query: '福贵后来怎么样了？',
      rewritten: true,
      reason: 'rewritten',
    });
    expect(llm.prompts[0]).toContain('福贵为什么离开家乡');
    expect(llm.prompts[0]).toContain('只输出改写后的一个问句');
  });

  it('省略追问结合上一轮章节补全', async () => {
    const llm = new FakeLlm('第四章讲了什么？');
    const result = await rewriteQuery({
      llm,
      question: '那第四章呢？',
      messages: [
        { role: 'user', content: '第三章讲了什么？' },
        { role: 'assistant', content: '第三章讲的是主人公返乡。' },
        { role: 'user', content: '那第四章呢？' },
      ],
    });

    expect(result.query).toBe('第四章讲了什么？');
    expect(llm.prompts[0]).toContain('第三章讲了什么');
  });

  it('跨书指代保留两本书名', async () => {
    const llm = new FakeLlm('《许三观卖血记》里的许三观经历了什么？');
    const result = await rewriteQuery({
      llm,
      question: '那《许三观卖血记》里的他呢？',
      messages: [
        { role: 'user', content: '《活着》里的福贵为什么离开家乡？' },
        { role: 'assistant', content: '福贵因被抓壮丁离开。' },
        { role: 'user', content: '那《许三观卖血记》里的他呢？' },
      ],
    });

    expect(result.query).toContain('许三观卖血记');
    expect(llm.prompts[0]).toContain('《活着》');
  });

  it('模型失败时回退原问题', async () => {
    const llm = new FakeLlm(new Error('timeout'));
    const result = await rewriteQuery({
      llm,
      question: currentQuestion,
      messages: pronounMessages,
    });

    expect(result).toMatchObject({
      query: currentQuestion,
      rewritten: false,
      error: 'timeout',
    });
  });

  it('空问题不调用模型', async () => {
    const llm = new FakeLlm('不会用到');
    const result = await rewriteQuery({
      llm,
      question: '   ',
      messages: pronounMessages,
    });

    expect(result.reason).toBe('empty_question');
    expect(llm.prompts).toHaveLength(0);
  });
});

describe('buildRewriteHistory', () => {
  it('只保留最近 3 轮', () => {
    const messages = [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮问题' },
      { role: 'assistant', content: '第二轮回答' },
      { role: 'user', content: '第三轮问题' },
      { role: 'assistant', content: '第三轮回答' },
      { role: 'user', content: '第四轮问题' },
      { role: 'assistant', content: '第四轮回答' },
    ];

    const history = buildRewriteHistory(messages);
    expect(history).not.toContain('第一轮');
    expect(history).toContain('第二轮');
    expect(history).toContain('第四轮');
  });
});

describe('normalizeRewrittenQuery', () => {
  it('去掉标签、引号与多余行', () => {
    expect(
      normalizeRewrittenQuery('改写后：“福贵为什么离开家乡？”\n解释：补全了主语', '原问题'),
    ).toBe('福贵为什么离开家乡？');
  });

  it('空输出回退原问题', () => {
    expect(normalizeRewrittenQuery('   ', '原问题')).toBe('原问题');
  });

  it('限制最大长度', () => {
    const query = normalizeRewrittenQuery('字'.repeat(300), '原问题');
    expect(query).toHaveLength(200);
  });
});
