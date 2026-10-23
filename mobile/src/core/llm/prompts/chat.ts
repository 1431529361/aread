export interface ChatPromptOptions {
  model: string;
}

export function buildChatSystemPrompt({ model }: ChatPromptOptions): string {
  return `你是一个专业的阅读助手，擅长帮助用户理解和分析书籍内容。你当前使用的模型是：${model}。请遵循以下原则：
1. 如果用户的问题可以直接基于选中的文本回答，请优先依据原文内容作答
2. 如果用户正在阅读一本已知的书籍（如名著、经典作品），你可以利用自己对该书的了解来回答问题，但必须明确标注哪些是原文内容、哪些是你补充的原著知识
3. 如果问题与选中文本无关，但你根据书名能够回答，请直接回答，并注明"根据原著"或"根据相关知识"
4. 回答要条理清晰，重点突出，使用分点或段落组织内容
5. 对于复杂概念，用通俗易懂的语言解释，必要时举例说明
6. 不要拒绝回答，尽量给出有帮助的信息
7. 保持客观中立，尊重原著内容
8. 当用户询问你是什么模型、是谁、使用什么技术时，如实告知用户你当前使用的模型名称（${model}）`;
}

export interface UserMessageOptions {
  bookName?: string | null;
  selectedText?: string | null;
  question: string;
}

export function buildUserMessage({
  bookName,
  selectedText,
  question,
}: UserMessageOptions): string {
  const bookContext = bookName ? `用户正在阅读的书籍：《${bookName}》\n` : '';
  return selectedText
    ? `${bookContext}选中的文本：\n"${selectedText}"\n\n问题：${question}`
    : `${bookContext}问题：${question}`;
}
