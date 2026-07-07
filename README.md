# Swimalert

**GameChanger for swimming.** Parents get a push notification a configurable number of races
before their swimmer is up, every lane gets its own synchronized camera (an iPhone on the
fence or a real camera on a tripod), and each race produces a shareable clip with an
unofficial time that starts at the horn and stops at the touch.

Built from three ideas:

1. **Push notifications to parents' phones X races before their kids are up** — follow a
   swimmer, pick a threshold (e.g. 3 races), and get pinged with event/heat/lane as the
   meet progresses. No more hovering at the bullpen for 4 hours.
2. **Lane-specific cameras that track swimmers** — one camera per lane, all synchronized to
   a common clock so multi-angle stitching and digital zoom are possible later.
3. **GameChanger-style clips and unofficial timing** — the clip window and the stopwatch
   both run horn → touch, with pre-roll (the start) and post-roll (the celebration).

## What's here

```
server/          TypeScript backend — the brain (fully tested, zero runtime deps)
server/public/   Deck console — zero-install web UI for running the meet
mobile/          Expo (React Native) app — parent alerts + iPhone lane camera
capture-agent/   Node agent for MTP/PTP cameras (gphoto2) on a laptop "capture station"
```

### `server/` — meet engine, alerts, timing, camera sync

* **Meet program model** — events → heats → lane entries, imported as JSON or CSV.
  A deck operator advances the current heat (`POST /meets/:id/advance`) or jumps around
  (`POST /meets/:id/position`) as the meet actually runs.
* **CSV heat-sheet import** (`src/heatsheet.ts`) — `POST /meets/import/csv?name=...` with a
  flat "one row per entry" CSV (`Event, Event Name, Heat, Lane, Swimmer, Team, Seed, Age`;
  common header aliases accepted). Anything Meet Manager or a spreadsheet can export works.
* **Deck console** (`public/deck.html`) — open `http://<server>:4000/` on any laptop or
  tablet at the pool: import a CSV, advance heats, fire the horn, tap touches per lane,
  and watch unofficial times and parent-alert counts stream in live. No install, no build.
* **Alert engine** (`src/alerts.ts`) — on every heat change, computes how many races away
  each followed swimmer is and pushes when they cross the follow's threshold. Deduped per
  entry, supports multiple parents per swimmer. Ships with an Expo push sender
  (`EXPO_PUSH=1`) and a console sender for dev.
* **Unofficial timing** (`src/timing.ts`) — horn timestamp + per-lane touch timestamps →
  elapsed time formatted swim-style (`1:05.32`). Explicitly *unofficial*: it's for clips
  and bragging rights, not results.
* **Clock sync** (`src/timesync.ts`) — NTP-style offset estimation so every camera converts
  its local clock to server time. That's what makes "synchronized recording" real: a clip
  trimmed on any device lines up with the horn, the touch, and every other camera.
* **Live stream** — `GET /meets/:id/stream` is a Server-Sent Events feed of
  `position` / `horn` / `touch` / `clip` events. Cameras use it to auto-start when a heat
  goes up and auto-stop after their lane touches.
* **Clip registry** — cameras report finished clips (`POST /clips`); the server attaches
  the swimmer in that lane and the unofficial time.

```bash
npm install
npm run dev          # server on http://localhost:4000
npm run seed -w server   # load a demo meet
npm test             # 24 tests: domain, alerts, timing, timesync, full HTTP + SSE flow
```

Storage is an in-memory store persisted to a JSON file (`DATA_FILE`) — deliberately
dependency-free for v0. Swap `server/src/store.ts` for Postgres when it's time.

### `mobile/` — one app, two jobs

* **Parent mode** — browse meets, search + follow swimmers, choose "alert me N races
  before", watch the live heat board.
* **Lane camera mode** — pick your lane, the phone timesyncs and registers as that lane's
  camera, then records automatically: starts rolling when a heat goes behind the blocks
  (pre-roll), cuts a few seconds after your lane's touch, and reports the clip window
  back to the server.

```bash
cd mobile && npm install && npx expo start
```

Set `SERVER_URL` in `mobile/src/api.ts` to the server's LAN address at the pool.
(The scaffold is code-complete but hasn't been built on-device yet — expect the usual
Expo version alignment when you first run it.)

### `capture-agent/` — real cameras via MTP/PTP

For lanes covered by a camcorder/DSLR instead of a phone: a laptop runs the agent with
the camera on USB, and [gphoto2](http://gphoto.org/) does the capture.

```bash
node capture-agent/agent.mjs --server http://localhost:4000 --meet <meetId> --lane 4
```

Same protocol as the phone: timesync → register on a lane → listen to the SSE stream →
record horn-to-touch → report the clip. Runs in dry-run mode without gphoto2 so you can
test the plumbing anywhere.

## Try a full meet day in 60 seconds

```bash
npm install && npm run dev              # terminal 1
npm run seed -w server                  # terminal 2 — prints MEET_ID
node capture-agent/agent.mjs --server http://localhost:4000 --meet $MEET_ID --lane 3   # terminal 3

# terminal 2: run the meet
curl -X POST localhost:4000/meets/$MEET_ID/advance                       # heat up -> alerts fire
curl -X POST localhost:4000/meets/$MEET_ID/events/1/heats/1/horn -d '{}' # horn -> cameras roll
curl -X POST localhost:4000/meets/$MEET_ID/events/1/heats/1/touch \
     -H 'content-type: application/json' -d '{"lane":3}'                 # touch -> time + clip
curl localhost:4000/meets/$MEET_ID/clips
```

## Where this goes next

* **Native heat-sheet formats** — parse Hy-Tek HY3/SDIF exports directly, beyond CSV.
* **Horn detection** — detect the strobe/horn from the camera's own A/V instead of a manual
  tap, so timing needs zero deck cooperation.
* **Touch detection** — computer vision on the lane camera for the wall touch (the manual
  tap works today, like GameChanger's scorekeeper role).
* **Multi-camera stitching** — the synchronized clocks already make cross-camera cuts
  possible; add an end-of-pool camera and pick the best view per race segment.
* **Clip upload + sharing** — clips currently live on the capture device; add blob storage
  upload and family sharing links.
* **Auth + teams** — accounts, rosters, and permissions before real meets.
