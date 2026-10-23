export interface QueryRewritePromptParams {
  history: string;
  question: string;
}

export function buildQueryRewritePrompt({
  history,
  question,
}: QueryRewritePromptParams): string {
  return `你是检索查询改写器。请结合最近对话，把用户的追问改写成一个可以独立检索的问题。

最近对话：
${history}

用户追问：
${question}

要求：
1. 补全代词、省略的主语/宾语、跨书指代和上文限定条件
2. 保留原问题中的书名、章节名、人物名等关键实体
3. 只输出改写后的一个问句，不要回答问题，不要解释，不要加引号
4. 如果原问题已经足够独立，原样输出`;
}
