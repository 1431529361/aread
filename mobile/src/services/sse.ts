/** SSE 行解析：网络分片可能把一行拆开，这里统一缓冲。 */
export interface SseEvent {
  event?: string;
  data: string;
}

export function createSseParser(onEvent: (event: SseEvent) => void) {
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return;
    }
    onEvent({ event: eventName, data: dataLines.join('\n') });
    eventName = undefined;
    dataLines = [];
  };

  const handleLine = (rawLine: string): void => {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    },
    flush(): void {
      if (buffer) {
        handleLine(buffer);
        buffer = '';
      }
      dispatch();
    },
  };
}

type DeltaPayload = {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  error?: { message?: string };
};

/**
 * 从一条 SSE data 里取出增量文本；[DONE] 与坏 JSON 返回空串。
 * 某些兼容端点会在流中返回完整 message，这里一并兼容。
 */
export function extractStreamContent(data: string): string {
  if (!data || data.trim() === '[DONE]') return '';
  try {
    const parsed = JSON.parse(data) as DeltaPayload;
    const choice = parsed.choices?.[0];
    return choice?.delta?.content ?? choice?.message?.content ?? '';
  } catch {
    return '';
  }
}
