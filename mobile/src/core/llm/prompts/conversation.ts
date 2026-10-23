import { MAX_MEMORY_PER_EXTRACT } from '../../conversation/memory';

export interface CompressionPromptOptions {
  existingSummary?: string | null;
  olderText: string;
}

export function buildCompressionPrompt({
  existingSummary,
  olderText,
}: CompressionPromptOptions): string {
  return `请将以下对话历史压缩为简洁的要点摘要，用于后续对话的上下文记忆。
${existingSummary ? `已有摘要（请在其基础上归并更新）：\n${existingSummary}\n\n` : ''}待压缩的对话历史：
${olderText}

要求：
1. 保留关键结论、用户的核心诉求、已确认的事实与偏好
2. 去除寒暄、重复与冗余细节
3. 用第三人称客观陈述，分点罗列，控制在 300 字以内
4. 只输出摘要正文，不要额外说明`;
}

export function buildMemoryExtractionPrompt(conversationText: string): string {
  return `你是一个记忆抽取器。请从以下对话中，抽取"值得长期记住"的关于【用户】的稳定信息（如：阅读偏好、语言/风格偏好、身份背景、长期关注的主题或作者）。

对话：
${conversationText}

要求：
1. 只抽取关于用户本人的、跨会话仍然成立的稳定信息；不要抽取一次性的问题内容或书籍剧情
2. 每条信息独立、简洁（一句话），用第三人称陈述，如"用户偏好简洁的分点回答"
3. 最多 ${MAX_MEMORY_PER_EXTRACT} 条；若无值得记忆的信息，返回空数组
4. 严格输出 JSON 数组，每个元素为 {"kind":"preference|fact|interest","content":"...","salience":0.1~1.0}，不要输出其他文字`;
}
