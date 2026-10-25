import { splitParagraphs } from '../core/rag/chunk';
import { escapeHtml } from '../core/text/entities';
import type { Locator } from '../core/types';
import {
  buildReaderShell,
  type ReaderHighlightMark,
  type ReaderTheme,
} from './readerShell';

export type { ReaderHighlightMark, ReaderTheme };

export interface ReaderHtmlOptions {
  title: string;
  text: string;
  theme?: ReaderTheme;
  fontSize?: number;
  lineHeight?: number;
  initialLocator?: Locator | null;
  initialProgress?: number;
  highlights?: readonly ReaderHighlightMark[];
}

/** TXT 阅读 HTML：整本书一次渲染，段落带归一化字符 offset。 */
export function buildReaderHtml(options: ReaderHtmlOptions): string {
  const paragraphs = splitParagraphs(options.text);
  const body = paragraphs
    .map(
      (paragraph) =>
        `<p data-s="${paragraph.start}" data-e="${paragraph.end}">${escapeHtml(paragraph.text)}</p>`,
    )
    .join('\n');

  return buildReaderShell({
    kind: 'txt',
    href: null,
    title: options.title,
    bodyHtml: body,
    hasText: paragraphs.length > 0,
    emptyMessage: '这本书还没有可显示的正文。',
    theme: options.theme,
    fontSize: options.fontSize,
    lineHeight: options.lineHeight,
    initialLocator: options.initialLocator ?? null,
    initialProgress: options.initialProgress ?? 0,
    highlights: options.highlights ?? [],
  });
}