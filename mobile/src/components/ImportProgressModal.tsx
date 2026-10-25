import React from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import type { IndexProgress } from '../services/indexing';
import { ProgressBar } from './ui';
import { colors, radius, spacing, type } from '../theme';

export interface ImportProgressState {
  title: string;
  label: string;
  percent: number;
}

export function indexStageLabel(progress: IndexProgress): string {
  switch (progress.stage) {
    case 'pending':
      return '准备导入…';
    case 'chunking':
      return '分块与写入词法索引…';
    case 'lexical_ready':
      return '词法索引完成…';
    case 'embedding':
      return '生成向量索引…';
    case 'ready':
      return '索引完成…';
    case 'partial':
      return progress.error ? `部分完成：${progress.error}` : '部分完成…';
    default:
      return '处理中…';
  }
}

export function ImportProgressModal({
  visible,
  state,
}: {
  visible: boolean;
  state: ImportProgressState;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{state.title}</Text>
          <ProgressBar value={state.percent / 100} />
          <View style={styles.row}>
            <Text style={styles.label}>{state.label}</Text>
            <Text style={styles.percent}>{Math.round(state.percent)}%</Text>
          </View>
          <Text style={styles.hint}>大文件需要一点时间，请保持 App 在前台。</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { ...type.h2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  label: { ...type.small, flex: 1 },
  percent: { ...type.small, color: colors.primary, fontWeight: '700' },
  hint: { ...type.tiny },
});
