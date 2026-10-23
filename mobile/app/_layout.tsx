import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors } from '../src/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
        <Stack.Screen name="reader/[bookId]" options={{ headerShown: false }} />
        <Stack.Screen
          name="book/[bookId]"
          options={{
            headerShown: true,
            title: '书籍详情',
            headerStyle: { backgroundColor: colors.card },
            headerTintColor: colors.text,
            headerShadowVisible: false,
            headerTitleStyle: { fontSize: 17, fontWeight: '600', color: colors.text },
          }}
        />
        <Stack.Screen
          name="chat/[conversationId]"
          options={{
            headerShown: true,
            title: '对话',
            headerStyle: { backgroundColor: colors.card },
            headerTintColor: colors.text,
            headerShadowVisible: false,
            headerTitleStyle: { fontSize: 17, fontWeight: '600', color: colors.text },
          }}
        />
        <Stack.Screen
          name="search/[bookId]"
          options={{
            headerShown: true,
            title: '全书搜索',
            headerStyle: { backgroundColor: colors.card },
            headerTintColor: colors.text,
            headerShadowVisible: false,
            headerTitleStyle: { fontSize: 17, fontWeight: '600', color: colors.text },
          }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}
