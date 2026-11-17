# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Video previews in chat obey the same 320px size cap as pictures (a
  widescreen clip used to render nearly twice as wide), and the preview
  card no longer reacts to window resizes: the frame and its border stay
  exactly at the preview's size, and the play triangle sits dead-center
  in its circle. A long file name no longer stretches the card wider
  than its preview — the name trims to the frame with an ellipsis while
  the extension (".mp4" and friends) stays readable at the end.
- Elongated pictures (wide strips, tall strips) no longer shrink to a
  thumbnail in chat: the single-image preview now fits the 320px size cap
  on each side independently instead of being bounded by the image's
  smaller side — a wide strip shows at full preview width, small square
  pictures still stay exactly their natural size.
- Video cards now align exactly with the picture tiles next to them (the
  card's outer edge is the same 320px), and the play button is a
  translucent blurple circle — video attachments are easier to tell from
  pictures at a glance.
- Downloaded log archives (client and server) land in their own
  downloads/SPACE/logs subfolder instead of the root, and a button
  appears next to the download buttons that opens the folder with the
  latest archive selected in Explorer.
- The screen-share button in voice panels now uses the monitor-with-arrow
  glyph, matching the common screen-sharing symbol.
- Clicking your own avatar opens the STATUS menu: Account settings rides the
  top row, below it sit your presence status and a submenu with Auto, Do not
  disturb, Online, Away and Invisible. The auto mode flips between Online and
  Away (idle) on its own; any manual pick pins the status until Auto is
  chosen again. Invisible shows you as offline to everyone while everything
  keeps working — you can chat, join voice rooms and take calls; voice-room
  membership stays visible (the Discord way). Your own avatar carries the
  status dot, and everyone's roster dot turns red for Do not disturb.
- Notifications now follow your status: Away (auto) keeps message toasts on
  screen until you return (no sound), a manual Away hides message toasts,
  and Do not disturb / Invisible silence message and call sounds while the
  incoming-call card still appears.
- Calling offline friends is allowed: the call button in the friends list
  and the roster's call action work regardless of the green/grey dot.
- A lone picture (and a video's preview card) now takes more room: it grows
  up to 1.5× the mosaic tile size in a wide window, then scales down with the
  window instead of staying frozen — singles and videos stay level with each
  other at every width. Every kind of media (single pictures, video cards,
  mosaic tiles) now stops shrinking at the same small floor and overflows
  instead of crumbling into unreadable squares.
- Replying to a message with a picture now shows the picture: the quote card
  carries a small square preview of the original's first image beside the text
  snippet (freshly linked on every load, so it never goes stale; quotes inside
  forwarded messages stay text-only).
