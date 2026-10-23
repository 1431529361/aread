import { describe, expect, it } from 'vitest';
import {
  buildSnippet,
  clampProgress,
  locatorFromProgress,
  progressFromLocator,
} from '../src/reader/progress';
import { buildReaderHtml } from '../src/reader/readerHtml';

describe('阅读进度', () => {
  it('clampProgress 处理越界与非数值', () => {
    expect(clampProgress(-0.5)).toBe(0);
    expect(clampProgress(0.42)).toBe(0.42);
    expect(clampProgress(3)).toBe(1);
    expect(clampProgress(Number.NaN)).toBe(0);
  });

  it('progressFromLocator 按起点换算并防空文本', () => {
    expect(progressFromLocator({ kind: 'txt', href: null, start: 50, end: 60 }, 200)).toBe(
      0.25,
    );
    expect(progressFromLocator({ kind: 'txt', href: null, start: 10, end: 20 }, 0)).toBe(0);
    expect(progressFromLocator({ kind: 'txt', href: null, start: -10, end: 0 }, 100)).toBe(0);
  });

  it('locatorFromProgress 换算为全文字符 offset', () => {
    expect(locatorFromProgress(0.5, 101)).toEqual({
      kind: 'txt',
      href: null,
      start: 51,
      end: 51,
    });
    expect(locatorFromProgress(2, 10)).toEqual({
      kind: 'txt',
      href: null,
      start: 10,
      end: 10,
    });
    expect(locatorFromProgress(0.5, 0)).toEqual({
      kind: 'txt',
      href: null,
      start: 0,
      end: 0,
    });
  });
});

describe('buildSnippet', () => {
  it('短文直接返回去空白后的内容', () => {
    expect(buildSnippet('  一句话  ', '一句话')).toEqual({
      text: '一句话',
      prefix: '',
      suffix: '',
    });
  });

  it('长文保留命中词附近并加省略号', () => {
    const body = `${'甲'.repeat(200)}关键词${'乙'.repeat(200)}`;
    const snippet = buildSnippet(body, '关键词', { maxChars: 60 });
    expect(snippet.text).toContain('关键词');
    expect(snippet.text.length).toBeLessThanOrEqual(60);
    expect(snippet.prefix).toBe('…');
    expect(snippet.suffix).toBe('…');
  });

  it('从换行处开始截取，避免半句话', () => {
    const body = `${'前'.repeat(50)}\n${'长'.repeat(50)}\n命中词${'尾'.repeat(100)}`;
    const snippet = buildSnippet(body, '命中词', { maxChars: 40 });
    expect(snippet.text.startsWith('命中词')).toBe(true);
    expect(snippet.text).not.toContain('\n');
    expect(snippet.prefix).toBe('…');
  });

  it('查询词未命中时从头截取', () => {
    const snippet = buildSnippet('abcdefghijklmnopqrstuvwxyz', '找不到', { maxChars: 20 });
    expect(snippet.text.length).toBeLessThanOrEqual(20);
    expect(snippet.prefix).toBe('');
  });
});

describe('buildReaderHtml', () => {
  const text = '第一段\n\n第二段';

  it('段落带归一化字符 offset', () => {
    const html = buildReaderHtml({ title: '测试书', text });
    expect(html).toContain('<p data-s="0" data-e="3">第一段</p>');
    expect(html).toContain('<p data-s="5" data-e="8">第二段</p>');
  });

  it('正文与标题都经过 HTML 转义', () => {
    const html = buildReaderHtml({
      title: 'A&B <C>',
      text: '<script>alert("x")</script>',
    });
    expect(html).toContain('<title>A&amp;B &lt;C&gt;</title>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it('初始 locator、进度与主题写入 INITIAL', () => {
    const html = buildReaderHtml({
      title: '书',
      text,
      theme: 'dark',
      initialLocator: { kind: 'txt', href: null, start: 5, end: 8 },
      initialProgress: 3,
    });
    expect(html).toContain('<body class="theme-dark">');
    expect(html).toContain('"locator":{"kind":"txt","href":null,"start":5,"end":8}');
    expect(html).toContain('"progress":1');
  });

  it('空正文给出提示且不生成段落', () => {
    const html = buildReaderHtml({ title: '空书', text: '   \n\n  ' });
    expect(html).not.toContain('<p data-s=');
    expect(html).toContain('这本书还没有可显示的正文');
    expect(html).toContain('"hasText":false');
  });

  it('字号与行高被限制在可读范围', () => {
    const html = buildReaderHtml({ title: '书', text, fontSize: 100, lineHeight: 0 });
    expect(html).toContain('--fs: 32px');
    expect(html).toContain('--lh: 1.3');
  });

  it('高亮区间写入 INITIAL 且不破坏脚本', () => {
    const html = buildReaderHtml({
      title: '书',
      text,
      highlights: [{ id: 7, start: 0, end: 3, color: 'yellow' }],
    });
    expect(html).toContain('"highlights":[{"id":7,"start":0,"end":3,"color":"yellow"}]');
  });
});
