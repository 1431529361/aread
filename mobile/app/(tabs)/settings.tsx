import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
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
  const [loading, setLoading] = useState(true);
  const [rechecking, setRechecking] = useState(false);

  const load = useCallback(async () => {
    try {
      const db = getDatabase();
      const [chat, embedding, diag] = await Promise.all([
        getProviderConfig(db, 'chat'),
        getProviderConfig(db, 'embedding'),
        getDiagnostics(db),
      ]);
      setChatRecord(chat);
      setEmbeddingRecord(embedding);
      setDiagnostics(diag);
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
                  db={getDatabase()}
                  kind="chat"
                  record={chatRecord}
                  onSaved={setChatRecord}
                />
              </Card>
            </Section>

            <Section
              title="向量模型（可选）"
              hint="M0-B 不依赖向量；配置后用于后续语义召回与重排"
            >
              <Card>
                <ProviderForm
                  db={getDatabase()}
                  kind="embedding"
                  record={embeddingRecord}
                  onSaved={setEmbeddingRecord}
                />
              </Card>
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
                <Text style={styles.aboutTitle}>AI 阅读助手 · M0-B</Text>
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
  about: { gap: spacing.sm },
  aboutTitle: { ...type.h2 },
  aboutBody: { ...type.small },
  aboutHint: { ...type.tiny },
});
