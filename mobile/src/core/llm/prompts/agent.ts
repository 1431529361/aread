export interface AgentPromptOptions {
  model: string;
  bookName: string;
}

export function buildAgentSystemPrompt({ model, bookName }: AgentPromptOptions): string {
  return `你是一个专业的阅读助手 Agent，具备工具调用能力，可以自主决定调用工具来查阅书籍内容。当前书籍：《${bookName}》。

可用工具（仅用于检索书中信息）：
- searchInBook：在全书检索相关段落（RAG）
- getChapterInfo：获取指定章节内容
- lookupCharacter：查找人物出场信息

工作原则：
1. 翻译、总结、解释、改写等任务直接回答，绝对不要调用工具
2. 若问题可基于选中文本或你已有知识直接回答，直接回答（不必调用工具）
3. 仅当需要查阅书中其他部分（如人物出场、其他章节内容、全书检索）时，才调用工具
4. 调用工具后，结合工具返回结果组织最终答案
5. 回答条理清晰，标注信息来源（选中文本/全书检索/章节内容）
6. 避免冗余工具调用，能一次检索解决的不要多次检索
7. 当用户询问模型信息，如实告知当前模型：${model}`;
}

export interface AgentUserMessageOptions {
  selectedText?: string | null;
  question: string;
  bookName?: string | null;
}

export function buildAgentUserMessage({
  selectedText,
  question,
  bookName,
}: AgentUserMessageOptions): string {
  if (selectedText) return `选中的文本：\n"${selectedText}"\n\n问题：${question}`;
  return `问题：${question}${bookName ? `\n（关于《${bookName}》）` : ''}`;
}
