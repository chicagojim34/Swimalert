import { ConsolePushSender, ExpoPushSender } from './alerts.js';
import { createApp } from './app.js';
import { Store } from './store.js';

const port = Number(process.env.PORT ?? 4000);
const dataFile = process.env.DATA_FILE ?? 'data/swimalert.json';
const pushSender = process.env.EXPO_PUSH === '1' ? new ExpoPushSender() : new ConsolePushSender();

const mediaDir = process.env.MEDIA_DIR ?? 'data/media';
const { server } = createApp(new Store(dataFile), pushSender, { mediaDir });

server.listen(port, () => {
  console.log(`Swimalert server listening on http://localhost:${port}`);
  console.log(`Data file: ${dataFile}`);
  console.log(
    process.env.EXPO_PUSH === '1'
      ? 'Push: Expo push API'
      : 'Push: console only (set EXPO_PUSH=1 for real notifications)',
  );
});
