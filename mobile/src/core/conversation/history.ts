export interface HistorySourceMessage {
  role: string;
  content: string | null;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 选取最近若干条 user/assistant 消息作为模型历史。
 * 从最新往回装，超出预算即停止；返回按时间正序。
 */
export function selectHistoryMessages(
  messages: readonly HistorySourceMessage[],
  options: { maxMessages?: number; maxChars?: number } = {},
): HistoryMessage[] {
  const maxMessages = Math.max(0, options.maxMessages ?? 20);
  const maxChars = Math.max(0, options.maxChars ?? 30000);
  if (maxMessages === 0 || maxChars === 0) return [];

  const selected: HistoryMessage[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (selected.length >= maxMessages) break;
    const message = messages[i];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = (message.content ?? '').trim();
    if (!content) continue;

    const remaining = maxChars - used;
    if (remaining <= 0) break;

    if (content.length <= remaining) {
      selected.push({ role: message.role, content });
      used += content.length;
    } else if (selected.length === 0) {
      // 最近一条仍然超预算时保留尾部，避免新问题无法带上上下文
      selected.push({ role: message.role, content: content.slice(-remaining) });
      used += remaining;
    } else {
      break;
    }
  }

  return selected.reverse();
}
