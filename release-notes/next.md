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
