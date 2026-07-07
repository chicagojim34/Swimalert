import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import EventSource from 'react-native-sse';
import { api, estimateClockOffset, SERVER_URL } from '../api';

const DEVICE_ID = `phone-${Math.random().toString(36).slice(2, 10)}`;
const POST_ROLL_MS = 4000;

/**
 * Turns this phone into the camera for one lane.
 *
 * Recording strategy: start rolling as soon as a heat goes current (that
 * buys the pre-roll — blocks, dive, the whole start), stop POST_ROLL_MS
 * after our lane's touch, then report the clip window to the server. The
 * clock offset from timesync means the reported window lines up with every
 * other camera and the horn/touch timestamps.
 */
export function LaneCameraScreen({ meetId }: { meetId: string }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [lane, setLane] = useState<number | null>(null);
  const [status, setStatus] = useState('Pick a lane to start');
  const [recording, setRecording] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const offsetRef = useRef(0);
  const raceRef = useRef<{ eventNumber: number; heatNumber: number } | null>(null);
  const recordingStartServerTs = useRef(0);

  const serverNow = () => Date.now() + offsetRef.current;

  const assignLane = async (n: number) => {
    setStatus('Syncing clock…');
    offsetRef.current = await estimateClockOffset();
    await api.registerCamera(DEVICE_ID, meetId, n, offsetRef.current);
    setLane(n);
    setStatus(`Lane ${n} camera ready (clock offset ${offsetRef.current.toFixed(0)}ms)`);
  };

  const startRecording = async () => {
    if (recording || !cameraRef.current) return;
    setRecording(true);
    recordingStartServerTs.current = serverNow();
    // recordAsync resolves when stopRecording() is called.
    cameraRef.current.recordAsync().then(async (video) => {
      setRecording(false);
      const race = raceRef.current;
      if (!video?.uri || !race || lane === null) return;
      // Ask the server for the ideal horn->touch window; report our clip.
      try {
        const w = await api.clipWindow(meetId, race.eventNumber, race.heatNumber, lane);
        await api.reportClip({
          meetId,
          eventNumber: race.eventNumber,
          heatNumber: race.heatNumber,
          lane,
          deviceId: DEVICE_ID,
          startTs: Math.max(w.startTs, recordingStartServerTs.current),
          endTs: w.endTs,
          uri: video.uri,
        });
        setStatus(`Clip saved for E${race.eventNumber} H${race.heatNumber}`);
      } catch (e) {
        setStatus(`Clip recorded but not reported: ${e}`);
      }
    });
  };

  const stopRecording = () => cameraRef.current?.stopRecording();

  useEffect(() => {
    if (lane === null) return;
    const es = new EventSource(`${SERVER_URL}/meets/${meetId}/stream`);

    // A new heat is behind the blocks: start rolling for pre-roll coverage.
    es.addEventListener('position' as any, (e: any) => {
      const data = JSON.parse(e.data);
      if (data.current) {
        raceRef.current = { eventNumber: data.current.eventNumber, heatNumber: data.current.heatNumber };
        setStatus(`E${data.current.eventNumber} H${data.current.heatNumber} up — rolling`);
        startRecording();
      }
    });

    es.addEventListener('horn' as any, (e: any) => {
      const data = JSON.parse(e.data);
      raceRef.current = { eventNumber: data.eventNumber, heatNumber: data.heatNumber };
      startRecording(); // belt and braces if we missed the position event
      setStatus(`Horn! E${data.eventNumber} H${data.heatNumber}`);
    });

    // Our lane touched: keep a little celebration, then cut the clip.
    es.addEventListener('touch' as any, (e: any) => {
      const data = JSON.parse(e.data);
      if (data.lane === lane) {
        setStatus(data.unofficial ? `Touch! ${data.unofficial} (unofficial)` : 'Touch!');
        setTimeout(stopRecording, POST_ROLL_MS);
      }
    });

    return () => es.close();
  }, [lane, meetId]);

  if (!permission?.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.status}>Camera permission needed</Text>
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant camera access</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={styles.camera} mode="video" />
      <View style={styles.overlay}>
        <Text style={styles.status}>{status}</Text>
        {recording && <Text style={styles.rec}>● REC</Text>}
        {lane === null && (
          <View style={styles.laneRow}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <Pressable key={n} style={styles.laneButton} onPress={() => assignLane(n)}>
                <Text style={styles.laneText}>{n}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  camera: { flex: 1 },
  overlay: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, backgroundColor: '#000a' },
  status: { color: '#fff', fontSize: 16, fontWeight: '600' },
  rec: { color: '#f33', fontWeight: '800', marginTop: 4 },
  laneRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  laneButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1a73e8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  laneText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  button: { backgroundColor: '#1a73e8', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: '#fff', fontWeight: '700' },
});
