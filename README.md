# space-client (spike)

Electron + TypeScript spike client for the OAK server. Validates, against a live
server: stereo screenshare audio, per-user volume (voice + share separately), system
audio via `getDisplayMedia`, and the browser audio pipeline (AEC/NS/AGC).

## Run

```bash
npm install
npm start        # build + launch the window (DevTools open at the bottom)
npm test         # unit tests
npm run typecheck
```

The server stack (for smokes): `oak-server/env/docker compose up -d` +
`mvn spring-boot:run` in oak-server, then two clients with DIFFERENT audio devices.

## What to click

1. Log in (register first if needed — the button creates + logs in).
2. Click the getDisplayMedia **self-test** in the diagnostics panel — it must print a
   system-audio track with `channels=2` (risk probe for the whole spike).
3. Join a voice channel; the other client hears you (browser APM is on).
4. **Stereo proof (sequential, hard-panned tones):** share screen with audio, press
   **Tone L** → at the viewer press Watch → expect `PASS (signal LEFT)`; then switch
   to **Tone R** → expect `PASS (signal RIGHT)`. Both = stereo proven, no channel
   swap. NOTE: the tones are equal-level single-channel signals on purpose — an
   equal-amplitude two-channel tone reads Δ≈0 even through perfect stereo.
   Physical trap: a headset lying on the desk with its mic touching an earpiece
   creates an acoustic feedback loop that shows as MONO flicker.
5. Drag a user's voice slider — only their feed changes; the share slider is separate.
