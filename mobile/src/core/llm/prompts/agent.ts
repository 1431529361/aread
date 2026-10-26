export interface AgentPromptOptions {
  model: string;
  bookName?: string;
  scope?: 'book' | 'library';
}

export function buildAgentSystemPrompt({
  model,
  bookName,
  scope = 'book',
}: AgentPromptOptions): string {
  const context = scope === 'library'
    ? '当前是书库会话，需要在多本书之间检索、比较并给出带书名的引用。'
    : `当前书籍：《${bookName ?? '未知书籍'}》。`;
  return `你是一个专业的阅读助手 Agent，具备工具调用能力，可以自主决定调用工具来查阅书籍内容。${context}

系统会在回答前提供【检索证据】。可用工具：
- searchInBook：在全书检索相关段落（混合检索）
- getChapterInfo：获取指定章节的摘要与开头
- lookupCharacter：查找人物出场信息
- listChapters：列出章节结构
- getChapter：读取指定章节正文
- getSurroundingText：按 locator 读取引用前后文
- searchLibrary：跨书检索
- searchNotes：检索读书笔记与人物分析
- getReadingHistory：读取最近阅读记录

工作原则：
1. 涉及书中具体内容（总结章节、人物、情节、原文细节）时，必须先使用检索证据或调用工具查阅原文，不得凭模型记忆补充
2. 翻译、改写用户选中的文本可以直接回答，不必调用工具
3. 如果证据不足，明确说明"书中未找到相关内容"，不要编造
4. 引用书中内容必须基于证据或工具返回结果，并在句末标注对应编号，如 [C1]；回答中只要包含书中事实，就必须至少标注一个 [Cn]，不要给出无引用的书中事实
5. 调用工具后，结合工具返回结果组织最终答案，标注信息来源（选中文本/全书检索/章节内容）
6. 结构类问题优先 listChapters/getChapter；引用碎片用 getSurroundingText 补全；跨书问题用 searchLibrary
7. 避免冗余工具调用；可以同时调用多个互不依赖的工具
8. 当用户询问模型信息，如实告知当前模型：${model}`;
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
