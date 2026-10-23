import {
  MAX_MEMORY_PER_EXTRACT,
  type MemoryCandidate,
  type MemoryLayer,
  type MemoryStatus,
} from '../../conversation/memoryV2';

export function buildMemoryCandidatesPrompt(conversationText: string): string {
  return `你是长期记忆抽取器。请从以下对话中，抽取"值得长期记住"的关于【用户】的稳定信息。

对话：
${conversationText}

输出 JSON 数组，最多 ${MAX_MEMORY_PER_EXTRACT} 条；若没有值得记忆的信息，输出 []：
[{"layer":"profile|episodic|procedural","kind":"preference|fact|interest","content":"一句话","evidence":"对话中的依据","confidence":0.0,"salience":0.0}]

分层规则：
- profile：稳定的阅读偏好、身份背景、长期关注的主题/作者
- episodic：阅读经历（读完/弃读、完成时间、高亮主题）
- procedural：对回答方式、输出结构、任务流程的偏好

严禁抽取书籍剧情、一次性问题、助手自己的观点。content 用第三人称、简洁完整的一句话。只输出 JSON，不要输出其他文字。`;
}

export interface MemoryNeighbor {
  id: number;
  content: string;
  layer: MemoryLayer;
  status: MemoryStatus;
}

export function buildMemoryAdjudicationPrompt(params: {
  candidates: readonly MemoryCandidate[];
  similar: ReadonlyArray<readonly MemoryNeighbor[]>;
}): string {
  const blocks = params.candidates
    .map((candidate, index) => {
      const neighbors = params.similar[index] ?? [];
      const neighborText =
        neighbors.length === 0
          ? '（无相似记忆）'
          : neighbors
              .map(
                (memory) =>
                  `- id=${memory.id} [${memory.layer}/${memory.status}] ${memory.content}`,
              )
              .join('\n');
      return `候选 ${index}：
${JSON.stringify({
  layer: candidate.layer,
  kind: candidate.kind,
  content: candidate.content,
  confidence: candidate.confidence,
  salience: candidate.salience,
})}
相似记忆：
${neighborText}`;
    })
    .join('\n\n');

  return `你是长期记忆合并判定器。对每个候选记忆，结合最相似的已有记忆，决定如何处理：

- ADD：没有重复，新增
- UPDATE：同一事实的补充/修正，targetId 必须是相似记忆的 id
- SUPERSEDE：用户偏好发生变化，旧记忆应失效；targetId 必须是相似记忆的 id
- NOOP：已存在、无关或价值不足

${blocks}

输出 JSON 数组，按 candidateIndex 对齐：
[{"candidateIndex":0,"op":"ADD|UPDATE|SUPERSEDE|NOOP","targetId":null,"content":"合并后的最终内容","reason":"简要理由"}]

规则：
- UPDATE/SUPERSEDE 必须提供 targetId；ADD/NOOP 的 targetId 为 null
- UPDATE/SUPERSEDE 的 content 必须是合并后的最终内容
- 只输出 JSON，不要输出其他文字`;
}
