import React, { useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '../api';
import { getPushToken } from '../notifications';

interface Swimmer {
  id: string;
  name: string;
  team?: string;
}

/** Search for your swimmer and choose how many races of warning you want. */
export function FollowScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Swimmer[]>([]);
  const [racesBefore, setRacesBefore] = useState(3);

  const search = async (q: string) => {
    setQuery(q);
    if (q.length < 2) return setResults([]);
    setResults(await api.searchSwimmers(q));
  };

  const followSwimmer = async (swimmer: Swimmer) => {
    const token = await getPushToken();
    if (!token) {
      Alert.alert('Notifications disabled', 'Enable notifications to get race alerts.');
      return;
    }
    await api.follow(swimmer.id, token, racesBefore);
    Alert.alert('Following!', `You'll get a push when ${swimmer.name} is ${racesBefore} races away.`);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Follow a swimmer</Text>
      <TextInput
        style={styles.input}
        placeholder="Swimmer name…"
        value={query}
        onChangeText={search}
        autoCorrect={false}
      />
      <View style={styles.thresholdRow}>
        <Text style={styles.label}>Alert me</Text>
        {[1, 2, 3, 5].map((n) => (
          <Pressable
            key={n}
            style={[styles.chip, racesBefore === n && styles.chipActive]}
            onPress={() => setRacesBefore(n)}
          >
            <Text style={racesBefore === n ? styles.chipTextActive : styles.chipText}>{n}</Text>
          </Pressable>
        ))}
        <Text style={styles.label}>races before</Text>
      </View>
      <FlatList
        data={results}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => followSwimmer(item)}>
            <Text style={styles.swimmerName}>{item.name}</Text>
            {item.team && <Text style={styles.meta}>{item.team}</Text>}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#ccd', borderRadius: 10, padding: 12, fontSize: 16 },
  thresholdRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 12, gap: 8 },
  label: { color: '#556' },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#eef' },
  chipActive: { backgroundColor: '#1a73e8' },
  chipText: { color: '#334' },
  chipTextActive: { color: '#fff', fontWeight: '700' },
  card: { padding: 14, borderRadius: 10, backgroundColor: '#e8f4fd', marginBottom: 8 },
  swimmerName: { fontSize: 17, fontWeight: '600' },
  meta: { color: '#556', marginTop: 2 },
});
