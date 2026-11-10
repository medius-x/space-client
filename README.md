# SPACE

**SPACE** is the desktop client of the OAK self-hosted platform: text chat, voice
rooms, screen sharing and calls for your own community — on infrastructure you
control.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

![Main window with a chat open](docs/chat.png)

## Download & install

Grab the latest `SPACE Setup <version>.exe` from
[Releases](../../releases) and run it — a per-user install, no administrator
rights required. Windows 10 or later.

This is the standard (light) build, ~135 MB. When you set up a server, the
machine itself downloads the OAK stack (~600 MB of Docker images plus the
server jar) straight from GitHub — and if it cannot reach GitHub, SPACE relays
the missing pieces through your computer. Either way, no registry access is
strictly required.

Need a build that does not depend on GitHub? Take `SPACE Full Bundled Setup
<version>.exe` from the same Releases page: it bundles the entire server kit
(~735 MB), so provisioning a server works even when GitHub and Docker
registries are unreachable — the network between your computer and the server
machine is still required, of course.

> The installers are not code-signed, so Windows SmartScreen will ask for
> confirmation the first time ("More info" → "Run anyway"). Each build updates
> within its own channel — a light install stays light, a full-bundled install
> stays full-bundled.

## Getting started

There are two ways in:

### Someone invited you

Ask a member with invite rights for an **invite link**, open SPACE, switch to
the **Register** tab and paste the link — the server address is filled in
automatically. Pick a nickname, login and password, and you are in.

### Run your own server

The **Create** tab turns a fresh Linux box into your community's home — right
from the client:

1. Enter the machine's IP address and the root SSH password.
2. SPACE connects over SSH and installs everything: Docker, the full OAK stack
   (chat server, PostgreSQL, object storage, voice gateway, TURN relay), a TLS
   certificate and a firewall — with individually generated secrets.
3. Your account is created as the server owner and you are logged in
   automatically.

![Creating a server from the client](docs/create-server.png)

What the server needs:

- Ubuntu or Debian, x86_64
- 2 GB RAM, 5+ GB free disk
- Root access over SSH

Prefer a domain name over a bare IP? Fill it in the Advanced section and the
setup obtains a Let's Encrypt certificate automatically.

Re-running setup on an existing installation adopts it in place — data,
accounts and client trust pins are preserved.

## Features

### Chat

- Text messages with instant delivery, editing and deletion
- Message formatting with markers (`**bold**`, `*italic*`,
  `__underline__`, `~~strike~~`, `||spoiler||`, `` `code` ``) — Ctrl+B/I/U,
  Ctrl+Shift+X shortcuts, and a "Formatting" submenu in the composer's
  context menu. The composer itself is a WYSIWYG editor: the markers are
  hidden and the text looks the way it will in chat
- Spell checking in English and Russian (dictionaries bundled) while you type
- Replies with nested quote chains; forwarding to any channel — including other servers
- Reactions, custom emoji and sticker packs (import/export as archives)
- `@user`, `@role` and `@everyone` mentions
- Message search across the server, jumping straight to the exact spot
- Pinned messages
- Discussion threads attached to any message
- Attachments: images, video, audio and files — gallery layout, fullscreen
  viewer, link previews

### Voice & calls

- Voice rooms with screen sharing — with system audio; a full-desktop share
  excludes the client's own sounds (viewers hear the desktop, not a doubled
  voice channel), and a window share can carry just that application's sound
- End-to-end encrypted 1-on-1 calls
- Camera in rooms and calls
- Per-user volume sliders
- Mute/deafen, and moderator mute/deafen/kick
- An AFK channel that idle members are moved to automatically — and idle
  members show a yellow presence dot in the member list, turning green again
  the moment they come back
- A dead microphone (a sleeping wireless headset is the typical cause) shows
  an amber "Mic is silent" status instead of looking healthy
- Noise suppression with five engines, switchable live
- Voice invites, sharing quality presets, a pop-out viewer window and a
  connection quality indicator

![Voice room with screen sharing](docs/voice-room.png)

### Server management

- Roles with fine-grained permissions, per-channel overrides, private and
  locked channels
- Channel categories with drag-and-drop ordering
- Invite links with a configurable lifetime
- Moderation: member bans and permanent removal from the server
- Ownership transfer
- Per-role restriction of direct messages
- Storage housekeeping with high/low disk watermarks
- Service health panel; server and client log export for problem reports
- Full-instance backups: one archive with every conversation, account and
  attachment, downloaded to your computer on demand or daily while the client
  runs; restoring one onto a fresh server (the Create dialog) brings the whole
  community up as if it had been created there, and the Migrate button redeploys
  this server's latest state to a new machine in a single flow

### Client

- Several servers side by side, with live background sessions and instant switching
- Friends, direct messages and group conversations
- Notifications: per-server modes, always-on-top toasts, in-app sounds
- Customizable hotkeys — including a global mute that works in games
- Interface language: English or Russian, switchable in Settings → General —
  applies instantly, no restart; `System default` follows the OS language.
  Dates and plural forms follow the language too. Server-side error texts stay
  in English (one server serves speakers of both)
- Self-updates from GitHub Releases: the client checks in the background (on
  startup and once a day while idle) and offers the new version with a banner —
  one click downloads and installs it quietly, accounts and settings survive
- Dark theme, audio/video device settings, configurable image cache
- Built-in diagnostics with a one-click log archive

### Security

- TLS everywhere: Let's Encrypt for domains, pinned self-signed certificates
  for bare-IP servers (the fingerprint dialog is the pin being set — verify it
  with your server admin on first connect)
- 1-on-1 call media is end-to-end encrypted — it flows directly between the
  peers, and a TURN relay (when one is needed) only forwards already-encrypted
  packets
- Access tokens are encrypted at rest with OS-level credential protection
- Server-side authorization on every action; the client only hides what the
  server already refuses

## Self-hosting notes

- Server setup fetches the stack through a ladder of sources, worst case
  last: public Docker registries first (with DNS and mirror self-repair), then
  GitHub directly from the server, then a relay through your computer — and,
  on the full-bundled build, the kit bundled with the installer covers
  everything without a single external download. Provisioning keeps working
  on a VPS with restricted or rate-limited registry access, and the
  full-bundled kit survives a full GitHub outage
- The light build's honest limitation: provisioning a server (including
  adopting an existing one — the server jar is always needed) requires GitHub
  to be reachable, from the server itself or from your computer. The
  full-bundled build has no such requirement
- Updates re-run the same flow on top of an existing installation
- Backups are built in: Server Settings → Server builds a full archive (chats,
  accounts, attachments) straight to your computer, and Migrate deploys a fresh
  server from it — no manual volume copying. When both machines can reach each
  other, Migrate transfers the archive directly between them (verified by a
  cryptographic digest, authorized by a one-shot token that expires in two
  hours) and your computer only coordinates; otherwise the archive routes
  through your computer as before

## Limitations

- Windows client only for now
- One installation is one community — no multi-community hosting yet

## License

AGPL-3.0-only — see [LICENSE](LICENSE). Bundled Docker images and their
licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md);
Electron/Chromium attribution ships inside the installed package.

