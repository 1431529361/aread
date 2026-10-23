import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BookRecord } from '../../src/db/repositories/books';
import { getBook } from '../../src/db/repositories/books';
import {
  appendMessage,
  getConversation,
  listMessages,
  type ConversationRecord,
  type MessageRecord,
} from '../../src/db/repositories/conversations';
import { getDatabase } from '../../src/db/client';
import {
  ChatNotConfiguredError,
  sendBookChat,
} from '../../src/services/chat';
import type { Evidence } from '../../src/core/types';
import type { AgentEvent } from '../../src/core/agent/loop';
import { Button, EmptyState } from '../../src/components/ui';
import { goBackOrLibrary, openReader, openSettings } from '../../src/navigation/routes';
import { firstParam } from '../../src/utils/params';
import { colors, radius, spacing, type } from '../../src/theme';

function splitUserContent(content: string): { quote: string | null; question: string } {
  const match = content.match(/^选中的文本：\n"([\s\S]*?)"\n\n问题：([\s\S]*)$/);
  if (match) return { quote: match[1], question: match[2] };
  return { quote: null, question: content };
}

function RichAssistantText({
  content,
  citations,
  onJump,
}: {
  content: string;
  citations: Evidence[] | null;
  onJump: (evidence: Evidence) => void;
}) {
  const byId = new Map<number, Evidence>();
  for (const evidence of citations ?? []) byId.set(evidence.citationId, evidence);
  const parts = content.split(/(\[\d+\])/g);
  return (
    <Text style={styles.assistantText}>
      {parts.map((part, index) => {
        const match = /^\[(\d+)\]$/.exec(part);
        const evidence = match ? byId.get(Number(match[1])) : undefined;
        if (evidence) {
          return (
            <Text
              key={`${part}-${index}`}
              style={styles.inlineCitation}
              onPress={() => onJump(evidence)}
            >
              {part}
            </Text>
          );
        }
        return part;
      })}
    </Text>
  );
}

function CitationCard({
  evidence,
  onPress,
}: {
  evidence: Evidence;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.citationCard, pressed && styles.pressed]}
    >
      <Text style={styles.citationLabel} numberOfLines={1}>
        [{evidence.citationId}] {evidence.hit.chapter || '正文'} · 跳到原文 ›
      </Text>
      <Text style={styles.citationText} numberOfLines={3}>
        {evidence.hit.text}
      </Text>
    </Pressable>
  );
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{
    conversationId: string;
    bookId: string;
    selectedText?: string;
  }>();
  const conversationId = firstParam(params.conversationId);
  const bookId = firstParam(params.bookId);
  const insets = useSafeAreaInsets();

  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [book, setBook] = useState<BookRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState<string | null>(
    firstParam(params.selectedText) || null,
  );
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const db = getDatabase();
      const found = await getConversation(db, {
        userId: 'local',
        conversationId,
      });
      if (!found) {
        setError('会话不存在或已被删除');
        return;
      }
      const [bookRecord, list] = await Promise.all([
        found.bookId ? getBook(db, { userId: 'local', bookId: found.bookId }) : null,
        listMessages(db, conversationId),
      ]);
      setConversation(found);
      setBook(bookRecord);
      setMessages(list);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'pre_retrieval':
        setStatus(
          event.evidence.length > 0
            ? `已从原文检索到 ${event.evidence.length} 段证据`
            : '没有检索到直接证据，正在分析',
        );
        break;
      case 'tool_call':
        setStatus(`正在使用 ${event.name} 查找原文…`);
        break;
      case 'tool_result':
        setStatus('已获取工具结果，继续分析…');
        break;
      case 'final_start':
        setStatus('正在生成回答…');
        break;
      case 'fallback':
        setStatus(`已降级：${event.reason}`);
        break;
      case 'citation_check':
        setStatus(null);
        break;
      default:
        break;
    }
  }

  async function handleSend(): Promise<void> {
    const question = input.trim();
    if (!question || sending || !conversation) return;

    const controller = new AbortController();
    abortRef.current = controller;
    let partial = '';

    setSending(true);
    setError(null);
    setNotConfigured(false);
    setStatus('准备检索原文…');
    setStreaming('');
    setPendingUser(question);
    setInput('');

    try {
      const db = getDatabase();
      const result = await sendBookChat({
        db,
        conversationId,
        bookId,
        question,
        selectedText: quote,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'chunk') {
            partial += event.content;
            setStreaming(partial);
            setStatus(null);
            return;
          }
          handleEvent(event);
        },
      });

      setMessages((current) => [
        ...current,
        result.userMessage,
        result.assistantMessage,
      ]);
      setPendingUser(null);
      setStreaming('');
      setQuote(null);
      const refreshed = await getConversation(db, {
        userId: 'local',
        conversationId,
      });
      if (refreshed) setConversation(refreshed);
    } catch (caught) {
      if (controller.signal.aborted) {
        setStatus('已停止生成');
        if (partial.trim()) {
          try {
            const db = getDatabase();
            await appendMessage(db, {
              conversationId,
              role: 'assistant',
              content: partial,
            });
            const list = await listMessages(db, conversationId);
            setMessages(list);
          } catch {
            // 停止时保存失败不影响界面
          }
        }
        setPendingUser(null);
        setStreaming('');
      } else {
        if (caught instanceof ChatNotConfiguredError) {
          setNotConfigured(true);
        }
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus(null);
        setPendingUser(null);
        setInput(question);
        try {
          const db = getDatabase();
          const list = await listMessages(db, conversationId);
          setMessages(list);
        } catch {
          // 忽略刷新失败
        }
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }

  function handleStop(): void {
    abortRef.current?.abort();
  }

  function handleJump(evidence: Evidence): void {
    openReader(bookId, evidence.hit.loc, { flash: true });
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!conversation) {
    return (
      <View style={styles.center}>
        <EmptyState
          title="找不到这个会话"
          body={error ?? undefined}
          action={<Button title="返回" onPress={goBackOrLibrary} />}
        />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: conversation.title }} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <SafeAreaView style={styles.safe} edges={['bottom']}>
          <View style={styles.contextBar}>
            <Text style={styles.contextText} numberOfLines={1}>
              {book ? `《${book.title}》` : '本书'} · 仅基于原文回答
            </Text>
          </View>

          <ScrollView
            ref={scrollRef}
            style={styles.messages}
            contentContainerStyle={styles.messagesContent}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() =>
              scrollRef.current?.scrollToEnd({ animated: true })
            }
          >
            {messages.length === 0 && !pendingUser ? (
              <View style={styles.intro}>
                <Text style={styles.introTitle}>关于这本书，问点什么？</Text>
                <Text style={styles.introBody}>
                  回答会附上原文引用，点击 [Cn] 或引用卡片即可跳回对应段落。
                </Text>
                {quote ? (
                  <Text style={styles.introQuote}>已选中：“{quote.slice(0, 80)}…”</Text>
                ) : null}
              </View>
            ) : null}

            {messages.map((message) => {
              if (message.role !== 'user' && message.role !== 'assistant') return null;
              if (message.role === 'user') {
                const parsed = splitUserContent(message.content);
                return (
                  <View key={`m-${message.id}`} style={styles.userRow}>
                    <View style={styles.userBubble}>
                      {parsed.quote ? (
                        <View style={styles.quoteBubble}>
                          <Text style={styles.quoteText} numberOfLines={4}>
                            {parsed.quote}
                          </Text>
                        </View>
                      ) : null}
                      <Text style={styles.userText}>{parsed.question}</Text>
                    </View>
                  </View>
                );
              }
              return (
                <View key={`m-${message.id}`} style={styles.assistantRow}>
                  <View style={styles.assistantBubble}>
                    <RichAssistantText
                      content={message.content}
                      citations={message.citations}
                      onJump={handleJump}
                    />
                    {message.citations && message.citations.length > 0 ? (
                      <View style={styles.citations}>
                        {message.citations.map((evidence) => (
                          <CitationCard
                            key={`c-${message.id}-${evidence.citationId}`}
                            evidence={evidence}
                            onPress={() => handleJump(evidence)}
                          />
                        ))}
                      </View>
                    ) : null}
                  </View>
                </View>
              );
            })}

            {pendingUser ? (
              <View style={styles.userRow}>
                <View style={styles.userBubble}>
                  {quote ? (
                    <View style={styles.quoteBubble}>
                      <Text style={styles.quoteText} numberOfLines={4}>
                        {quote}
                      </Text>
                    </View>
                  ) : null}
                  <Text style={styles.userText}>{pendingUser}</Text>
                </View>
              </View>
            ) : null}

            {sending && streaming ? (
              <View style={styles.assistantRow}>
                <View style={styles.assistantBubble}>
                  <RichAssistantText
                    content={`${streaming}▍`}
                    citations={null}
                    onJump={handleJump}
                  />
                </View>
              </View>
            ) : null}

            {sending && !streaming ? (
              <View style={styles.thinkingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.thinkingText}>{status ?? '正在思考…'}</Text>
              </View>
            ) : null}

            {sending && streaming && status ? (
              <Text style={styles.statusText}>{status}</Text>
            ) : null}

            {notConfigured ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>尚未配置对话模型</Text>
                <Text style={styles.errorBody}>
                  填写 Base URL、API Key 与模型后即可提问。书籍阅读、搜索与划线不受影响。
                </Text>
                <Button title="去设置" small variant="secondary" onPress={openSettings} />
              </View>
            ) : null}

            {error && !notConfigured ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>这次回答没有完成</Text>
                <Text style={styles.errorBody}>{error}</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {quote ? (
              <View style={styles.quoteChip}>
                <Text style={styles.quoteChipText} numberOfLines={2}>
                  引用：{quote}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setQuote(null)}
                  hitSlop={8}
                  style={styles.quoteClose}
                >
                  <Text style={styles.quoteCloseText}>×</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.inputRow}>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={sending ? '正在回答…' : '针对这本书提问'}
                placeholderTextColor={colors.textFaint}
                style={styles.input}
                multiline
                editable={!sending}
                maxLength={4000}
              />
              <Button
                title={sending ? '停止' : '发送'}
                variant={sending ? 'danger' : 'primary'}
                onPress={sending ? handleStop : () => void handleSend()}
                disabled={!sending && (!input.trim() || !book)}
                style={styles.sendButton}
              />
            </View>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: spacing.xl,
  },
  contextBar: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    backgroundColor: colors.cardAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  contextText: { ...type.tiny, color: colors.textMuted },
  messages: { flex: 1 },
  messagesContent: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  intro: { gap: spacing.sm, paddingVertical: spacing.xl },
  introTitle: { ...type.h1 },
  introBody: { ...type.small },
  introQuote: { ...type.small, color: colors.primary },
  userRow: { alignItems: 'flex-end' },
  userBubble: {
    maxWidth: '86%',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    gap: 6,
  },
  userText: { ...type.body, color: colors.text },
  quoteBubble: {
    borderLeftWidth: 2,
    borderLeftColor: colors.primary,
    paddingLeft: spacing.sm,
  },
  quoteText: { ...type.small, color: colors.textMuted },
  assistantRow: { alignItems: 'flex-start' },
  assistantBubble: {
    maxWidth: '94%',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderBottomLeftRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    gap: spacing.sm,
  },
  assistantText: { ...type.body },
  inlineCitation: { color: colors.primary, fontWeight: '700' },
  citations: { gap: spacing.sm },
  citationCard: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: 3,
  },
  citationLabel: { ...type.tiny, color: colors.primary, fontWeight: '700' },
  citationText: { ...type.tiny, color: colors.textMuted },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  thinkingText: { ...type.small },
  statusText: { ...type.tiny, color: colors.textMuted, paddingLeft: spacing.sm },
  errorCard: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  errorTitle: { ...type.small, color: colors.danger, fontWeight: '700' },
  errorBody: { ...type.small, color: colors.text },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  quoteChip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  quoteChipText: { ...type.tiny, flex: 1, color: colors.textMuted },
  quoteClose: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quoteCloseText: { fontSize: 18, color: colors.textMuted, lineHeight: 20 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.md,
    paddingTop: 10,
    paddingBottom: 10,
    color: colors.text,
    fontSize: 15,
  },
  sendButton: { minWidth: 72 },
  pressed: { opacity: 0.7 },
});
