import { describe, expect, it } from 'vitest';
import { selectHistoryMessages } from '../src/core/conversation/history';

describe('selectHistoryMessages', () => {
  it('保留最近若干条并恢复时间正序', () => {
    const messages = [
      { role: 'user', content: '问题一' },
      { role: 'assistant', content: '回答一' },
      { role: 'user', content: '问题二' },
      { role: 'assistant', content: '回答二' },
    ];
    const selected = selectHistoryMessages(messages, { maxMessages: 3 });
    expect(selected.map((item) => item.content)).toEqual(['回答一', '问题二', '回答二']);
  });

  it('跳过 system/tool 与空消息', () => {
    const selected = selectHistoryMessages(
      [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '' },
        { role: 'user', content: '   ' },
        { role: 'tool', content: '工具结果' },
        { role: 'assistant', content: '有效回答' },
      ],
      { maxMessages: 5 },
    );
    expect(selected).toEqual([{ role: 'assistant', content: '有效回答' }]);
  });

  it('按字符预算从新到旧装载', () => {
    const selected = selectHistoryMessages(
      [
        { role: 'user', content: 'a'.repeat(10) },
        { role: 'assistant', content: 'b'.repeat(10) },
        { role: 'user', content: 'c'.repeat(10) },
      ],
      { maxChars: 15 },
    );
    expect(selected).toEqual([{ role: 'user', content: 'c'.repeat(10) }]);
  });

  it('最近一条超预算时保留尾部', () => {
    const selected = selectHistoryMessages([{ role: 'user', content: '0123456789' }], {
      maxChars: 4,
    });
    expect(selected).toEqual([{ role: 'user', content: '6789' }]);
  });

  it('预算为 0 时返回空数组', () => {
    const messages = [{ role: 'user', content: '你好' }];
    expect(selectHistoryMessages(messages, { maxMessages: 0 })).toEqual([]);
    expect(selectHistoryMessages(messages, { maxChars: 0 })).toEqual([]);
  });

  it('消息内容会 trim 后计入预算', () => {
    const selected = selectHistoryMessages([{ role: 'user', content: '  你好  ' }], {
      maxChars: 10,
    });
    expect(selected).toEqual([{ role: 'user', content: '你好' }]);
  });
});
