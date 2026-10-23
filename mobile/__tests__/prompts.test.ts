import { describe, expect, it } from 'vitest';
import {
  buildAgentSystemPrompt,
  buildAgentUserMessage,
  buildChatSystemPrompt,
  buildCompressionPrompt,
  buildMemoryExtractionPrompt,
  buildUserMessage,
} from '../src/core/llm/prompts';

describe('prompts', () => {
  it('对话 system prompt 注入模型名', () => {
    const prompt = buildChatSystemPrompt({ model: 'gpt-test' });
    expect(prompt).toContain('专业的阅读助手');
    expect(prompt).toContain('gpt-test');
  });

  it('对话 user message 包含书名与选中文本', () => {
    expect(
      buildUserMessage({ bookName: '三体', selectedText: '黑暗森林', question: '什么意思？' }),
    ).toBe('用户正在阅读的书籍：《三体》\n选中的文本：\n"黑暗森林"\n\n问题：什么意思？');
    expect(buildUserMessage({ question: '你好' })).toBe('问题：你好');
  });

  it('Agent prompt 注入书名与模型名', () => {
    const prompt = buildAgentSystemPrompt({ model: 'qwen-test', bookName: '活着' });
    expect(prompt).toContain('《活着》');
    expect(prompt).toContain('qwen-test');
    expect(prompt).toContain('searchInBook');
  });

  it('Agent user message 在无选中文本时附上书名', () => {
    expect(buildAgentUserMessage({ question: '讲了什么', bookName: '活着' })).toBe(
      '问题：讲了什么\n（关于《活着》）',
    );
  });

  it('压缩 prompt 合并已有摘要', () => {
    const prompt = buildCompressionPrompt({
      existingSummary: '旧摘要',
      olderText: '用户：问题\n助手：回答',
    });
    expect(prompt).toContain('旧摘要');
    expect(prompt).toContain('用户：问题');
    expect(prompt).toContain('300 字以内');
  });

  it('记忆抽取 prompt 带对话内容与条数上限', () => {
    const prompt = buildMemoryExtractionPrompt('用户：我喜欢简洁回答');
    expect(prompt).toContain('用户：我喜欢简洁回答');
    expect(prompt).toContain('最多 5 条');
  });
});
