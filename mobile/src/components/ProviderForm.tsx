import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DbAdapter } from '../db/adapter';
import {
  getProviderConfig,
  type ProviderConfigRecord,
  type ProviderKind,
} from '../db/repositories/providers';
import { getApiKey, maskApiKey } from '../services/secureStore';
import {
  buildChatConfig,
  buildEmbeddingConfig,
} from '../services/providerSettings';
import { saveProvider } from '../services/providerRuntime';
import {
  testChatConnection,
  testEmbeddingConnection,
  type ConnectionTestResult,
} from '../services/providerTest';
import { Button, TextField } from './ui';
import { colors, spacing, type } from '../theme';

interface ProviderFormProps {
  db: DbAdapter;
  kind: ProviderKind;
  record: ProviderConfigRecord | null;
  onSaved?: (
    record: ProviderConfigRecord,
    previous: ProviderConfigRecord | null,
  ) => void | Promise<void>;
}

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

export function ProviderForm({ db, kind, record, onSaved }: ProviderFormProps) {
  const isChat = kind === 'chat';

  const [baseUrl, setBaseUrl] = useState(record?.baseUrl ?? '');
  const [model, setModel] = useState(record?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [savedKeyMask, setSavedKeyMask] = useState<string | null>(record?.maskedKey ?? null);
  const [contextWindow, setContextWindow] = useState(
    String(record?.contextWindow ?? 200000),
  );
  const [dimensionsParam, setDimensionsParam] = useState(
    record?.dimensionsParam == null ? '' : String(record.dimensionsParam),
  );
  const [rerankModel, setRerankModel] = useState(record?.rerankModel ?? '');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const key = await getApiKey(kind);
      if (!cancelled && key) setSavedKeyMask(maskApiKey(key));
    })();
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const draftRecord = useMemo<ProviderConfigRecord>(
    () => ({
      kind,
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      model: model.trim(),
      dims: isChat ? null : 1024,
      dimensionsParam: isChat ? null : toNumberOrNull(dimensionsParam),
      maskedKey: savedKeyMask,
      rerankModel: isChat ? null : rerankModel.trim() || null,
      contextWindow: toNumberOrNull(contextWindow) ?? 200000,
      updatedAt: record?.updatedAt ?? null,
    }),
    [
      kind,
      baseUrl,
      model,
      isChat,
      dimensionsParam,
      savedKeyMask,
      rerankModel,
      contextWindow,
      record?.updatedAt,
    ],
  );

  function validate(): string | null {
    if (!/^https?:\/\/\S+/i.test(baseUrl.trim())) {
      return 'Base URL 需要以 http:// 或 https:// 开头';
    }
    if (!model.trim()) return isChat ? '请填写对话模型名' : '请填写向量模型名';
    if (!apiKey.trim() && !savedKeyMask) return '请填写 API Key';
    return null;
  }

  async function resolveKey(): Promise<string> {
    const typed = apiKey.trim();
    if (typed) return typed;
    return (await getApiKey(kind)) ?? '';
  }

  async function handleTest(): Promise<void> {
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setTesting(true);
    setTestResult(null);
    try {
      const key = await resolveKey();
      if (!key) throw new Error('请先填写 API Key');
      const result = isChat
        ? await testChatConnection(buildChatConfig(draftRecord, key))
        : await testEmbeddingConnection(buildEmbeddingConfig(draftRecord, key));
      setTestResult(result);
      if (!result.ok) setError(result.detail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(): Promise<void> {
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // 向量模型保存前必须实测 1024 维，避免入库后检索全部失败
      if (!isChat) {
        const key = await resolveKey();
        if (!key) throw new Error('请先填写 API Key');
        const result = await testEmbeddingConnection(buildEmbeddingConfig(draftRecord, key));
        setTestResult(result);
        if (!result.ok) {
          throw new Error(result.detail || '向量维度校验失败');
        }
      }

      await saveProvider(db, {
        kind,
        baseUrl: draftRecord.baseUrl,
        model: draftRecord.model,
        apiKey: apiKey.trim() || undefined,
        dims: isChat ? null : 1024,
        dimensionsParam: draftRecord.dimensionsParam,
        rerankModel: draftRecord.rerankModel,
        contextWindow: isChat ? draftRecord.contextWindow : null,
      });

      const saved = await getProviderConfig(db, kind);
      setApiKey('');
      if (saved?.maskedKey) setSavedKeyMask(saved.maskedKey);
      if (saved) await onSaved?.(saved, record);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.container}>
      <TextField
        label="Base URL"
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="https://api.example.com/v1"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        hint="只填写前缀，末尾斜杠会自动去掉；请求会拼到 /chat/completions 或 /embeddings"
      />
      <TextField
        label="Model"
        value={model}
        onChangeText={setModel}
        placeholder={isChat ? 'gpt-4o-mini / deepseek-chat …' : 'text-embedding-3-small …'}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextField
        label="API Key"
        value={apiKey}
        onChangeText={setApiKey}
        placeholder={savedKeyMask ? `已保存 ${savedKeyMask}，留空则沿用` : 'sk-…'}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        hint="Key 只保存在设备 SecureStore，数据库仅保存掩码"
      />

      {isChat ? (
        <TextField
          label="上下文窗口（tokens）"
          value={contextWindow}
          onChangeText={setContextWindow}
          keyboardType="number-pad"
          hint="默认 200000，用于历史消息与证据预算"
        />
      ) : (
        <>
          <TextField
            label="dimensions 请求参数（可选）"
            value={dimensionsParam}
            onChangeText={setDimensionsParam}
            keyboardType="number-pad"
            placeholder="1024"
            hint="留空则不发送；若端点默认不是 1024 维，可填 1024"
          />
          <TextField
            label="Rerank Model（可选）"
            value={rerankModel}
            onChangeText={setRerankModel}
            placeholder="BAAI/bge-reranker-v2-m3"
            autoCapitalize="none"
            autoCorrect={false}
            hint="复用当前 Base URL / API Key；留空不启用重排"
          />
        </>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {testResult ? (
        <Text style={[styles.result, testResult.ok ? styles.resultOk : styles.resultFail]}>
          {testResult.ok ? '连接正常' : '连接失败'} · {testResult.latencyMs}ms · {testResult.detail}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button
          title="保存配置"
          onPress={handleSave}
          loading={saving}
          disabled={testing}
          style={styles.action}
        />
        <Button
          title="测试连接"
          variant="secondary"
          onPress={handleTest}
          loading={testing}
          disabled={saving}
          style={styles.action}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
  error: { ...type.small, color: colors.danger },
  result: { ...type.small },
  resultOk: { color: colors.success },
  resultFail: { color: colors.danger },
});
