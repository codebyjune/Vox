# Local dev: LiveKit via Docker

Runs **only the LiveKit SFU** locally so the Go backend + desktop client can hit
a real media server without LiveKit Cloud. The Go backend itself stays a native
process (no Docker).

> Dev credentials (hard-coded in `livekit-dev.yaml`): `key=devkey`,
> `secret=devsecret-change-me-32-bytes-min-abcdef`. Fine for localhost only.

## Start

```bash
cd deploy/local
docker compose up -d
docker compose logs livekit          # confirm "starting LiveKit server"
```

LiveKit listens on:
- `ws://localhost:7880` — signaling (point `LIVEKIT_HOST` here)
- `:7881` TCP — ICE fallback
- `50000-50020/udp` — WebRTC media

## Run the Go backend against it

```bash
LIVEKIT_API_KEY=devkey \
LIVEKIT_API_SECRET='devsecret-change-me-32-bytes-min-abcdef' \
LIVEKIT_HOST=ws://localhost:7880 \
DB_PATH=./vox.db \
go run ./server/cmd/voiceapp
```

## Run the desktop client

```bash
cd client
npm run tauri dev
# Enter any name + a room name → Join. Open a second instance on another
# machine (same room) and you should hear each other.
```

## Stop

```bash
cd deploy/local && docker compose down
```

---

## What this verifies

| Layer | Verified by |
| --- | --- |
| Go backend signs a LiveKit-acceptable JWT | `curl /api/join` + decoded payload (`iss`, `sub`, `video.room`, `roomJoin`) |
| Real LiveKit accepts that JWT | a WebSocket client connecting with the token receives a `JoinResponse` frame |
| Two participants coexist in one room | `RoomService.listParticipants(room)` returns both identities |

What this does **not** verify (needs a real mic + GUI):
- actual audio frame exchange (WebRTC media plane)
- the denoise worklet processing a real microphone

For that, run the Tauri client (`npm run tauri dev`) with this Docker LiveKit up
and talk between two machines.
