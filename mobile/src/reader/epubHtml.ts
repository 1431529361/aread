import type { SanitizedBlock } from '../core/epub/sanitize';
import type { Locator } from '../core/types';
import {
  buildReaderShell,
  type ReaderHighlightMark,
  type ReaderTheme,
} from './readerShell';

export interface EpubChapterHtmlOptions {
  /** 书名，用于窗口标题 */
  bookTitle: string;
  chapterTitle: string;
  /** spine 文档路径，locator 的 href */
  href: string;
  blocks: readonly SanitizedBlock[];
  theme?: ReaderTheme;
  fontSize?: number;
  lineHeight?: number;
  initialLocator?: Locator | null;
  initialProgress?: number;
  highlights?: readonly ReaderHighlightMark[];
}

function blockClass(block: SanitizedBlock): string {
  if (!block.text) return 'blk-media';
  switch (block.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `blk-${block.tag}`;
    case 'blockquote':
      return 'blk-blockquote';
    case 'pre':
      return 'blk-pre';
    case 'li':
      return 'blk-li';
    case 'figcaption':
      return 'blk-figcaption';
    default:
      return '';
  }
}

/**
 * EPUB 单章阅读 HTML。块级 HTML 由 sanitizeDocument 生成，
 * data-s / data-e 是该块在「本章纯文本」中的 offset，与索引块共享同一坐标系。
 */
export function buildEpubChapterHtml(options: EpubChapterHtmlOptions): string {
  const body = options.blocks
    .map((block) => {
      const cls = blockClass(block);
      const classAttr = cls ? ` class="${cls}"` : '';
      return `<p${classAttr} data-s="${block.start}" data-e="${block.end}">${block.html}</p>`;
    })
    .join('\n');

  return buildReaderShell({
    kind: 'epub',
    href: options.href,
    title: `${options.bookTitle} · ${options.chapterTitle}`,
    bodyHtml: body,
    hasText: options.blocks.some((block) => block.text.length > 0),
    emptyMessage: '这一章没有可显示的正文。',
    theme: options.theme,
    fontSize: options.fontSize,
    lineHeight: options.lineHeight,
    initialLocator: options.initialLocator ?? null,
    initialProgress: options.initialProgress ?? 0,
    highlights: options.highlights ?? [],
  });
}