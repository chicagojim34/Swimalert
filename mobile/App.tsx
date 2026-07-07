import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { FollowScreen } from './src/screens/FollowScreen';
import { HeatBoardScreen } from './src/screens/HeatBoardScreen';
import { LaneCameraScreen } from './src/screens/LaneCameraScreen';
import { MeetListScreen } from './src/screens/MeetListScreen';

type Tab = 'meets' | 'follow' | 'board' | 'camera';

export default function App() {
  const [tab, setTab] = useState<Tab>('meets');
  const [meetId, setMeetId] = useState<string | null>(null);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      <View style={styles.content}>
        {tab === 'meets' && (
          <MeetListScreen
            onSelect={(id) => {
              setMeetId(id);
              setTab('board');
            }}
          />
        )}
        {tab === 'follow' && <FollowScreen />}
        {tab === 'board' &&
          (meetId ? <HeatBoardScreen meetId={meetId} /> : <Centered text="Pick a meet first" />)}
        {tab === 'camera' &&
          (meetId ? <LaneCameraScreen meetId={meetId} /> : <Centered text="Pick a meet first" />)}
      </View>
      <View style={styles.tabBar}>
        {(
          [
            ['meets', 'Meets'],
            ['follow', 'Follow'],
            ['board', 'Live'],
            ['camera', 'Camera'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <Pressable key={key} style={styles.tab} onPress={() => setTab(key)}>
            <Text style={[styles.tabText, tab === key && styles.tabActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

function Centered({ text }: { text: string }) {
  return (
    <View style={styles.center}>
      <Text style={{ color: '#556' }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#eee' },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabText: { color: '#889', fontWeight: '600' },
  tabActive: { color: '#1a73e8' },
});
