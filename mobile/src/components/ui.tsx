import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { colors, radius, shadow, spacing, type } from '../theme';

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Section({
  title,
  hint,
  right,
  children,
  style,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.section, style]}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderText}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  small = false,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive }}
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'ghost' && styles.buttonGhost,
        variant === 'danger' && styles.buttonDanger,
        pressed && !inactive && styles.buttonPressed,
        inactive && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' || variant === 'danger' ? colors.white : colors.primary}
        />
      ) : (
        <Text
          style={[
            styles.buttonText,
            small && styles.buttonTextSmall,
            variant === 'primary' && styles.buttonTextPrimary,
            variant === 'secondary' && styles.buttonTextSecondary,
            variant === 'ghost' && styles.buttonTextGhost,
            variant === 'danger' && styles.buttonTextDanger,
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function TextField({
  label,
  hint,
  error,
  style,
  ...inputProps
}: TextInputProps & {
  label?: string;
  hint?: string;
  error?: string | null;
}) {
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textFaint}
        {...inputProps}
        style={[styles.input, inputProps.multiline && styles.inputMultiline, style]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
      {!error && hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export type BadgeTone = 'neutral' | 'success' | 'warn' | 'danger' | 'info';

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: BadgeTone;
}) {
  return (
    <View
      style={[
        styles.badge,
        tone === 'success' && styles.badgeSuccess,
        tone === 'warn' && styles.badgeWarn,
        tone === 'danger' && styles.badgeDanger,
        tone === 'info' && styles.badgeInfo,
      ]}
    >
      <Text
        style={[
          styles.badgeText,
          tone === 'success' && styles.badgeTextSuccess,
          tone === 'warn' && styles.badgeTextWarn,
          tone === 'danger' && styles.badgeTextDanger,
          tone === 'info' && styles.badgeTextInfo,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const percent = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${percent * 100}%` }]} />
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function PillNav({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.pillNav, pressed && styles.pillNavPressed]}
    >
      <Text style={styles.pillNavText}>{label}</Text>
    </Pressable>
  );
}

export const uiStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gapSm: { gap: spacing.sm },
  gapMd: { gap: spacing.md },
  flex: { flex: 1 },
  muted: { ...type.small },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadow,
  },
  section: {
    gap: spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  sectionHeaderText: { flex: 1, gap: 2 },
  sectionTitle: { ...type.h2 },
  sectionHint: { ...type.small },
  button: {
    minHeight: 46,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSmall: {
    minHeight: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: {
    backgroundColor: colors.primarySoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDanger: { backgroundColor: colors.dangerSoft },
  buttonPressed: { opacity: 0.78 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  buttonTextSmall: { fontSize: 13 },
  buttonTextPrimary: { color: colors.white },
  buttonTextSecondary: { color: colors.primary },
  buttonTextGhost: { color: colors.primary },
  buttonTextDanger: { color: colors.danger },
  field: { gap: 6 },
  fieldLabel: { ...type.small, color: colors.text, fontWeight: '600' },
  input: {
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  fieldHint: { ...type.tiny },
  fieldError: { ...type.tiny, color: colors.danger },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: { ...type.h2, textAlign: 'center' },
  emptyBody: { ...type.small, textAlign: 'center' },
  emptyAction: { marginTop: spacing.md },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.cardAlt,
  },
  badgeSuccess: { backgroundColor: colors.successSoft },
  badgeWarn: { backgroundColor: colors.warnSoft },
  badgeDanger: { backgroundColor: colors.dangerSoft },
  badgeInfo: { backgroundColor: colors.infoSoft },
  badgeText: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  badgeTextSuccess: { color: colors.success },
  badgeTextWarn: { color: colors.warn },
  badgeTextDanger: { color: colors.danger },
  badgeTextInfo: { color: colors.info },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.cardAlt,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  pillNav: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  pillNavPressed: { opacity: 0.7 },
  pillNavText: { ...type.small, color: colors.primary, fontWeight: '600' },
});
