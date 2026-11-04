# Field Reports — backend

A deliberately small upload target for the app, with a switch for every way a
network can betray you. The brief does not score the backend; it scores whether
the *app* survives this one.

```bash
npm install
npm start          # http://localhost:4000, control panel at /
```

| From | URL |
| --- | --- |
| Android emulator | `http://10.0.2.2:4000` |
| Physical device | `http://<your-lan-ip>:4000` (printed on start) |
| Host browser | `http://localhost:4000` |

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/health` | Limits and liveness. |
| `POST` | `/v1/uploads` | Multipart `file`. **`Idempotency-Key` required.** Optional `X-Expected-Bytes`. |
| `POST` | `/v1/reports` | JSON commit. **`Idempotency-Key` required.** |
| `GET` | `/v1/reports` | What the server actually holds. The app's Server tab reads this. |
| `GET` | `/v1/images/:id` | Image bytes. |
| `DELETE` | `/v1/reports` | Wipe everything (dev reset). |
| `GET`/`POST` | `/chaos` | Read / set the failure mode. Never itself affected by chaos. |

## Two invariants

**Nothing partial is ever visible.** Uploads are received into `.data/tmp`,
then `rename(2)`d into `.data/files` only once complete. A connection dropped
mid-body cannot leave a half-written file that a later request mistakes for a
finished one. The idempotency index is written the same way (write temp, fsync,
rename), so it is never observed half-updated after a kill.

**The same key never stores twice.** `Idempotency-Key` is the client's own id,
generated and persisted on the device *before* the first attempt. Replays return
the original record with `duplicate: true` instead of creating a second copy.

## Failure modes

Set from the control panel, or `POST /chaos {"mode":"..."}`.

| Mode | What it does | What it proves about the app |
| --- | --- | --- |
| `off` | Normal. | — |
| `slow` | Throttles to `linkKbps`. | Makes progress on a bad link instead of giving up. |
| `error500` | 500 after reading the body. | Transient faults are retried with backoff. |
| `refuse` | 400 after reading the body. | Permanent faults are **not** retried forever. |
| `hang` | **Stores the upload, then never answers.** | The lost-response case. The retry must be de-duplicated, not stored twice. This is the exactly-once test. |
| `drop` | Destroys the connection before committing. | Retries from scratch; no partial state anywhere. |
| `flaky` | Random mix per request. | Survives a long unattended run. |

`affect` limits chaos to writes (default) or applies it to reads too.

### A note on `slow`

`slow` does two things: it pauses the TCP socket on a duty cycle (real
backpressure), and it holds the response for however long the body *would* have
taken at `linkKbps`. The second part exists because the first does not work over
loopback — macOS auto-tunes the loopback receive buffer to
`net.inet.tcp.autorcvbufmax` (4 MB here), so the kernel accepts an entire 5 MB
upload whether or not Node is reading it. Measured: a 4 MB upload at 2048 kbps
takes 16.4 s, which is the arithmetic.

For a faithful 2G test, throttle the emulator instead — it shapes the virtual
NIC, which loopback tricks cannot:

```bash
adb emu network speed gsm     # ~14 kbps up. Also: edge, umts, full
adb emu network delay gprs
```
