import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';

interface MeetSummary {
  id: string;
  name: string;
  date?: string;
  heatCount: number;
  currentHeatIndex: number;
}

export function MeetListScreen({ onSelect }: { onSelect: (meetId: string) => void }) {
  const [meets, setMeets] = useState<MeetSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setRefreshing(true);
    try {
      setMeets(await api.listMeets());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Meets</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={meets}
        keyExtractor={(m) => m.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => onSelect(item.id)}>
            <Text style={styles.meetName}>{item.name}</Text>
            <Text style={styles.meta}>
              {item.date ?? ''} · {item.heatCount} heats ·{' '}
              {item.currentHeatIndex < 0
                ? 'not started'
                : item.currentHeatIndex >= item.heatCount
                  ? 'finished'
                  : `heat ${item.currentHeatIndex + 1} of ${item.heatCount}`}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.meta}>No meets yet — pull to refresh.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 12 },
  card: { padding: 16, borderRadius: 12, backgroundColor: '#e8f4fd', marginBottom: 10 },
  meetName: { fontSize: 18, fontWeight: '600' },
  meta: { color: '#556', marginTop: 4 },
  error: { color: '#c00', marginBottom: 8 },
});
