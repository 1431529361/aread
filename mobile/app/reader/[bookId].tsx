import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { BookRecord } from '../../src/db/repositories/books';
import { getBook, saveReadingProgress } from '../../src/db/repositories/books';
import {
  addHighlight,
  listHighlights,
  type HighlightRecord,
} from '../../src/db/repositories/highlights';
import { getOrCreateBookConversation } from '../../src/db/repositories/conversations';
import { getDatabase } from '../../src/db/client';
import { loadBookContent } from '../../src/services/bookContent';
import {
  epubChapterTitle,
  loadEpubChapter,
  type LoadedEpub,
} from '../../src/services/epubContent';
import { splitChapters, type Chapter } from '../../src/core/rag/chapters';
import type { Locator } from '../../src/core/types';
import { clampLocator, normalizeLocator } from '../../src/reader/locator';
import { buildReaderHtml, type ReaderTheme } from '../../src/reader/readerHtml';
import { buildEpubChapterHtml } from '../../src/reader/epubHtml';
import { clampProgress, progressFromLocator } from '../../src/reader/progress';
import { useAppStore, type ReaderPrefs } from '../../src/stores/appStore';
import { Button, ProgressBar } from '../../src/components/ui';
import {
  goBackOrLibrary,
  openChat,
  openSearch,
} from '../../src/navigation/routes';
import { firstParam, numberParam } from '../../src/utils/params';
import { colors, radius, spacing, type } from '../../src/theme';

const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'];
const COLOR_LABELS: Record<string, string> = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  pink: '粉色',
};

const FONT_MIN = 14;
const FONT_MAX = 30;
const LINE_MIN = 1.4;
const LINE_MAX = 2.2;

interface ReaderChrome {
  bg: string;
  text: string;
  muted: string;
  border: string;
}

function chromeFor(theme: ReaderTheme): ReaderChrome {
  if (theme === 'dark') {
    return {
      bg: '#191817',
      text: '#ddd8d0',
      muted: '#8f8880',
      border: 'rgba(255,255,255,0.12)',
    };
  }
  if (theme === 'sepia') {
    return {
      bg: '#f3ead8',
      text: '#3a3127',
      muted: '#8d7d66',
      border: 'rgba(58,49,39,0.12)',
    };
  }
  return {
    bg: '#faf7f2',
    text: '#2b2926',
    muted: '#8a837a',
    border: 'rgba(43,41,38,0.1)',
  };
}

interface SelectionAction {
  text: string;
  start: number;
  end: number;
}

interface TocRow {
  key: string;
  title: string;
  /** EPUB 用 href 定位章节；TXT 用 start/end */
  href: string | null;
  start: number;
  end: number;
  percent: number;
}

export default function ReaderScreen() {
  const params = useLocalSearchParams<{
    bookId: string;
    start?: string;
    end?: string;
    href?: string;
  }>();
  const bookId = firstParam(params.bookId);
  const insets = useSafeAreaInsets();

  const readerPrefs = useAppStore((state) => state.readerPrefs);
  const updateReaderPrefs = useAppStore((state) => state.updateReaderPrefs);

  const webRef = useRef<React.ComponentRef<typeof WebView>>(null);
  const textLengthRef = useRef(0);
  const highlightsRef = useRef<HighlightRecord[]>([]);
  const latestRef = useRef<{ progress: number; locator: Locator } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spineLengthRef = useRef(0);
  const chapterIndexRef = useRef(0);

  const [book, setBook] = useState<BookRecord | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [epub, setEpub] = useState<LoadedEpub | null>(null);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const prefsRef = useRef<ReaderPrefs>(readerPrefs);

  useEffect(() => {
    prefsRef.current = readerPrefs;
  }, [readerPrefs]);

  const chrome = chromeFor(readerPrefs.theme);
  const isEpub = epub != null;

  useEffect(() => {
    chapterIndexRef.current = chapterIndex;
  }, [chapterIndex]);

  const inject = useCallback((code: string) => {
    webRef.current?.injectJavaScript(`${code};
true;`);
  }, []);

  const persistLatest = useCallback(async () => {
    const value = latestRef.current;
    if (!value) return;
    try {
      const db = getDatabase();
      await saveReadingProgress(db, {
        userId: 'local',
        bookId,
        progress: value.progress,
        locator: value.locator,
      });
    } catch {
      // 进度保存失败不打断阅读
    }
  }, [bookId]);

  const scheduleSave = useCallback(
    (value: { progress: number; locator: Locator }) => {
      latestRef.current = value;
      setProgress(value.progress);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void persistLatest();
      }, 1200);
    },
    [persistLatest],
  );

  const chapterHighlights = useCallback((href: string | null): HighlightRecord[] => {
    if (href == null) return highlightsRef.current;
    return highlightsRef.current.filter((mark) => mark.loc.href === href);
  }, []);

  /** 载入指定 EPUB 章节并渲染；start 用于跳转到章内位置。 */
  const openChapter = useCallback(
    async (loaded: LoadedEpub, index: number, start: number | null = null) => {
      const href = loaded.spine[index];
      if (!href) return;
      setChapterLoading(true);
      try {
        const chapter = await loadEpubChapter(loaded, href);
        const length = chapter.text.length;
        const intra =
          start != null && start > 0
            ? clampLocator({ kind: 'epub', href, start, end: start }, length)
            : null;

        textLengthRef.current = length;
        chapterIndexRef.current = index;
        setChapterIndex(index);

        if (intra) {
          latestRef.current = {
            progress: (index + progressFromLocator(intra, length)) / Math.max(1, loaded.spine.length),
            locator: intra,
          };
        } else {
          latestRef.current = {
            progress: index / Math.max(1, loaded.spine.length),
            locator: { kind: 'epub', href, start: 0, end: 0 },
          };
        }

        setHtml(
          buildEpubChapterHtml({
            bookTitle: loaded.title || book?.title || '未命名书籍',
            chapterTitle: epubChapterTitle(loaded, href, index),
            href,
            blocks: chapter.blocks,
            theme: prefsRef.current.theme,
            fontSize: prefsRef.current.fontSize,
            lineHeight: prefsRef.current.lineHeight,
            initialLocator: intra,
            initialProgress: intra
              ? progressFromLocator(intra, length)
              : clampProgress(0),
            highlights: chapterHighlights(href).map((mark) => ({
              id: mark.id,
              start: mark.loc.start,
              end: mark.loc.end,
              color: mark.color,
            })),
          }),
        );
        if (latestRef.current) setProgress(latestRef.current.progress);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setChapterLoading(false);
      }
    },
    [book, chapterHighlights],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = getDatabase();
        const found = await getBook(db, { userId: 'local', bookId });
        if (!found) throw new Error('书籍不存在或已被删除');
        const content = await loadBookContent(found);
        const marks = await listHighlights(db, bookId);
        if (cancelled) return;

        setBook(found);
        highlightsRef.current = marks;

        const start = numberParam(params.start);
        const endParam = numberParam(params.end);
        const hrefParam = firstParam(params.href) || null;

        if (content.format === 'epub' && content.epub) {
          const loaded = content.epub;
          spineLengthRef.current = loaded.spine.length;
          setEpub(loaded);

          const resumeHref = hrefParam ?? found.lastLocator?.href ?? null;
          let index =
            resumeHref && loaded.spine.includes(resumeHref)
              ? loaded.spine.indexOf(resumeHref)
              : 0;
          if (!resumeHref && found.readProgress > 0) {
            index = Math.min(
              loaded.spine.length - 1,
              Math.floor(found.readProgress * loaded.spine.length),
            );
          }

          let chapterStart: number | null = null;
          if (start != null && (hrefParam == null || hrefParam === loaded.spine[index])) {
            chapterStart = start;
          } else if (found.lastLocator && found.lastLocator.href === loaded.spine[index]) {
            chapterStart = found.lastLocator.start;
          }

          setChapterIndex(index);
          chapterIndexRef.current = index;
          await openChapter(loaded, index, chapterStart);
          return;
        }

        const text = content.text ?? '';
        const chapterList = splitChapters(text);
        let initialLocator: Locator | null = null;
        if (start != null) {
          initialLocator = clampLocator(
            { kind: 'txt', href: null, start, end: Math.max(start, endParam ?? start) },
            text.length,
          );
        } else if (found.lastLocator) {
          initialLocator = clampLocator(found.lastLocator, text.length);
        }

        const initialProgress =
          start != null && initialLocator
            ? progressFromLocator(initialLocator, text.length)
            : clampProgress(found.readProgress);

        setChapters(chapterList);
        setProgress(initialProgress);
        textLengthRef.current = text.length;
        if (initialLocator) {
          latestRef.current = { progress: initialProgress, locator: initialLocator };
        }

        setHtml(
          buildReaderHtml({
            title: found.title,
            text,
            theme: prefsRef.current.theme,
            fontSize: prefsRef.current.fontSize,
            lineHeight: prefsRef.current.lineHeight,
            initialLocator,
            initialProgress,
            highlights: marks.map((mark) => ({
              id: mark.id,
              start: mark.loc.start,
              end: mark.loc.end,
              color: mark.color,
            })),
          }),
        );
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在书变化时重建 HTML；字号/主题通过 WebView 注入更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void persistLatest();
    });
    return () => {
      subscription.remove();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      void persistLatest();
    };
  }, [persistLatest]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 1800);
  }, []);

  const injectHighlights = useCallback(
    (marks: readonly HighlightRecord[]) => {
      const payload = marks.map((mark) => ({
        id: mark.id,
        start: mark.loc.start,
        end: mark.loc.end,
        color: mark.color,
      }));
      inject(`window.__reader && window.__reader.setHighlights(${JSON.stringify(payload)})`);
    },
    [inject],
  );

  const currentHighlights = useCallback((): HighlightRecord[] => {
    if (!isEpub) return highlightsRef.current;
    const href = epub?.spine[chapterIndexRef.current] ?? null;
    return chapterHighlights(href);
  }, [chapterHighlights, epub, isEpub]);

  const applyStyle = useCallback(
    (prefs: ReaderPrefs, locator: Locator | null, withJump: boolean) => {
      const payload = JSON.stringify({
        theme: prefs.theme,
        fontSize: prefs.fontSize,
        lineHeight: prefs.lineHeight,
      });
      const jump =
        withJump && locator
          ? `;window.__reader.goTo(${JSON.stringify(locator)})`
          : '';
      inject(`window.__reader && (window.__reader.setStyle(${payload})${jump})`);
    },
    [inject],
  );

  function updatePrefs(patch: Partial<ReaderPrefs>, withJump: boolean): void {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    updateReaderPrefs(patch);
    applyStyle(next, latestRef.current?.locator ?? null, withJump);
  }

  const handleAsk = useCallback(
    async (selection: SelectionAction) => {
      try {
        const db = getDatabase();
        const conversation = await getOrCreateBookConversation(db, {
          userId: 'local',
          bookId,
        });
        openChat(conversation.id, bookId, selection.text);
      } catch (caught) {
        Alert.alert(
          '无法开始对话',
          caught instanceof Error ? caught.message : String(caught),
        );
      }
    },
    [bookId],
  );

  const handleHighlight = useCallback(
    async (selection: SelectionAction) => {
      try {
        const db = getDatabase();
        const color =
          HIGHLIGHT_COLORS[highlightsRef.current.length % HIGHLIGHT_COLORS.length];
        const href = isEpub ? epub?.spine[chapterIndexRef.current] ?? null : null;
        const record = await addHighlight(db, {
          bookId,
          loc: normalizeLocator(
            href
              ? { kind: 'epub', href, start: selection.start, end: selection.end }
              : { kind: 'txt', href: null, start: selection.start, end: selection.end },
          ),
          selectedText: selection.text,
          color,
        });
        const next = [...highlightsRef.current, record];
        highlightsRef.current = next;
        injectHighlights(href ? next.filter((mark) => mark.loc.href === href) : next);
        showToast(`已划线（${COLOR_LABELS[record.color] ?? record.color}）`);
      } catch (caught) {
        Alert.alert(
          '划线失败',
          caught instanceof Error ? caught.message : String(caught),
        );
      }
    },
    [bookId, epub, injectHighlights, isEpub, showToast],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
      } catch {
        return;
      }

      if (payload.type === 'ready') {
        applyStyle(prefsRef.current, latestRef.current?.locator ?? null, false);
        injectHighlights(currentHighlights());
        return;
      }

      if (payload.type === 'progress') {
        const rawProgress = Number(payload.progress);
        const locatorRaw = payload.locator as Locator | undefined;
        if (!locatorRaw || typeof locatorRaw.start !== 'number') return;
        const locator = clampLocator(locatorRaw, textLengthRef.current);
        const spine = spineLengthRef.current;
        const overall =
          isEpub && spine > 0
            ? clampProgress(
                (chapterIndexRef.current + clampProgress(rawProgress)) / spine,
              )
            : clampProgress(rawProgress);
        scheduleSave({ progress: overall, locator });
        return;
      }

      if (payload.type === 'action') {
        const action = String(payload.action ?? '');
        const textValue = String(payload.text ?? '');
        const start = Number(payload.start);
        const end = Number(payload.end);
        if (!textValue.trim() || !Number.isFinite(start) || !Number.isFinite(end)) {
          return;
        }
        const selection = { text: textValue, start, end };
        if (action === 'ask') {
          void handleAsk(selection);
        } else if (action === 'highlight') {
          void handleHighlight(selection);
        } else if (action === 'search') {
          openSearch(bookId, textValue.slice(0, 40));
        }
      }
    },
    [
      applyStyle,
      bookId,
      currentHighlights,
      handleAsk,
      handleHighlight,
      injectHighlights,
      isEpub,
      scheduleSave,
    ],
  );

  /** 章内跳转（TXT 全局 offset；EPUB 章内 offset）。 */
  function jumpTo(start: number, end: number, href: string | null): void {
    if (isEpub && epub && href) {
      const currentHref = epub.spine[chapterIndexRef.current] ?? null;
      if (href !== currentHref) {
        const index = epub.spine.indexOf(href);
        if (index >= 0) void openChapter(epub, index, start);
        return;
      }
    }
    const locator = clampLocator(
      href
        ? { kind: 'epub', href, start, end }
        : { kind: 'txt', href: null, start, end },
      textLengthRef.current,
    );
    latestRef.current = {
      progress: isEpub
        ? (chapterIndexRef.current + progressFromLocator(locator, textLengthRef.current)) /
          Math.max(1, spineLengthRef.current)
        : progressFromLocator(locator, textLengthRef.current),
      locator,
    };
    inject(`window.__reader && window.__reader.goTo(${JSON.stringify(locator)})`);
  }

  function goToChapter(index: number): void {
    if (!epub) return;
    if (index < 0 || index >= epub.spine.length) return;
    void openChapter(epub, index, null);
  }

  function handleBack(): void {
    void persistLatest();
    goBackOrLibrary();
  }

  const tocRows = useMemo<TocRow[]>(() => {
    if (isEpub && epub) {
      const total = Math.max(1, epub.spine.length);
      return epub.toc.map((entry, index) => {
        const spineIndex = epub.spine.indexOf(entry.href);
        return {
          key: `${index}-${entry.href}-${entry.fragment}`,
          title: entry.title || '未命名章节',
          href: entry.href,
          start: 0,
          end: 0,
          percent: spineIndex < 0 ? 0 : Math.round((spineIndex / total) * 100),
        };
      });
    }
    const textLength = chapters.length > 0 ? chapters[chapters.length - 1].end : 0;
    return chapters.map((chapter) => ({
      key: `${chapter.index}-${chapter.start}`,
      title: chapter.title || '未命名章节',
      href: null,
      start: chapter.start,
      end: chapter.end,
      percent:
        textLength > 0
          ? Math.round((chapter.start / textLength) * 100)
          : 0,
    }));
  }, [chapters, epub, isEpub]);

  const currentHref = isEpub && epub ? epub.spine[chapterIndex] ?? null : null;
  const currentTitle = useMemo(() => {
    if (!isEpub || !epub || !currentHref) return null;
    return epubChapterTitle(epub, currentHref, chapterIndex);
  }, [chapterIndex, currentHref, epub, isEpub]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.loadingText}>正在打开正文…</Text>
      </View>
    );
  }

  if (error || !book || !html) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg, padding: spacing.xl }]}>
        <Text style={styles.errorTitle}>无法打开这本书</Text>
        <Text style={styles.loadingText}>{error ?? '正文为空'}</Text>
        <Button title="返回" onPress={goBackOrLibrary} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: chrome.bg }]}>
      <StatusBar style={readerPrefs.theme === 'dark' ? 'light' : 'dark'} />
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 4,
            backgroundColor: chrome.bg,
            borderBottomColor: chrome.border,
          },
        ]}
      >
        <View style={styles.headerRow}>
          <Pressable
            accessibilityRole="button"
            onPress={handleBack}
            hitSlop={10}
            style={styles.iconButton}
          >
            <Text style={[styles.backIcon, { color: chrome.text }]}>‹</Text>
          </Pressable>
          <View style={styles.headerTitleWrap}>
            <Text
              numberOfLines={1}
              style={[styles.headerTitle, { color: chrome.text }]}
            >
              {currentTitle ? `${book.title} · ${currentTitle}` : book.title}
            </Text>
            <Text style={[styles.headerPercent, { color: chrome.muted }]}>
              {Math.round(progress * 100)}%
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setTocOpen(true)}
            hitSlop={8}
            style={styles.headerAction}
          >
            <Text style={[styles.headerActionText, { color: chrome.text }]}>目录</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => openSearch(bookId)}
            hitSlop={8}
            style={styles.headerAction}
          >
            <Text style={[styles.headerActionText, { color: chrome.text }]}>搜索</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setStyleOpen(true)}
            hitSlop={8}
            style={styles.headerAction}
          >
            <Text style={[styles.styleIcon, { color: chrome.text }]}>Aa</Text>
          </Pressable>
        </View>
        <ProgressBar value={progress} />
        {isEpub && epub ? (
          <View style={styles.chapterBar}>
            <Pressable
              accessibilityRole="button"
              disabled={chapterIndex <= 0}
              onPress={() => goToChapter(chapterIndex - 1)}
              hitSlop={6}
              style={[styles.chapterNav, chapterIndex <= 0 && styles.chapterNavDisabled]}
            >
              <Text style={[styles.chapterNavText, { color: chrome.text }]}>‹ 上一章</Text>
            </Pressable>
            <Text
              numberOfLines={1}
              style={[styles.chapterLabel, { color: chrome.muted }]}
            >
              {currentTitle} · {chapterIndex + 1}/{epub.spine.length}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={chapterIndex >= epub.spine.length - 1}
              onPress={() => goToChapter(chapterIndex + 1)}
              hitSlop={6}
              style={[
                styles.chapterNav,
                chapterIndex >= epub.spine.length - 1 && styles.chapterNavDisabled,
              ]}
            >
              <Text style={[styles.chapterNavText, { color: chrome.text }]}>下一章 ›</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <WebView
        ref={webRef}
        source={{ html }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        overScrollMode="never"
        bounces={false}
        onMessage={handleMessage}
        style={[styles.web, { backgroundColor: chrome.bg }]}
        containerStyle={styles.webContainer}
      />

      {chapterLoading ? (
        <View style={styles.chapterLoading} pointerEvents="none">
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}

      {toast ? (
        <View
          pointerEvents="none"
          style={[styles.toast, { bottom: insets.bottom + 24 }]}
        >
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      <Modal
        visible={tocOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setTocOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            style={styles.backdropFill}
            onPress={() => setTocOpen(false)}
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>目录</Text>
              <Button title="关闭" small variant="ghost" onPress={() => setTocOpen(false)} />
            </View>
            <FlatList
              data={tocRows}
              keyExtractor={(item) => item.key}
              style={styles.tocList}
              ItemSeparatorComponent={() => <View style={styles.tocSeparator} />}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    jumpTo(item.start, item.end, item.href);
                    setTocOpen(false);
                  }}
                  style={({ pressed }) => [styles.tocRow, pressed && styles.pressed]}
                >
                  <Text style={styles.tocTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={styles.tocPercent}>{item.percent}%</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={styles.tocEmpty}>
                  {isEpub ? '这本书没有提供目录。' : '正文没有可识别的章节标题。'}
                </Text>
              }
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={styleOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setStyleOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            style={styles.backdropFill}
            onPress={() => setStyleOpen(false)}
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>阅读样式</Text>
              <Button title="完成" small variant="ghost" onPress={() => setStyleOpen(false)} />
            </View>

            <Text style={styles.controlLabel}>主题</Text>
            <View style={styles.themeRow}>
              {(
                [
                  ['light', '纸白', '#faf7f2'],
                  ['sepia', '暖黄', '#f3ead8'],
                  ['dark', '夜间', '#191817'],
                ] as const
              ).map(([value, label, swatch]) => {
                const active = readerPrefs.theme === value;
                return (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    onPress={() => updatePrefs({ theme: value }, false)}
                    style={[
                      styles.themeOption,
                      active && styles.themeOptionActive,
                    ]}
                  >
                    <View style={[styles.swatch, { backgroundColor: swatch }]} />
                    <Text style={styles.themeLabel}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.controlRow}>
              <Text style={styles.controlLabel}>字号</Text>
              <View style={styles.stepper}>
                <Pressable
                  accessibilityRole="button"
                  disabled={readerPrefs.fontSize <= FONT_MIN}
                  onPress={() =>
                    updatePrefs(
                      { fontSize: Math.max(FONT_MIN, readerPrefs.fontSize - 1) },
                      true,
                    )
                  }
                  style={({ pressed }) => [
                    styles.stepButton,
                    pressed && styles.pressed,
                    readerPrefs.fontSize <= FONT_MIN && styles.stepDisabled,
                  ]}
                >
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.stepValue}>{readerPrefs.fontSize}px</Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={readerPrefs.fontSize >= FONT_MAX}
                  onPress={() =>
                    updatePrefs(
                      { fontSize: Math.min(FONT_MAX, readerPrefs.fontSize + 1) },
                      true,
                    )
                  }
                  style={({ pressed }) => [
                    styles.stepButton,
                    pressed && styles.pressed,
                    readerPrefs.fontSize >= FONT_MAX && styles.stepDisabled,
                  ]}
                >
                  <Text style={styles.stepText}>＋</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.controlRow}>
              <Text style={styles.controlLabel}>行距</Text>
              <View style={styles.stepper}>
                <Pressable
                  accessibilityRole="button"
                  disabled={readerPrefs.lineHeight <= LINE_MIN}
                  onPress={() =>
                    updatePrefs(
                      {
                        lineHeight: Math.max(
                          LINE_MIN,
                          Math.round((readerPrefs.lineHeight - 0.1) * 10) / 10,
                        ),
                      },
                      true,
                    )
                  }
                  style={({ pressed }) => [
                    styles.stepButton,
                    pressed && styles.pressed,
                    readerPrefs.lineHeight <= LINE_MIN && styles.stepDisabled,
                  ]}
                >
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.stepValue}>
                  {readerPrefs.lineHeight.toFixed(1)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={readerPrefs.lineHeight >= LINE_MAX}
                  onPress={() =>
                    updatePrefs(
                      {
                        lineHeight: Math.min(
                          LINE_MAX,
                          Math.round((readerPrefs.lineHeight + 0.1) * 10) / 10,
                        ),
                      },
                      true,
                    )
                  }
                  style={({ pressed }) => [
                    styles.stepButton,
                    pressed && styles.pressed,
                    readerPrefs.lineHeight >= LINE_MAX && styles.stepDisabled,
                  ]}
                >
                  <Text style={styles.stepText}>＋</Text>
                </Pressable>
              </View>
            </View>

            <Text style={styles.sheetHint}>
              长按正文选中文字，即可提问、划线、全书搜索或复制。
              {isEpub ? ' EPUB 按章节加载，图片已离线内置。' : ''}
            </Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingText: { ...type.small, textAlign: 'center' },
  errorTitle: { ...type.h1 },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingBottom: 6,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  iconButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: { fontSize: 30, lineHeight: 32, marginTop: -2 },
  headerTitleWrap: {
    flex: 1,
    paddingHorizontal: 4,
    gap: 1,
  },
  headerTitle: { fontSize: 14, fontWeight: '600' },
  headerPercent: { fontSize: 10 },
  headerAction: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  headerActionText: { fontSize: 13, fontWeight: '600' },
  styleIcon: { fontSize: 15, fontWeight: '700' },
  chapterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingTop: 2,
  },
  chapterNav: { paddingHorizontal: 6, paddingVertical: 4 },
  chapterNavDisabled: { opacity: 0.35 },
  chapterNavText: { fontSize: 12, fontWeight: '600' },
  chapterLabel: { ...type.tiny, flex: 1, textAlign: 'center' },
  web: { flex: 1 },
  webContainer: { flex: 1 },
  chapterLoading: {
    position: 'absolute',
    top: '50%',
    alignSelf: 'center',
  },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(24,20,16,0.86)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  toastText: { color: colors.white, fontSize: 13 },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(24,20,16,0.35)',
  },
  backdropFill: { flex: 1 },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
    maxHeight: '72%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: { ...type.h1 },
  sheetHint: { ...type.tiny },
  tocList: { flexGrow: 0 },
  tocSeparator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  tocRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 11,
  },
  tocTitle: { ...type.body, flex: 1 },
  tocPercent: { ...type.tiny },
  tocEmpty: { ...type.small, paddingVertical: spacing.xl, textAlign: 'center' },
  pressed: { opacity: 0.65 },
  controlLabel: { ...type.small, fontWeight: '600', color: colors.text },
  themeRow: { flexDirection: 'row', gap: spacing.sm },
  themeOption: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    alignItems: 'center',
    gap: 6,
  },
  themeOptionActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  themeLabel: { ...type.small, color: colors.text },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    padding: 4,
  },
  stepButton: {
    width: 38,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  stepDisabled: { opacity: 0.35 },
  stepText: { fontSize: 18, color: colors.text, fontWeight: '600' },
  stepValue: { ...type.small, minWidth: 44, textAlign: 'center', color: colors.text, fontWeight: '600' },
});