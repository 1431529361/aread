import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { BookRecord } from '../../src/db/repositories/books';
import { getBook } from '../../src/db/repositories/books';
import {
  createConversation,
  getOrCreateBookConversation,
  listConversationsForBook,
  type ConversationRecord,
} from '../../src/db/repositories/conversations';
import {
  deleteHighlight,
  listHighlights,
  type HighlightRecord,
} from '../../src/db/repositories/highlights';
import { getDatabase } from '../../src/db/client';
import { deleteBookCompletely } from '../../src/services/bookImport';
import { type IndexProgress } from '../../src/services/indexing';
import {
  runBookVectorIndex,
  runtimeEmbedSig,
} from '../../src/services/indexRuntime';
import { loadEmbeddingRuntime } from '../../src/services/providerRuntime';
import { useAppStore } from '../../src/stores/appStore';
import { Badge, Button, Card, Divider, EmptyState, ProgressBar, Section } from '../../src/components/ui';
import {
  formatCount,
  formatDateTime,
  formatPercent,
  indexStatusMeta,
} from '../../src/components/bookStatus';
import {
  goBackOrLibrary,
  openChat,
  openReader,
  openSearch,
} from '../../src/navigation/routes';
import { firstParam } from '../../src/utils/params';
import { colors, spacing, type } from '../../src/theme';

export default function BookDetailScreen() {
  const params = useLocalSearchParams<{ bookId: string }>();
  const bookId = firstParam(params.bookId);
  const bumpLibrary = useAppStore((state) => state.bumpLibrary);

  const [book, setBook] = useState<BookRecord | null>(null);
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [activeEmbedSig, setActiveEmbedSig] = useState<string | null>(null);
  const indexAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const db = getDatabase();
      const [found, embedding] = await Promise.all([
        getBook(db, { userId: 'local', bookId }),
        loadEmbeddingRuntime(db),
      ]);
      setActiveEmbedSig(embedding ? runtimeEmbedSig(embedding) : null);
      if (!found) {
        setError('书籍不存在或已被删除');
        setBook(null);
        return;
      }
      const [marks, convs] = await Promise.all([
        listHighlights(db, bookId),
        listConversationsForBook(db, { userId: 'local', bookId }),
      ]);
      setBook(found);
      setHighlights(marks);
      setConversations(convs);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => () => indexAbortRef.current?.abort(), []);

  async function handleIndex(): Promise<void> {
    if (!book || !activeEmbedSig) return;
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setIndexing(true);
    setIndexProgress(null);
    try {
      await runBookVectorIndex({
        db: getDatabase(),
        userId: 'local',
        bookId: book.id,
        signal: controller.signal,
        onProgress: setIndexProgress,
      });
      bumpLibrary();
      await load();
    } catch (caught) {
      if (!controller.signal.aborted) {
        Alert.alert('索引失败', caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      indexAbortRef.current = null;
      setIndexing(false);
      setIndexProgress(null);
    }
  }

  function handlePauseIndex(): void {
    indexAbortRef.current?.abort();
  }

  async function handleAsk(): Promise<void> {
    if (!book) return;
    try {
      const db = getDatabase();
      const conversation = await getOrCreateBookConversation(db, {
        userId: 'local',
        bookId: book.id,
      });
      openChat(conversation.id, book.id);
    } catch (caught) {
      Alert.alert('无法开始对话', caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleNewConversation(): Promise<void> {
    if (!book) return;
    try {
      const db = getDatabase();
      const conversation = await createConversation(db, {
        userId: 'local',
        bookId: book.id,
        scope: 'book',
        title: `《${book.title}》新对话`,
      });
      openChat(conversation.id, book.id);
    } catch (caught) {
      Alert.alert('新建失败', caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleDeleteHighlight(highlight: HighlightRecord): void {
    Alert.alert('删除这条划线？', highlight.selectedText.slice(0, 60), [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const db = getDatabase();
            await deleteHighlight(db, { bookId, highlightId: highlight.id });
            await load();
          })();
        },
      },
    ]);
  }

  function handleDeleteBook(): void {
    if (!book) return;
    Alert.alert(
      '删除这本书？',
      '书籍文件、索引、划线与会话会一并删除，无法恢复。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                const db = getDatabase();
                await deleteBookCompletely(db, { book });
                bumpLibrary();
                goBackOrLibrary();
              } catch (caught) {
                Alert.alert(
                  '删除失败',
                  caught instanceof Error ? caught.message : String(caught),
                );
              }
            })();
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!book) {
    return (
      <View style={styles.loading}>
        <EmptyState
          title="找不到这本书"
          body={error ?? undefined}
          action={<Button title="返回书架" onPress={goBackOrLibrary} />}
        />
      </View>
    );
  }

  const status = indexStatusMeta(book.indexStatus);
  const vectorReady =
    book.indexStatus === 'ready' && !!activeEmbedSig && book.embedSig === activeEmbedSig;
  const progressPercent = indexing && indexProgress
    ? indexProgress.percent / 100
    : book.indexProgress;

  return (
    <>
      <Stack.Screen options={{ title: book.title }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
      >
        <Card style={styles.hero}>
          <View style={styles.heroTop}>
            <View style={styles.cover}>
              <Text style={styles.coverText} numberOfLines={2}>
                {book.title.slice(0, 4)}
              </Text>
            </View>
            <View style={styles.heroInfo}>
              <Text style={styles.title}>{book.title}</Text>
              <Text style={styles.meta}>
                {book.author !== '未知' ? `${book.author} · ` : ''}
                {book.format.toUpperCase()} · {book.sizeFormatted}
              </Text>
              <Text style={styles.meta}>
                {formatCount(book.charCount)} · 导入于 {formatDateTime(book.uploadTime)}
              </Text>
              <View style={styles.progressRow}>
                <Text style={styles.progressLabel}>
                  已读 {formatPercent(book.readProgress)}
                </Text>
                <Badge label={status.label} tone={status.tone} />
              </View>
              <ProgressBar value={book.readProgress} />
            </View>
          </View>
          <View style={styles.actions}>
            <Button
              title={book.readProgress > 0 ? '继续阅读' : '开始阅读'}
              onPress={() => openReader(book.id)}
              style={styles.action}
            />
            <Button
              title="本书问答"
              variant="secondary"
              onPress={() => void handleAsk()}
              style={styles.action}
            />
          </View>
          <View style={styles.linkRow}>
            <Button
              title="全书搜索"
              variant="ghost"
              small
              onPress={() => openSearch(book.id)}
            />
            <Button
              title="新建对话"
              variant="ghost"
              small
              onPress={() => void handleNewConversation()}
            />
          </View>
        </Card>

        <Section title="检索索引" hint="关键词检索离线可用；向量索引启用语义召回与跨书问答">
          <Card style={styles.indexCard}>
            <View style={styles.indexHeader}>
              <Badge
                label={
                  vectorReady
                    ? '向量已就绪'
                    : activeEmbedSig
                      ? status.label
                      : '关键词模式'
                }
                tone={vectorReady ? 'success' : status.tone}
              />
              <Text style={styles.indexPercent}>{formatPercent(progressPercent)}</Text>
            </View>
            <ProgressBar value={progressPercent} />
            <Text style={styles.indexHint}>
              {!activeEmbedSig
                ? '尚未配置向量模型，当前使用关键词检索；阅读和离线搜索不受影响。'
                : vectorReady
                  ? '当前向量配置已完成，可使用混合检索。'
                  : '索引会每批保存进度；暂停、杀进程或网络失败后可从未完成分块继续。'}
            </Text>
            {indexing && indexProgress ? (
              <Text style={styles.indexStage}>
                正在向量化 · {indexProgress.done}/{indexProgress.total}
              </Text>
            ) : null}
            {activeEmbedSig && !vectorReady ? (
              <Button
                title={indexing ? '暂停索引' : book.indexStatus === 'partial' || book.indexStatus === 'embedding' ? '继续向量索引' : '建立向量索引'}
                variant="secondary"
                onPress={indexing ? handlePauseIndex : () => void handleIndex()}
              />
            ) : null}
          </Card>
        </Section>

        <Section
          title="对话"
          hint={`${conversations.length} 个会话`}
          right={
            <Button
              title="新对话"
              small
              variant="secondary"
              onPress={() => void handleNewConversation()}
            />
          }
        >
          {conversations.length === 0 ? (
            <Card>
              <Text style={styles.emptyText}>
                还没有对话。阅读时选中文字可直接提问，也可以从这里开始。
              </Text>
            </Card>
          ) : (
            conversations.map((conversation) => (
              <Card key={conversation.id} style={styles.listCard}>
                <View style={styles.listRow}>
                  <View style={styles.listText}>
                    <Text style={styles.listTitle} numberOfLines={1}>
                      {conversation.title}
                    </Text>
                    <Text style={styles.listMeta}>
                      {conversation.status === 'active' ? '当前' : '已归档'} ·{' '}
                      {formatDateTime(conversation.updatedAt)}
                    </Text>
                  </View>
                  <Button
                    title="打开"
                    small
                    variant="secondary"
                    onPress={() => openChat(conversation.id, book.id)}
                  />
                </View>
              </Card>
            ))
          )}
        </Section>

        <Section title="划线" hint={`${highlights.length} 条`}>
          {highlights.length === 0 ? (
            <Card>
              <Text style={styles.emptyText}>
                阅读时长按选中文字，点击「划线」即可保存到这里。
              </Text>
            </Card>
          ) : (
            highlights.map((highlight) => (
              <Card key={highlight.id} style={styles.listCard}>
                <Text style={styles.quote}>“{highlight.selectedText}”</Text>
                <Divider />
                <View style={styles.listRow}>
                  <Text style={styles.listMeta}>
                    {highlight.color} · {formatDateTime(highlight.createdAt)}
                  </Text>
                  <View style={styles.highlightActions}>
                    <Button
                      title="跳到原文"
                      small
                      variant="ghost"
                      onPress={() => openReader(book.id, highlight.loc, { flash: true })}
                    />
                    <Button
                      title="删除"
                      small
                      variant="ghost"
                      onPress={() => handleDeleteHighlight(highlight)}
                    />
                  </View>
                </View>
              </Card>
            ))
          )}
        </Section>

        <Section title="危险操作">
          <Card style={styles.dangerCard}>
            <Text style={styles.dangerText}>
              删除后书籍文件、索引、会话与划线都会从本机清除。
            </Text>
            <Button title="删除这本书" variant="danger" onPress={handleDeleteBook} />
          </Card>
        </Section>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: spacing.xl,
  },
  hero: { gap: spacing.md },
  heroTop: { flexDirection: 'row', gap: spacing.md },
  cover: {
    width: 76,
    height: 108,
    borderRadius: 10,
    backgroundColor: '#d9c3ad',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  coverText: { fontSize: 14, fontWeight: '700', color: '#453425', textAlign: 'center' },
  heroInfo: { flex: 1, gap: 4 },
  title: { ...type.h1 },
  meta: { ...type.tiny },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  progressLabel: { ...type.small, color: colors.primary, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
  linkRow: { flexDirection: 'row', justifyContent: 'space-between' },
  indexCard: { gap: spacing.sm },
  indexHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  indexPercent: { ...type.small, fontWeight: '700', color: colors.primary },
  indexHint: { ...type.small },
  indexStage: { ...type.tiny, color: colors.info },
  listCard: { gap: spacing.sm },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  listText: { flex: 1, gap: 2 },
  listTitle: { ...type.h2 },
  listMeta: { ...type.tiny },
  emptyText: { ...type.small },
  quote: { ...type.body, color: colors.text },
  highlightActions: { flexDirection: 'row', alignItems: 'center' },
  dangerCard: { gap: spacing.md },
  dangerText: { ...type.small, color: colors.danger },
});
