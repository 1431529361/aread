import { describe, expect, it } from 'vitest';
import { findChapter, splitChapters } from '../src/core/rag/chapters';

describe('splitChapters', () => {
  it('按章节标题切分并保留 offset', () => {
    const content = '第一章 开端\n正文一。\n第二章 发展\n正文二。';
    const chapters = splitChapters(content);

    expect(chapters.map((chapter) => chapter.title)).toEqual(['第一章 开端', '第二章 发展']);
    expect(chapters[0].text).toContain('正文一');
    expect(chapters[1].text).toContain('正文二');
    for (const chapter of chapters) {
      expect(content.slice(chapter.start, chapter.end)).toBe(chapter.text);
    }
  });

  it('无章节标题时整段作为前言', () => {
    const chapters = splitChapters('第一段。\n\n第二段。');
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('前言');
    expect(chapters[0].text).toBe('第一段。\n\n第二段。');
  });

  it('空内容返回全文占位', () => {
    expect(splitChapters('  ')).toEqual([
      { index: 0, title: '全文', text: '', start: 0, end: 0 },
    ]);
  });
});

describe('findChapter', () => {
  const chapters = splitChapters('第一章 A\n内容。\n第二章 B\n内容。');

  it('按序号查找（从 1 开始）', () => {
    expect(findChapter(chapters, { chapterIndex: 2 })?.title).toBe('第二章 B');
  });

  it('按标题关键词查找', () => {
    expect(findChapter(chapters, { chapterTitle: '第一章' })?.title).toBe('第一章 A');
  });

  it('找不到返回 null', () => {
    expect(findChapter(chapters, { chapterIndex: 9 })).toBeNull();
    expect(findChapter(chapters, { chapterTitle: '不存在' })).toBeNull();
    expect(findChapter(chapters, {})).toBeNull();
  });
});
