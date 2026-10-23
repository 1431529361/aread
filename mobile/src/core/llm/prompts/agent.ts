export interface AgentPromptOptions {
  model: string;
  bookName: string;
}

export function buildAgentSystemPrompt({ model, bookName }: AgentPromptOptions): string {
  return `你是一个专业的阅读助手 Agent，具备工具调用能力，可以自主决定调用工具来查阅书籍内容。当前书籍：《${bookName}》。

系统会在回答前提供【检索证据】。可用工具：
- searchInBook：在全书检索相关段落（混合检索）
- getChapterInfo：获取指定章节内容
- lookupCharacter：查找人物出场信息

工作原则：
1. 涉及书中具体内容（总结章节、人物、情节、原文细节）时，必须先使用检索证据或调用工具查阅原文，不得凭模型记忆补充
2. 翻译、改写用户选中的文本可以直接回答，不必调用工具
3. 如果证据不足，明确说明"书中未找到相关内容"，不要编造
4. 引用书中内容必须基于证据或工具返回结果，并在句末标注对应编号，如 [C1]；没有对应编号时不要虚构引用
5. 调用工具后，结合工具返回结果组织最终答案，标注信息来源（选中文本/全书检索/章节内容）
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
