import { chunkText, type ChunkResult, type ChunkTextOptions } from './chunk';

export interface EpubDocument {
  /** spine 文档路径，例如 text/chapter1.xhtml */
  href: string;
  /** 该文档解码后的纯文本 */
  text: string;
}

/**
 * EPUB 按 spine 文档逐篇分块，禁止跨文档合并；offset 相对各文档文本。
 * chunkIndex 在整个 EPUB 内连续递增。
 */
export function chunkEpubDocuments(
  documents: readonly EpubDocument[],
  options: Omit<ChunkTextOptions, 'locKind' | 'href'> = {},
): ChunkResult[] {
  const chunks: ChunkResult[] = [];

  for (const document of documents) {
    if (!document.href.trim()) continue;
    const documentChunks = chunkText(document.text, {
      ...options,
      locKind: 'epub',
      href: document.href,
    });
    for (const chunk of documentChunks) {
      chunks.push({ ...chunk, index: chunks.length });
    }
  }

  return chunks;
}
