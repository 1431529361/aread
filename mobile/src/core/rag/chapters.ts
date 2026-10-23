import { CHAPTER_RE, normalizeText, splitParagraphs } from './chunk';

export interface Chapter {
  index: number;
  title: string;
  text: string;
  start: number;
  end: number;
}

/** 按章节标题切分全文，offset 相对归一化后的全文。 */
export function splitChapters(content: string): Chapter[] {
  const text = normalizeText(content);
  const paragraphs = splitParagraphs(text);

  if (paragraphs.length === 0) {
    return [{ index: 0, title: '全文', text: '', start: 0, end: 0 }];
  }

  const chapters: Chapter[] = [];
  let current: { title: string; start: number; end: number } | null = null;

  const pushCurrent = (): void => {
    if (!current) return;
    let start = current.start;
    let end = current.end;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end > start) {
      chapters.push({
        index: chapters.length,
        title: current.title,
        text: text.slice(start, end),
        start,
        end,
      });
    }
    current = null;
  };

  for (const paragraph of paragraphs) {
    if (CHAPTER_RE.test(paragraph.text)) {
      pushCurrent();
      current = {
        title: paragraph.text.substring(0, 60),
        start: paragraph.start,
        end: paragraph.end,
      };
    } else if (current) {
      current.end = paragraph.end;
    } else {
      current = { title: '前言', start: paragraph.start, end: paragraph.end };
    }
  }
  pushCurrent();

  return chapters;
}

export function findChapter(
  chapters: readonly Chapter[],
  options: { chapterIndex?: number | null; chapterTitle?: string | null },
): Chapter | null {
  if (options.chapterIndex != null) {
    return chapters[options.chapterIndex - 1] ?? null;
  }
  const title = options.chapterTitle?.trim();
  if (!title) return null;
  return (
    chapters.find((chapter) => chapter.title.includes(title)) ??
    chapters.find((chapter) => chapter.text.includes(title)) ??
    null
  );
}
