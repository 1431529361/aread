import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, type Href } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getDatabase } from '../src/db/client';
import { getProviderConfig, type ProviderConfigRecord } from '../src/db/repositories/providers';
import { setSetting } from '../src/db/repositories/settings';
import { ProviderForm } from '../src/components/ProviderForm';
import {
  ImportProgressModal,
  indexStageLabel,
  type ImportProgressState,
} from '../src/components/ImportProgressModal';
import { Button, Card, Divider, Section } from '../src/components/ui';
import { importBook, pickBookFile } from '../src/services/bookImport';
import { useAppStore } from '../src/stores/appStore';
import { colors, radius, spacing, type } from '../src/theme';

const STEPS = ['对话模型', '向量模型', '第一本书'];

export default function OnboardingScreen() {
  const bumpLibrary = useAppStore((state) => state.bumpLibrary);
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [chatRecord, setChatRecord] = useState<ProviderConfigRecord | null>(null);
  const [embeddingRecord, setEmbeddingRecord] = useState<ProviderConfigRecord | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgressState>({
    title: '导入书籍',
    label: '准备导入…',
    percent: 0,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const db = getDatabase();
        const [chat, embedding] = await Promise.all([
          getProviderConfig(db, 'chat'),
          getProviderConfig(db, 'embedding'),
        ]);
        if (cancelled) return;
        setChatRecord(chat);
        setEmbeddingRecord(embedding);
        if (chat) setStep(embedding ? 3 : 2);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function finish(): Promise<void> {
    const db = getDatabase();
    await setSetting(db, { key: 'onboarding_done', value: '1' });
    bumpLibrary();
    router.replace('/(tabs)/library' as Href);
  }

  async function handleImport(): Promise<void> {
    const asset = await pickBookFile();
    if (!asset) return;
    setImporting(true);
    setProgress({ title: '导入书籍', label: '准备导入…', percent: 0 });
    try {
      const db = getDatabase();
      const result = await importBook({
        db,
        asset,
        onProgress: (value) =>
          setProgress({
            title: '导入书籍',
            label: indexStageLabel(value),
            percent: value.percent,
          }),
      });
      if (result.status === 'duplicate') {
        Alert.alert('这本书已在书架', '直接去书架继续阅读即可。');
      }
      await finish();
    } catch (error) {
      Alert.alert(
        '导入失败',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero}>
            <Text style={styles.brand}>AI 阅读助手</Text>
            <Text style={styles.tagline}>本地优先 · 书与对话都留在你的设备上</Text>
          </View>

          <View style={styles.steps}>
            {STEPS.map((label, index) => {
              const number = index + 1;
              const active = number === step;
              const done = number < step;
              return (
                <View key={label} style={styles.stepItem}>
                  <View
                    style={[
                      styles.stepDot,
                      active && styles.stepDotActive,
                      done && styles.stepDotDone,
                    ]}
                  >
                    <Text
                      style={[
                        styles.stepNumber,
                        (active || done) && styles.stepNumberActive,
                      ]}
                    >
                      {done ? '✓' : String(number)}
                    </Text>
                  </View>
                  <Text style={[styles.stepLabel, active && styles.stepLabelActive]}>
                    {label}
                  </Text>
                </View>
              );
            })}
          </View>

          {step === 1 ? (
            <>
              <Card style={styles.intro}>
                <Text style={styles.introTitle}>先连接你的对话模型</Text>
                <Text style={styles.introBody}>
                  使用任意 OpenAI 兼容端点。API Key 仅保存在系统 SecureStore，并只发送到你配置的
                  HTTPS 端点用于鉴权；提问时会向该第三方端点发送对话、所选原文和检索到的书籍片段。
                  没有网络时，已导入的书仍可离线阅读与搜索。
                </Text>
              </Card>
              <Section title="对话模型" hint="必填，划词提问与引用回答都依赖它">
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
              <Button
                title={chatRecord ? '下一步' : '请先保存对话模型'}
                disabled={!chatRecord}
                onPress={() => setStep(2)}
              />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <Card style={styles.intro}>
                <Text style={styles.introTitle}>向量模型（可选）</Text>
                <Text style={styles.introBody}>
                  跳过后仍可使用关键词检索与引用跳转。配置后，建立索引会把书籍分块发送到你配置的
                  Embedding 端点；检索与重排也会发送查询及候选片段。界面会明确显示索引模式。
                </Text>
              </Card>
              <Section title="向量模型" hint="必须返回 1024 维；保存前会自动实测">
                <Card>
                  <ProviderForm
                    key={`embedding-${embeddingRecord?.updatedAt ?? 'new'}`}
                    db={getDatabase()}
                    kind="embedding"
                    record={embeddingRecord}
                    onSaved={setEmbeddingRecord}
                  />
                </Card>
              </Section>
              <View style={styles.actions}>
                <Button
                  title="上一步"
                  variant="ghost"
                  onPress={() => setStep(1)}
                  style={styles.action}
                />
                <Button
                  title={embeddingRecord ? '下一步' : '跳过，仅关键词检索'}
                  onPress={() => setStep(3)}
                  style={styles.actionWide}
                />
              </View>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <Card style={styles.intro}>
                <Text style={styles.introTitle}>导入第一本书</Text>
                <Text style={styles.introBody}>
                  支持 TXT（UTF-8 / UTF-16 / GBK，最大 50MB）与 EPUB（含图片、目录，
                  最大 100MB）。导入后会立即建立本地词法索引，飞行模式下也能阅读、
                  划词与搜索。
                </Text>
                <Divider />
                <Text style={styles.introHint}>
                  书籍文件会复制到 App 私有目录，删除 App 时会一并清除。
                </Text>
              </Card>
              <Button title="选择文件" onPress={handleImport} loading={importing} />
              <Button
                title="稍后导入，先进入书架"
                variant="ghost"
                onPress={() => void finish()}
              />
              <Button title="上一步" variant="ghost" onPress={() => setStep(2)} />
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <ImportProgressModal visible={importing} state={progress} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  content: { padding: spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxl },
  hero: { gap: spacing.xs, marginTop: spacing.md },
  brand: { ...type.title },
  tagline: { ...type.small },
  steps: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  stepItem: { flex: 1, alignItems: 'center', gap: 4 },
  stepDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  stepDotActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  stepDotDone: { backgroundColor: colors.success, borderColor: colors.success },
  stepNumber: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  stepNumberActive: { color: colors.white },
  stepLabel: { fontSize: 11, color: colors.textFaint },
  stepLabelActive: { color: colors.text, fontWeight: '600' },
  intro: { gap: spacing.sm, borderRadius: radius.lg },
  introTitle: { ...type.h1 },
  introBody: { ...type.body },
  introHint: { ...type.tiny },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
  actionWide: { flex: 2 },
});
