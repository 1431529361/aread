import { router, type Href } from 'expo-router';
import type { Locator } from '../core/types';

type RouteParams = Record<string, string>;

function push(pathname: string, params: RouteParams): void {
  router.push({ pathname, params } as unknown as Href);
}

export function openReader(
  bookId: string,
  locator?: Locator | null,
  options: { flash?: boolean } = {},
): void {
  const params: RouteParams = { bookId };
  if (locator) {
    params.start = String(Math.max(0, Math.floor(locator.start)));
    params.end = String(Math.max(0, Math.floor(locator.end)));
    // EPUB 的 offset 相对 spine 文档，必须带上 href 才能定位到正确的章节
    if (locator.kind === 'epub' && locator.href) params.href = locator.href;
  }
  if (options.flash) params.flash = '1';
  push('/reader/[bookId]', params);
}

export function openBookDetail(bookId: string): void {
  push('/book/[bookId]', { bookId });
}

export function openSearch(bookId: string, query?: string): void {
  const params: RouteParams = { bookId };
  if (query?.trim()) params.q = query.trim();
  push('/search/[bookId]', params);
}

export function openChat(
  conversationId: string,
  bookId: string,
  selectedText?: string | null,
): void {
  const params: RouteParams = { conversationId, bookId };
  if (selectedText?.trim()) params.selectedText = selectedText.trim();
  push('/chat/[conversationId]', params);
}

export function openSettings(): void {
  router.navigate('/(tabs)/settings' as Href);
}

export function goBackOrLibrary(): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/(tabs)/library' as Href);
}
