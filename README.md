# Field Reports

A React Native app for filing photo reports from a site with almost no signal.
One inspector, a description, one to five photographs, and a connection that
keeps dying. The work still has to arrive — exactly once.

```bash
npm install
cd server && npm install && cd ..

npm run server      # terminal 1 — backend + control panel on :4000
npm start           # terminal 2 — Metro
npm run android     # terminal 3 — build and install (emulator or device)
```

Verified on an Android 16 emulator (Pixel 9 Pro XL, API 37) with React Native
0.88.1, JDK 17, Node 24.

---

## The short version

**The guarantee.** Once *Submit* returns, the report is on disk and will reach
the server exactly once, with no further input from the user — across
force-quits, dropped connections, lost responses and days with no signal.

**How it holds.**

| Requirement | Mechanism |
| --- | --- |
| Nothing is lost | `enqueue()` persists before it resolves; every state change is written as it happens; records left mid-flight by a kill are requeued on launch |
| Nothing lands twice | Ids are minted on the device **before** the first attempt and reused by every retry; the server keys on them |
| Progress on a bad link | One image per request, each committed to disk, so a connection that dies on image four keeps images one to three |
| Only the right things retried | Transport and server faults back off and retry; a verdict about the payload (4xx, 413) is never retried |
| Offline is not a failure | No attempt spent, no backoff; photos are still compressed so bytes are ready the moment a signal appears |

**Prove it without a phone:**

```bash
npm run harness -- --reports 3 --images 2 --mb 18 --gauntlet
```

That runs the real queue in Node against the real backend while the server is
cycled through dropped connections, 500s, lost responses and a throttled link,
then checks the **server's** view: report count, duplicate ids, every image
under the ceiling. A recorded run: 23 upload attempts for 6 images, 1
de-duplicated by the server, 3 reports delivered exactly once.

---

## How to make it fail

The backend ships with a control panel at **http://localhost:4000** — buttons
for every failure mode, a live request log, and the reports it holds.

| Mode | What it does | What to watch for in the app |
| --- | --- | --- |
| `slow` | Throttles to the configured kbps | Keeps making progress; per-image percentage keeps moving |
| `error500` | 500 after reading the body | "Retrying" with the reason and a live countdown |
| `refuse` | 400 after reading the body | Goes to **Needs you** and *stops*. One attempt, not a loop |
| `hang` | **Stores the upload, then never answers** | Idle watchdog fires, retries, server says `duplicate` — one copy |
| `drop` | Destroys the connection before committing | Retries from scratch; nothing partial anywhere |
| `flaky` | Random mix per request | Survives a long unattended run |

For a faithful 2G test, throttle the emulator itself — it shapes the virtual
NIC, which no server-side trick can:

```bash
adb emu network speed gsm      # ~14 kbps up. also: edge, umts, full
adb emu network delay gprs
```

Airplane mode: `adb emu power ac off` then the quick settings tile, or just
toggle it in the emulator UI.

### The main scenario, step by step

1. Control panel → `off`. Settings tab → check the backend URL is reachable.
2. Turn on airplane mode.
3. Compose three reports, one with five photos. Note that **Submit returns
   instantly** and the list says *Saved on device*, never "sent".
4. Watch the photos compress while still offline — the queue does local work
   during an outage so the bytes are ready in advance.
5. Force-quit from the app switcher. Reopen. Everything is still there, and
   anything caught mid-flight has been requeued.
6. Control panel → `slow`, 256 kbps. Turn airplane mode off.
7. Mid-upload, hit `drop` twice, then `hang` once, then `off`.
8. All three reports land. The **On the server** tab fetches from the server,
   not from local state. The control panel log shows the de-duplicated
   retries: that is the exactly-once evidence.

---

## Decisions, and why

### Ids are minted before the first attempt

This is the whole design, and everything else follows from it.

A client cannot distinguish "the server never got it" from "the server got it
and the response was lost". Both look like a failed request. Retrying is
therefore mandatory (or work is lost) and dangerous (or work is duplicated) —
unless the retry is recognisable as the *same* work.

So every image and every report carries an id generated on the device and
persisted *before* the first byte goes out. `POST /v1/uploads` and
`POST /v1/reports` both take it as `Idempotency-Key`. A replay returns the
original record with `duplicate: true` rather than storing a second copy. At-
least-once on the wire adds up to exactly-once at rest.

The ordering matters more than the id format: an id generated at send time, or
not persisted until after a response, would not survive the very case it
exists for. `hang` mode in the control panel reproduces exactly that case.

### Two phases, image-at-a-time

Images upload individually, then a tiny JSON commit files the report. Three
consequences:

- A dead connection costs at most one image, not the whole report. On 2G that
  is the difference between finishing and never finishing.
- The commit is small, so the window where a response can be lost is small.
- The server can reject a report whose images have not all arrived (`409`),
  which the client treats as retryable — the uploads are still coming.

Sequential, not parallel: on a 2G link, parallel uploads fight each other for
the same scrap of bandwidth and make the progress display meaningless.

### Retry only what retrying can fix

`errors.ts` classifies every failure into retryable or not:

- **Retryable** — network errors, timeouts, 5xx, 408, 425, 429, and 409.
- **Not retryable** — 4xx generally, and 413 especially. These are verdicts
  about the payload. The same bytes will be refused forever, and a queue that
  keeps trying is a queue that never drains and a battery that never recovers.

A non-retryable failure moves the report to **Needs you** with the server's
own message and a Retry button. Nothing is deleted.

There is also an attempt budget (12). Retrying forever is not the same as
never losing anything: past a few hours of failure something is wrong that
another attempt will not fix, and the honest thing is to say so rather than
leave a report sitting in "waiting" indefinitely.

### Being offline is not a failure

It burns no attempt and triggers no backoff — otherwise a day underground
would exhaust the budget and block everything. The worker parks and the
connectivity listener wakes it.

`NetInfoMonitor` keys on `isConnected` and deliberately **ignores**
`isInternetReachable`, which is null before the first probe and false behind
captive portals and on very slow links — exactly the conditions this app is
built for. The upload attempt is the honest probe.

### An idle timeout, not a total one

The upload transport uses `XMLHttpRequest` rather than `fetch`, because React
Native only exposes upload progress there. Progress is what makes the timeout
policy possible: there is **no total timeout**, only a 45-second *idle* one.

A 1.4 MB image on a 20 kbps link legitimately takes ten minutes. Any total
timeout short enough to catch a dead connection would also kill that upload
every single time. "Slow is fine, stopped is not" is a statement about
progress, so progress is what is measured.

### The 5 MB ceiling is a search, not a setting

A fixed quality satisfies neither "never send one over it" nor "still worth
looking at" — an 18 MB wide-angle shot of a dim stairwell and a 6 MB close-up
of a weld compress completely differently.

The first pass resizes to 2560 px at q88. If that misses, the measured result
tells us how far to scale down (JPEG size tracks pixel count, so
`sqrt(target/actual)` is a good estimate) rather than creeping down a quality
ladder. Most photos need one or two passes; five is the hard stop.

Resolution is spent before quality: 2560 px at q76 is far more readable than
4032 px at q35, and the detail in the frame is the point of the photograph.
Measured on the emulator: **21.2 MB / 4032×3024 → 1.1 MB / 2560×1920**.

It runs in the native module, off the JS thread. The server enforces the same
ceiling and returns 413 — not because the server needs protecting, but so a
regression in compression fails loudly instead of silently shipping a 20 MB
file. That 413 is non-retryable and surfaces as a bug report to the user.

EXIF is stripped: the pixels are already rotated upright, so there is no
orientation to misread, and GPS has no business leaving the device. If capture
time mattered to the business, it would be sent as a field instead.

### Storage does not grow forever

The original is deleted once the compressed copy exists — holding five 18 MB
photos per report would fill a phone long before a backlog drained. The upload
copy is deleted once the server confirms. A 320 px thumbnail is kept so the
local history still renders, and so no list ever decodes a multi-megabyte
bitmap to draw a 56 px square.

Orphaned folders — a composer abandoned mid-draft, a delivery that died
between removing the record and removing its bytes — are swept on launch and
on reset. Without that, "reset" leaves megabytes behind that nothing will
claim.

### Reset is three decisions, not one

Clearing finished work and destroying unsent work are not the same decision,
so they are not the same button. Each states its blast radius in the button
and again in the confirmation:

| Action | Destroys | Leaves alone |
| --- | --- | --- |
| Clear finished reports | Confirmed reports and their local photos | Unsent work, the server |
| Delete everything on this device | Every report, photo and draft — **including unsent** | The server |
| Wipe the server | Everything the server holds | This device |

The middle one names the number of unsent reports in its confirmation, because
that is the number the user needs in order to decide.

### One place decides every status word

"Saved" and "uploaded" are different facts and must never share a sentence.
That rule degrades one well-meaning string at a time when the vocabulary is
scattered across five screens, so it lives in one pure function
(`core/selectors.ts`) — and `selectors.test.ts` asserts that no state but a
confirmed delivery can use the language of delivery, and that every failure
state names a reason and what happens next.

### Nothing under `src/core` imports React Native

The queue talks to the interfaces in `core/ports.ts`; the app supplies React
Native implementations, tests supply fakes, and the headless harness supplies
Node ones. That is what makes "exercisable without rendering a screen" true
rather than aspirational — a test for the lost-response case is a five-line
fake, not an emulator. `purity.test.ts` fails if anyone ever breaks it.

---

## Layout

```
src/core/        the queue, the rules, the status vocabulary — no React Native
  queue.ts         the state machine and the delivery guarantee
  errors.ts        what is worth retrying, and what is not
  ports.ts         everything it needs from the outside world
  selectors.ts     every status word the user sees
src/platform/    React Native implementations of those ports
  imageProcessor.ts  the 5 MB search
  httpTransport.ts   XHR, upload progress, idle watchdog
  reportStore.ts     one AsyncStorage row per report
src/app/         screens and components
src/headless/    the same queue, run from Node
server/          the fail-on-demand backend and its control panel
```

## Checks

```bash
npm run verify     # typecheck (app + harness), lint, 53 tests
npm test
npm run harness -- --gauntlet
```

The test suite runs in about a second because it never touches a device.
It covers exactly-once under a lost response (upload *and* commit), resumption
after a force-quit mid-upload, crash recovery from a `working` record, no
retry on a refusal or a 413, the attempt budget, offline draining on
reconnect, oldest-first ordering, and storage released after delivery.

---

## What I knowingly left out

**Uploads stop when Android suspends the app.** This is the real gap. The
queue runs while the app is alive — foregrounded or backgrounded — and resumes
immediately on next launch, which satisfies "nothing is lost" but not "put it
in your pocket and walk out". The production answer is a `WorkManager`
expedited job holding the queue, promoted to a foreground service with a
notification once an upload passes ten minutes, with the JS queue reduced to a
view over the same records. That is a native Kotlin module and a day's work on
its own; it was the right thing to cut, but it is the first thing I would
build next.

**iOS is unverified.** The project is bare React Native CLI and the iOS target
exists, but pods were never installed and it has not been built or run. Every
dependency supports iOS; I would not claim more than that.

**No automated UI tests.** The core logic is covered thoroughly and the
upload path has a headless harness; the screens were verified by hand on the
emulator. Detox would be the next addition.

**Release builds cannot reach the dev backend.** `usesCleartextTraffic` is
debug-only, which is correct for a release build and worth knowing before
someone tries `assembleRelease` and finds uploads failing.

**One queue, one device.** No multi-user, no auth, no server-side ownership.
The backend is a test fixture, and it is wide open by design.

**Drafts are weaker than submitted reports.** A half-written report survives a
force-quit (the photos are already durable, so only the text needed saving),
but it is not covered by the delivery guarantee — nothing has been submitted
yet. That felt like the right line to draw.

## With another day

1. `WorkManager` background uploads, as above.
2. Upload resumption *within* an image — currently a dropped connection at 90%
   of a 5 MB file re-sends the whole file. Chunked uploads with a server-side
   assembly step would make progress on even the worst link monotonic.
3. A real device matrix. The emulator is not a 2G link in a stairwell, and
   `react-native-image-picker` behaves differently across OEM galleries.
4. Capture location and capture time as explicit report fields, rather than
   losing them with the EXIF.

## Notes for the reviewer

- **The `10.0.2.2` default** is the emulator's alias for your host machine. On
  a physical device, use the LAN URL the server prints at startup, and set it
  in the Settings tab — no rebuild needed.
- **On Android 16+ you may see a "nearby devices / local network" prompt on
  first launch.** That is React Native's own dev-support manifest asking for
  `ACCESS_LOCAL_NETWORK` so it can reach Metro; it is not something this app
  requests. Allow it, or use `adb reverse tcp:8081 tcp:8081` and
  `adb reverse tcp:4000 tcp:4000`, which is exempt.
- **AI assistance** was used while building this, as the brief allows. Every
  decision above is one I made and can defend, and every line is one I own.
