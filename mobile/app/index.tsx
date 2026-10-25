import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAppStore } from '../src/stores/appStore';
import { getDatabase } from '../src/db/client';
import { getSetting } from '../src/db/repositories/settings';
import { Button } from '../src/components/ui';
import { colors, spacing, type } from '../src/theme';

type Destination = 'library' | 'onboarding' | null;

export default function IndexScreen() {
  const ready = useAppStore((state) => state.ready);
  const initError = useAppStore((state) => state.initError);
  const initialize = useAppStore((state) => state.initialize);
  const [destination, setDestination] = useState<Destination>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeNonce, setProbeNonce] = useState(0);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const db = getDatabase();
        const done = await getSetting(db, 'onboarding_done');
        if (!cancelled) setDestination(done === '1' ? 'library' : 'onboarding');
      } catch (error) {
        if (!cancelled) {
          setProbeError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, probeNonce]);

  if (initError || probeError) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>数据库初始化失败</Text>
        <Text style={styles.body}>{initError ?? probeError}</Text>
        <Button
          title="重试"
          onPress={() => {
            setProbeError(null);
            setProbeNonce((value) => value + 1);
            void initialize();
          }}
          style={styles.button}
        />
      </View>
    );
  }

  if (destination === 'library') {
    return <Redirect href="/(tabs)/library" />;
  }
  if (destination === 'onboarding') {
    return <Redirect href="/onboarding" />;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>AI 阅读助手</Text>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.body}>正在打开本地书库…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.bg,
  },
  brand: { ...type.title, marginBottom: spacing.sm },
  title: { ...type.h1, textAlign: 'center' },
  body: { ...type.small, textAlign: 'center' },
  button: { minWidth: 160, marginTop: spacing.sm },
});
