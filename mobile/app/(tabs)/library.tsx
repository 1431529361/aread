import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BookRecord } from '../../src/db/repositories/books';
import { listBooks } from '../../src/db/repositories/books';
import { getDatabase } from '../../src/db/client';
import { loadChatRuntime } from '../../src/services/providerRuntime';
import { importTxtBook, pickTxtFile } from '../../src/services/bookImport';
import { formatFileSize } from '../../src/core/import/txt';
import { useAppStore } from '../../src/stores/appStore';
import { BookCard } from '../../src/components/BookCard';
import {
  ImportProgressModal,
  indexStageLabel,
  type ImportProgressState,
} from '../../src/components/ImportProgressModal';
import { Button, Card, EmptyState } from '../../src/components/ui';
import { openBookDetail, openReader, openSettings } from '../../src/navigation/routes';
import { colors, radius, spacing, type } from '../../src/theme';

export default function LibraryScreen() {
  const libraryVersion = useAppStore((state) => state.libraryVersion);
  const bumpLibrary = useAppStore((state) => state.bumpLibrary);
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [chatReady, setChatReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgressState>({
    title: '导入 TXT',
    label: '准备导入…',
    percent: 0,
  });

  const load = useCallback(async () => {
    try {
      const db = getDatabase();
      const [list, chat] = await Promise.all([
        listBooks(db, 'local'),
        loadChatRuntime(db),
      ]);
      setBooks(list);
      setChatReady(chat != null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load, libraryVersion]),
  );

  async function handleImport(): Promise<void> {
    const asset = await pickTxtFile();
    if (!asset) return;
    setImporting(true);
    setProgress({ title: '导入 TXT', label: '准备导入…', percent: 0 });
    try {
      const db = getDatabase();
      const result = await importTxtBook({
        db,
        asset,
        onProgress: (value) =>
          setProgress({
            title: `导入《${asset.name}》`,
            label: indexStageLabel(value),
            percent: value.percent,
          }),
      });
      bumpLibrary();
      await load();
      if (result.status === 'duplicate') {
        Alert.alert('这本书已在书架', '同一内容不会重复导入。', [
          { text: '留在书架' },
          { text: '继续阅读', onPress: () => openReader(result.book.id) },
        ]);
      } else {
        Alert.alert(
          '导入完成',
          `《${result.book.title}》\n编码：${result.encoding.toUpperCase()} · ${result.book.sizeFormatted}`,
          [
            { text: '留在书架' },
            { text: '开始阅读', onPress: () => openReader(result.book.id) },
          ],
        );
      }
    } catch (caught) {
      Alert.alert('导入失败', caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImporting(false);
    }
  }

  const totalBytes = books.reduce((sum, book) => sum + book.size, 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>书架</Text>
          <Text style={styles.subtitle}>
            {books.length > 0
              ? `${books.length} 本 · ${formatFileSize(totalBytes)}`
              : '所有内容只保存在本机'}
          </Text>
        </View>
        <Button title="＋ 导入 TXT" small onPress={handleImport} loading={importing} />
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={books}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
              tintColor={colors.primary}
            />
          }
          ListHeaderComponent={
            <>
              {!chatReady ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={openSettings}
                  style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
                >
                  <Text style={styles.bannerText}>
                    尚未配置对话模型，划词提问暂不可用
                  </Text>
                  <Text style={styles.bannerLink}>去设置 ›</Text>
                </Pressable>
              ) : null}
              {error ? (
                <Card style={styles.errorCard}>
                  <Text style={styles.errorTitle}>书架加载失败</Text>
                  <Text style={styles.errorBody}>{error}</Text>
                  <Button title="重试" small variant="secondary" onPress={() => void load()} />
                </Card>
              ) : null}
            </>
          }
          ListEmptyComponent={
            error ? undefined : (
              <EmptyState
                title="书架还是空的"
                body="导入一本 TXT 就能离线阅读；划词提问、关键词搜索与引用跳转都不需要联网。"
                action={<Button title="导入第一本书" onPress={handleImport} />}
              />
            )
          }
          renderItem={({ item }) => (
            <BookCard
              book={item}
              onOpen={() => openReader(item.id)}
              onDetail={() => openBookDetail(item.id)}
            />
          )}
        />
      )}

      <ImportProgressModal visible={importing} state={progress} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  headerText: { flex: 1, gap: 2 },
  title: { ...type.title },
  subtitle: { ...type.tiny },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    flexGrow: 1,
    gap: spacing.md,
  },
  separator: { height: 0 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  bannerText: { ...type.small, flex: 1, color: colors.warn },
  bannerLink: { ...type.small, color: colors.warn, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  errorCard: { gap: spacing.sm, marginBottom: spacing.md },
  errorTitle: { ...type.h2, color: colors.danger },
  errorBody: { ...type.small },
});
