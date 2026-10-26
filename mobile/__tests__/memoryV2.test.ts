import { describe, expect, it } from 'vitest';
import {
  evictionScore,
  formatMemoryPromptBlock,
  memoryRelevance,
  parseAdjudicationDecisions,
  parseMemoryCandidates,
  selectMemoriesForPrompt,
  shouldExtractMemories,
  type MemoryRecord,
} from '../src/core/conversation/memoryV2';

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 1,
    userId: 'local',
    kind: 'fact',
    layer: 'profile',
    status: 'active',
    content: '用户偏好简洁回答',
    salience: 1,
    sourceConv: null,
    sourceMessageId: null,
    validFrom: null,
    supersededBy: null,
    lastUsedAt: null,
    useCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseMemoryCandidates', () => {
  it('解析分层候选并夹紧置信度', () => {
    const candidates = parseMemoryCandidates(
      '```json\n[{"layer":"episodic","kind":"interest","content":"用户读完了《活着》","evidence":"对话","confidence":1.5,"salience":0.8},{"content":"  "}]\n```',
    );

    expect(candidates).toEqual([
      {
        layer: 'episodic',
        kind: 'interest',
        content: '用户读完了《活着》',
        evidence: '对话',
        confidence: 1,
        salience: 0.8,
      },
    ]);
  });

  it('非法 JSON 返回空数组', () => {
    expect(parseMemoryCandidates('not json')).toEqual([]);
  });
});

describe('parseAdjudicationDecisions', () => {
  it('过滤无 targetId 的 UPDATE/SUPERSEDE 与越界索引', () => {
    const decisions = parseAdjudicationDecisions(
      JSON.stringify([
        { candidateIndex: 0, op: 'ADD', targetId: null, content: '新记忆' },
        { candidateIndex: 1, op: 'UPDATE', targetId: 5, content: '更新' },
        { candidateIndex: 2, op: 'SUPERSEDE', targetId: null },
        { candidateIndex: 8, op: 'NOOP' },
        { candidateIndex: 0, op: 'NOOP' },
      ]),
      3,
    );

    expect(decisions).toEqual([
      { candidateIndex: 0, op: 'ADD', targetId: null, content: '新记忆' },
      { candidateIndex: 1, op: 'UPDATE', targetId: 5, content: '更新' },
    ]);
  });
});

describe('shouldExtractMemories', () => {
  it('累计 6 轮触发', () => {
    expect(shouldExtractMemories({ userTurnsSinceExtract: 6, idleMs: 0 })).toEqual({
      due: true,
      reason: 'turns',
    });
  });

  it('空闲 5 分钟触发', () => {
    expect(
      shouldExtractMemories({ userTurnsSinceExtract: 3, idleMs: 5 * 60 * 1000 }),
    ).toEqual({ due: true, reason: 'idle' });
  });

  it('未到门槛不触发', () => {
    expect(
      shouldExtractMemories({ userTurnsSinceExtract: 5, idleMs: 4 * 60 * 1000 }),
    ).toEqual({ due: false, reason: 'not_due' });
  });
});

describe('evictionScore', () => {
  it('新记忆与高使用次数得分更高', () => {
    const now = Date.parse('2026-10-23T00:00:00.000Z');
    const recent = memory({ updatedAt: '2026-10-22T00:00:00.000Z', useCount: 3 });
    const old = memory({ updatedAt: '2026-06-01T00:00:00.000Z' });

    expect(evictionScore(recent, now)).toBeGreaterThan(evictionScore(old, now));
  });
});

describe('memoryRelevance', () => {
  it('有向量时使用余弦相似度', () => {
    const target = memory({
      content: '任意内容',
      embedding: Float32Array.from([1, 0]),
    });
    expect(
      memoryRelevance(target, '查询', Float32Array.from([1, 0])),
    ).toBeCloseTo(1);
    expect(
      memoryRelevance(target, '查询', Float32Array.from([0, 1])),
    ).toBeCloseTo(0);
  });
});

describe('selectMemoriesForPrompt', () => {
  it('profile 最多 8 条且总长不超过 300 字', () => {
    const memories = Array.from({ length: 10 }, (_, index) =>
      memory({
        id: index + 1,
        content: `画像${index}`.padEnd(60, '啊'),
      }),
    );

    const selection = selectMemoriesForPrompt(memories);
    const totalChars =
      selection.profile.reduce((sum, item) => sum + item.content.length, 0) +
      Math.max(0, selection.profile.length - 1);

    expect(selection.profile.length).toBeLessThanOrEqual(8);
    expect(totalChars).toBeLessThanOrEqual(300);
  });

  it('episodic 只注入相关项', () => {
    const selection = selectMemoriesForPrompt(
      [
        memory({ id: 2, layer: 'episodic', content: '明清史与明代政治' }),
        memory({ id: 3, layer: 'episodic', content: '量子物理与宇宙学' }),
      ],
      { query: '明清史' },
    );

    expect(selection.episodic.map((item) => item.id)).toEqual([2]);
  });

  it('procedural 仅在任务模式注入', () => {
    const memories = [memory({ id: 4, layer: 'procedural', content: '笔记使用二级标题' })];

    expect(selectMemoriesForPrompt(memories).procedural).toEqual([]);
    expect(
      selectMemoriesForPrompt(memories, { taskType: 'generate-notes' }).procedural,
    ).toHaveLength(1);
  });

  it('相同内容跨层只注入一次', () => {
    const selection = selectMemoriesForPrompt([
      memory({ id: 5, layer: 'profile', content: '用户偏好简洁回答' }),
      memory({ id: 6, layer: 'procedural', content: '用户偏好简洁回答！' }),
    ], { taskType: 'generate-notes' });

    expect(selection.profile).toHaveLength(1);
    expect(selection.procedural).toHaveLength(0);
  });
});

describe('formatMemoryPromptBlock', () => {
  it('分节输出并附使用约束', () => {
    const selection = selectMemoriesForPrompt([
      memory({ layer: 'profile', content: '用户偏好简洁回答' }),
      memory({ id: 2, layer: 'episodic', content: '明清史与明代政治' }),
    ], { query: '明清史' });

    const block = formatMemoryPromptBlock(selection);
    expect(block).toContain('【用户画像】');
    expect(block).toContain('【相关阅读经历】');
    expect(block).toContain('不要主动提及记忆本身');
  });

  it('无记忆返回空串', () => {
    expect(
      formatMemoryPromptBlock({ profile: [], episodic: [], procedural: [] }),
    ).toBe('');
  });
});
