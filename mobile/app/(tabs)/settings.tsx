import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getDatabase, recheckFts5 } from '../../src/db/client';
import {
  getProviderConfig,
  type ProviderConfigRecord,
} from '../../src/db/repositories/providers';
import { ProviderForm } from '../../src/components/ProviderForm';
import { Button, Card, Divider, Section } from '../../src/components/ui';
import { getDiagnostics, type Diagnostics } from '../../src/services/diagnostics';
import { formatFileSize } from '../../src/core/import/txt';
import { computeEmbedSig } from '../../src/core/embedding/signature';
import {
  deleteMemory,
  listMemories,
} from '../../src/db/repositories/memories';
import type { MemoryRecord } from '../../src/core/conversation/memoryV2';
import {
  markBooksForVectorRebuild,
  rebuildLibraryVectors,
  type LibraryIndexProgress,
} from '../../src/services/indexRuntime';
import { colors, spacing, type } from '../../src/theme';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export default function SettingsScreen() {
  const [chatRecord, setChatRecord] = useState<ProviderConfigRecord | null>(null);
  const [embeddingRecord, setEmbeddingRecord] = useState<ProviderConfigRecord | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<LibraryIndexProgress | null>(null);
  const rebuildAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const db = getDatabase();
      const [chat, embedding, diag, memoryList] = await Promise.all([
        getProviderConfig(db, 'chat'),
        getProviderConfig(db, 'embedding'),
        getDiagnostics(db),
        listMemories(db, 'local'),
      ]);
      setChatRecord(chat);
      setEmbeddingRecord(embedding);
      setDiagnostics(diag);
      setMemories(memoryList);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function handleRecheck(): Promise<void> {
    setRechecking(true);
    try {
      const status = await recheckFts5();
      setDiagnostics((current) => (current ? { ...current, fts5: status } : current));
    } finally {
      setRechecking(false);
    }
  }

  async function startLibraryRebuild(): Promise<void> {
    if (rebuilding) return;
    const controller = new AbortController();
    rebuildAbortRef.current = controller;
    setRebuilding(true);
    setRebuildProgress(null);
    try {
      const result = await rebuildLibraryVectors({
        db: getDatabase(),
        signal: controller.signal,
        onProgress: setRebuildProgress,
      });
      if (!controller.signal.aborted) {
        Alert.alert(
          '向量索引完成',
          `已完成 ${result.completed} 本${result.partial ? `，${result.partial} 本需要重试` : ''}`,
        );
      }
      await load();
    } catch (caught) {
      if (!controller.signal.aborted) {
        Alert.alert('重建失败', caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      rebuildAbortRef.current = null;
      setRebuilding(false);
      setRebuildProgress(null);
    }
  }

  async function handleEmbeddingSaved(
    saved: ProviderConfigRecord,
    previous: ProviderConfigRecord | null,
  ): Promise<void> {
    setEmbeddingRecord(saved);
    const sig = computeEmbedSig({ ...saved, dims: saved.dims ?? 1024 });
    const previousSig = previous
      ? computeEmbedSig({ ...previous, dims: previous.dims ?? 1024 })
      : null;
    if (sig === previousSig) return;

    const affected = await markBooksForVectorRebuild(getDatabase(), sig);
    if (affected === 0) return;
    Alert.alert(
      '需要重建向量索引',
      `向量配置已改变，${affected} 本书需要用新模型重建。旧向量会保留到每本书重建成功。`,
      [
        { text: '稍后' },
        { text: '立即重建', onPress: () => void startLibraryRebuild() },
      ],
    );
  }

  function handleDeleteMemory(memory: MemoryRecord): void {
    Alert.alert('删除这条记忆？', memory.content, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            await deleteMemory(getDatabase(), 'local', memory.id);
            setMemories((current) => current.filter((item) => item.id !== memory.id));
          })();
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>设置</Text>
        <Text style={styles.subtitle}>模型、索引与本地存储</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <>
            <Section
              title="对话模型"
              hint="任意 OpenAI 兼容端点；修改后只影响新消息"
            >
              <Card>
                <ProviderForm
                  key={`chat-${chatRecord?.updatedAt ?? 'new'}`}
                  db={getDatabase()}
                  kind="chat"
                  record={chatRecord}
                  onSaved={setChatRecord}
                />
              </Card>
            </Section>

            <Section
              title="向量模型（可选）"
              hint="统一 1024 维；配置后启用语义召回、跨书检索与可续跑索引"
            >
              <Card>
                <ProviderForm
                  key={`embedding-${embeddingRecord?.updatedAt ?? 'new'}`}
                  db={getDatabase()}
                  kind="embedding"
                  record={embeddingRecord}
                  onSaved={handleEmbeddingSaved}
                />
              </Card>
              {embeddingRecord ? (
                <Card style={styles.rebuildCard}>
                  <Text style={styles.aboutTitle}>全库向量索引</Text>
                  {rebuildProgress ? (
                    <Text style={styles.aboutBody}>
                      {rebuildProgress.bookTitle} · {rebuildProgress.current + 1}/
                      {rebuildProgress.total} · {rebuildProgress.book?.percent ?? 0}%
                    </Text>
                  ) : (
                    <Text style={styles.aboutBody}>
                      配置变化后可在这里重建；中断后会从尚未写入的分块继续。
                    </Text>
                  )}
                  <Button
                    title={rebuilding ? '暂停重建' : '重建需要更新的书籍'}
                    variant="secondary"
                    onPress={
                      rebuilding
                        ? () => rebuildAbortRef.current?.abort()
                        : () => void startLibraryRebuild()
                    }
                  />
                </Card>
              ) : null}
            </Section>

            <Section
              title="AI 对你的了解"
              hint="只记录你的偏好、背景与兴趣，不记录书籍内容"
            >
              {memories.length === 0 ? (
                <Card>
                  <Text style={styles.aboutBody}>暂无长期记忆。每 6 轮对话会自动整理一次。</Text>
                </Card>
              ) : (
                memories.map((memory) => (
                  <Card key={memory.id} style={styles.memoryCard}>
                    <Text style={styles.memoryText}>{memory.content}</Text>
                    <View style={styles.memoryFooter}>
                      <Text style={styles.rowLabel}>{memory.kind}</Text>
                      <Button
                        title="删除"
                        small
                        variant="ghost"
                        onPress={() => handleDeleteMemory(memory)}
                      />
                    </View>
                  </Card>
                ))
              )}
            </Section>

            <Section
              title="运行诊断"
              hint="真机验收时用来确认设备能力与数据落盘"
              right={
                <Button
                  title="重新检测"
                  variant="secondary"
                  small
                  loading={rechecking}
                  onPress={handleRecheck}
                />
              }
            >
              <Card style={styles.diag}>
                <Row
                  label="FTS5"
                  value={
                    diagnostics?.fts5.available
                      ? '可用（MATCH 查询）'
                      : '不可用（已降级为 BM25）'
                  }
                />
                <Divider />
                <Row
                  label="流式输出"
                  value={
                    diagnostics?.streaming === 'expo-fetch'
                      ? 'expo/fetch'
                      : 'XHR SSE 降级'
                  }
                />
                <Divider />
                <Row label="Schema 版本" value={`v${diagnostics?.schemaVersion ?? '-'}`} />
                <Divider />
                <Row label="书籍" value={`${diagnostics?.books ?? 0} 本`} />
                <Divider />
                <Row label="索引块" value={`${diagnostics?.chunks ?? 0}`} />
                <Divider />
                <Row label="向量" value={`${diagnostics?.vectors ?? 0}`} />
                <Divider />
                <Row label="会话 / 划线" value={`${diagnostics?.conversations ?? 0} / ${diagnostics?.highlights ?? 0}`} />
                <Divider />
                <Row
                  label="书籍占用"
                  value={formatFileSize(diagnostics?.storageBytes ?? 0)}
                />
                {diagnostics && !diagnostics.fts5.available ? (
                  <Text style={styles.note}>
                    当前设备未启用 FTS5，搜索会自动使用 SQLite 倒排表 + JS BM25，
                    划词提问与引用跳转不受影响。
                  </Text>
                ) : null}
              </Card>
            </Section>

            <Section title="关于">
              <Card style={styles.about}>
                <Text style={styles.aboutTitle}>AI 阅读助手 · M2</Text>
                <Text style={styles.aboutBody}>
                  本地优先：书籍、索引、会话、划线全部保存在设备私有目录与 SQLite，
                  不设账号、不上传服务器。API Key 仅存于 SecureStore。
                </Text>
                <Divider />
                <Text style={styles.aboutHint}>
                  删除 App 会同时删除全部本地数据；备份/恢复将在 M3 提供。
                </Text>
              </Card>
            </Section>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: 2,
  },
  title: { ...type.title },
  subtitle: { ...type.tiny },
  content: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.xl,
  },
  loading: { paddingVertical: spacing.xxl, alignItems: 'center' },
  diag: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 2,
  },
  rowLabel: { ...type.small },
  rowValue: { ...type.small, color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  note: { ...type.tiny, color: colors.warn, marginTop: spacing.xs },
  rebuildCard: { gap: spacing.sm },
  memoryCard: { gap: spacing.sm },
  memoryText: { ...type.body, color: colors.text },
  memoryFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  about: { gap: spacing.sm },
  aboutTitle: { ...type.h2 },
  aboutBody: { ...type.small },
  aboutHint: { ...type.tiny },
});
