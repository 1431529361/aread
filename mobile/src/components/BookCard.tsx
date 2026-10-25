import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BookRecord } from '../db/repositories/books';
import { Badge, ProgressBar } from './ui';
import { formatCount, formatDateTime, formatPercent, indexStatusMeta } from './bookStatus';
import { colors, radius, shadow, spacing, type } from '../theme';

export function BookCard({
  book,
  onOpen,
  onDetail,
}: {
  book: BookRecord;
  onOpen: () => void;
  onDetail: () => void;
}) {
  const status = indexStatusMeta(book.indexStatus);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={[styles.cover, book.format === 'epub' && styles.coverEpub]}>
        <Text style={styles.coverText} numberOfLines={2}>
          {book.title.slice(0, 4)}
        </Text>
        <Text style={styles.coverFormat}>{book.format.toUpperCase()}</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={2}>
            {book.title}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onDetail}
            hitSlop={10}
            style={({ pressed }) => [styles.detail, pressed && styles.pressed]}
          >
            <Text style={styles.detailText}>详情</Text>
          </Pressable>
        </View>

        <Text style={styles.meta} numberOfLines={1}>
          {book.author !== '未知' ? `${book.author} · ` : ''}
          {formatCount(book.charCount)} · {book.sizeFormatted}
        </Text>

        <View style={styles.badgeRow}>
          <Badge label={status.label} tone={status.tone} />
          <Text style={styles.progressText}>{formatPercent(book.readProgress)}</Text>
        </View>

        <ProgressBar value={book.readProgress} />

        <Text style={styles.lastRead}>{formatDateTime(book.lastRead)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    ...shadow,
  },
  pressed: { opacity: 0.75 },
  cover: {
    width: 68,
    height: 96,
    borderRadius: radius.md,
    backgroundColor: '#d9c3ad',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
    gap: 4,
  },
  coverEpub: { backgroundColor: '#c3cfd9' },
  coverText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#453425',
    textAlign: 'center',
    lineHeight: 18,
  },
  coverFormat: { fontSize: 9, color: 'rgba(69,52,37,0.7)', fontWeight: '600' },
  body: { flex: 1, gap: 5, paddingVertical: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  title: { ...type.h2, flex: 1, lineHeight: 21 },
  detail: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.cardAlt,
  },
  detailText: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  meta: { ...type.tiny },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  progressText: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  lastRead: { ...type.tiny, textAlign: 'right' },
});
