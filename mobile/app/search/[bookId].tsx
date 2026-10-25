import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { BookRecord } from '../../src/db/repositories/books';
import { getBook } from '../../src/db/repositories/books';
import { getDatabase } from '../../src/db/client';
import {
  searchBookKeyword,
  type BookSearchResult,
} from '../../src/services/bookSearch';
import { indexStatusMeta } from '../../src/components/bookStatus';
import { Button, Card, EmptyState, TextField } from '../../src/components/ui';
import { openReader } from '../../src/navigation/routes';
import { firstParam } from '../../src/utils/params';
import { colors, radius, spacing, type } from '../../src/theme';

export default function SearchScreen() {
  const params = useLocalSearchParams<{ bookId: string; q?: string }>();
  const bookId = firstParam(params.bookId);
  const initialQuery = firstParam(params.q);

  const [book, setBook] = useState<BookRecord | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<BookSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = getDatabase();
        const found = await getBook(db, { userId: 'local', bookId });
        if (!cancelled) setBook(found);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const runSearch = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setResults([]);
        setSearched(false);
        return;
      }
      setSearching(true);
      setError(null);
      try {
        const db = getDatabase();
        const hits = await searchBookKeyword(db, {
          bookId,
          query: trimmed,
          limit: 30,
        });
        setResults(hits);
        setSearched(true);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setSearching(false);
      }
    },
    [bookId],
  );

  useEffect(() => {
    if (initialQuery.trim()) void runSearch(initialQuery);
  }, [initialQuery, runSearch]);

  const searchable = book ? indexStatusMeta(book.indexStatus).searchable : false;

  return (
    <>
      <Stack.Screen
        options={{ title: book ? `搜索 · ${book.title}` : '全书搜索' }}
      />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.searchRow}>
          <View style={styles.inputWrap}>
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder="输入关键词，例如人物名或地名"
              returnKeyType="search"
              onSubmitEditing={() => void runSearch(query)}
              autoFocus={!initialQuery}
            />
          </View>
          <Button
            title="搜索"
            onPress={() => void runSearch(query)}
            loading={searching}
          />
        </View>

        {!searchable && book ? (
          <Card style={styles.warn}>
            <Text style={styles.warnText}>
              这本书还没有完成词法索引，搜索可能为空。可在书籍详情页重建索引。
            </Text>
          </Card>
        ) : null}

        {error ? (
          <Card style={styles.warn}>
            <Text style={[styles.warnText, styles.errorText]}>{error}</Text>
          </Card>
        ) : null}

        {searching ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : null}

        {!searching && !searched ? (
          <EmptyState
            title="在整本书里找"
            body="关键词搜索完全在本地运行。点击结果可直接跳到原文位置。"
          />
        ) : null}

        {!searching && searched && results.length === 0 ? (
          <EmptyState
            title="没有找到相关内容"
            body="换一个关键词试试，或确认这本书已完成索引。"
          />
        ) : null}

        {results.map((result) => (
          <Pressable
            key={result.chunkId}
            accessibilityRole="button"
            onPress={() => openReader(bookId, result.loc, { flash: true })}
            style={({ pressed }) => [styles.result, pressed && styles.pressed]}
          >
            <Text style={styles.chapter}>{result.chapter || '正文'}</Text>
            <Text style={styles.snippet}>{result.snippet}</Text>
            <Text style={styles.jump}>跳到原文 ›</Text>
          </Pressable>
        ))}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  searchRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  inputWrap: { flex: 1 },
  warn: { padding: spacing.md },
  warnText: { ...type.small, color: colors.warn },
  errorText: { color: colors.danger },
  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
  result: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  pressed: { opacity: 0.7 },
  chapter: { ...type.tiny, color: colors.primary, fontWeight: '700' },
  snippet: { ...type.body },
  jump: { ...type.tiny, color: colors.textMuted, textAlign: 'right' },
});
