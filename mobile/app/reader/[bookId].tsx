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
import { loadBookText } from '../../src/services/bookContent';
import { splitChapters, type Chapter } from '../../src/core/rag/chapters';
import type { Locator } from '../../src/core/types';
import { clampLocator, normalizeLocator } from '../../src/reader/locator';
import {
  buildReaderHtml,
  type ReaderTheme,
} from '../../src/reader/readerHtml';
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

export default function ReaderScreen() {
  const params = useLocalSearchParams<{
    bookId: string;
    start?: string;
    end?: string;
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

  const [book, setBook] = useState<BookRecord | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const prefsRef = useRef<ReaderPrefs>(readerPrefs);
  prefsRef.current = readerPrefs;

  const chrome = chromeFor(readerPrefs.theme);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = getDatabase();
        const found = await getBook(db, { userId: 'local', bookId });
        if (!found) throw new Error('书籍不存在或已被删除');
        const content = await loadBookText(found);
        const marks = await listHighlights(db, bookId);
        if (cancelled) return;

        const chapterList = splitChapters(content);
        const start = numberParam(params.start);
        const endParam = numberParam(params.end);
        let initialLocator: Locator | null = null;
        if (start != null) {
          initialLocator = clampLocator(
            {
              kind: 'txt',
              href: null,
              start,
              end: Math.max(start, endParam ?? start),
            },
            content.length,
          );
        } else if (found.lastLocator) {
          initialLocator = clampLocator(found.lastLocator, content.length);
        }

        const initialProgress =
          start != null && initialLocator
            ? progressFromLocator(initialLocator, content.length)
            : clampProgress(found.readProgress);

        const initialMarks = marks.map((mark) => ({
          id: mark.id,
          start: mark.loc.start,
          end: mark.loc.end,
          color: mark.color,
        }));

        setBook(found);
        setChapters(chapterList);
        setProgress(initialProgress);
        textLengthRef.current = content.length;
        highlightsRef.current = marks;
        if (initialLocator) {
          latestRef.current = {
            progress: initialProgress,
            locator: initialLocator,
          };
        }

        setHtml(
          buildReaderHtml({
            title: found.title,
            text: content,
            theme: readerPrefs.theme,
            fontSize: readerPrefs.fontSize,
            lineHeight: readerPrefs.lineHeight,
            initialLocator,
            initialProgress,
            highlights: initialMarks,
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
      inject(
        `window.__reader && (window.__reader.setStyle(${payload})${jump})`,
      );
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
        const record = await addHighlight(db, {
          bookId,
          loc: normalizeLocator({
            kind: 'txt',
            href: null,
            start: selection.start,
            end: selection.end,
          }),
          selectedText: selection.text,
          color,
        });
        const next = [...highlightsRef.current, record];
        highlightsRef.current = next;
        injectHighlights(next);
        showToast(`已划线（${COLOR_LABELS[record.color] ?? record.color}）`);
      } catch (caught) {
        Alert.alert(
          '划线失败',
          caught instanceof Error ? caught.message : String(caught),
        );
      }
    },
    [bookId, injectHighlights, showToast],
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
        injectHighlights(highlightsRef.current);
        return;
      }

      if (payload.type === 'progress') {
        const rawProgress = Number(payload.progress);
        const locatorRaw = payload.locator as Locator | undefined;
        if (!locatorRaw || typeof locatorRaw.start !== 'number') return;
        const locator = clampLocator(locatorRaw, textLengthRef.current);
        scheduleSave({
          progress: clampProgress(rawProgress),
          locator,
        });
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
    [applyStyle, bookId, handleAsk, handleHighlight, injectHighlights, scheduleSave],
  );

  function jumpTo(start: number, end: number): void {
    const locator = clampLocator(
      { kind: 'txt', href: null, start, end },
      textLengthRef.current,
    );
    latestRef.current = {
      progress: progressFromLocator(locator, textLengthRef.current),
      locator,
    };
    inject(`window.__reader && window.__reader.goTo(${JSON.stringify(locator)})`);
  }

  function handleBack(): void {
    void persistLatest();
    goBackOrLibrary();
  }

  const tocRows = useMemo(
    () =>
      chapters.map((chapter) => ({
        key: `${chapter.index}-${chapter.start}`,
        title: chapter.title || '未命名章节',
        start: chapter.start,
        end: chapter.end,
        percent:
          textLengthRef.current > 0
            ? Math.round((chapter.start / textLengthRef.current) * 100)
            : 0,
      })),
    [chapters],
  );

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
              {book.title}
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
                    jumpTo(item.start, item.end);
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
                <Text style={styles.tocEmpty}>正文没有可识别的章节标题。</Text>
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
  web: { flex: 1 },
  webContainer: { flex: 1 },
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
