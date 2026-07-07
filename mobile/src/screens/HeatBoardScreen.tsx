import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import EventSource from 'react-native-sse';
import { api, SERVER_URL } from '../api';

interface CurrentHeat {
  eventNumber: number;
  eventName: string;
  heatNumber: number;
}

/** Live "who's behind the blocks" board, driven by the meet's SSE stream. */
export function HeatBoardScreen({ meetId }: { meetId: string }) {
  const [current, setCurrent] = useState<CurrentHeat | null>(null);
  const [lastTouch, setLastTouch] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    api.getMeet(meetId).then((m) => setCurrent(m.current ?? null));

    const es = new EventSource(`${SERVER_URL}/meets/${meetId}/stream`);
    esRef.current = es;
    es.addEventListener('position' as any, (e: any) => {
      const data = JSON.parse(e.data);
      setCurrent(data.current ?? null);
    });
    es.addEventListener('touch' as any, (e: any) => {
      const data = JSON.parse(e.data);
      if (data.unofficial) setLastTouch(`Lane ${data.lane} — ${data.unofficial} (unofficial)`);
    });
    return () => es.close();
  }, [meetId]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Now swimming</Text>
      {current ? (
        <View style={styles.card}>
          <Text style={styles.eventName}>
            Event {current.eventNumber}: {current.eventName}
          </Text>
          <Text style={styles.heat}>Heat {current.heatNumber}</Text>
        </View>
      ) : (
        <Text style={styles.meta}>Meet hasn't started (or is finished).</Text>
      )}
      {lastTouch && <Text style={styles.touch}>{lastTouch}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 12 },
  card: { padding: 20, borderRadius: 14, backgroundColor: '#e8f4fd' },
  eventName: { fontSize: 20, fontWeight: '600' },
  heat: { fontSize: 34, fontWeight: '800', marginTop: 6, color: '#1a73e8' },
  meta: { color: '#556' },
  touch: { marginTop: 16, fontSize: 16, color: '#0a7d33', fontWeight: '600' },
});
