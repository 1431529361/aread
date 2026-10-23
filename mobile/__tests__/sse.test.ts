import { describe, expect, it } from 'vitest';
import { createSseParser, extractStreamContent } from '../src/services/sse';

describe('createSseParser', () => {
  it('跨分片缓冲并派发 data 事件', () => {
    const events: Array<{ event?: string; data: string }> = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('data: {"choices":[{"delta":{"content":"你"}}]}\n');
    parser.push('\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n');

    expect(events).toHaveLength(2);
    expect(extractStreamContent(events[0].data)).toBe('你');
    expect(extractStreamContent(events[1].data)).toBe('好');
  });

  it('支持 event 名称、多行 data、注释与 CRLF', () => {
    const events: Array<{ event?: string; data: string }> = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push(': ping\r\nevent: message\r\ndata: line1\r\ndata: line2\r\n\r\n');
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('flush 会派发没有结尾空行的最后一个事件', () => {
    const events: Array<{ event?: string; data: string }> = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('data: {"choices":[]}');
    parser.flush();
    expect(events).toHaveLength(1);
  });
});

describe('extractStreamContent', () => {
  it('兼容 delta 与完整 message', () => {
    expect(
      extractStreamContent('{"choices":[{"delta":{"content":"增量"}}]}'),
    ).toBe('增量');
    expect(
      extractStreamContent('{"choices":[{"message":{"content":"完整"}}]}'),
    ).toBe('完整');
  });

  it('[DONE]、空内容与坏 JSON 返回空串', () => {
    expect(extractStreamContent('[DONE]')).toBe('');
    expect(extractStreamContent('')).toBe('');
    expect(extractStreamContent('not-json')).toBe('');
    expect(extractStreamContent('{"choices":[{"delta":{}}]}')).toBe('');
  });
});
