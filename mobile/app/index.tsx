import { StyleSheet, Text, View } from 'react-native';

export default function IndexScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>AI 阅读助手</Text>
      <Text style={styles.subtitle}>M0-A 核心逻辑已就绪</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#111111',
  },
  subtitle: {
    fontSize: 14,
    color: '#666666',
  },
});
