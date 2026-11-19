# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Steam games now show up in your activity line on their own: the client reads
  the game's Steam app id and resolves it against the IGDB game database (the
  server admin connects it in Server Settings → IGDB), the line carries the
  game's cover thumbnail, and a Steam install IGDB does not know asks ONCE
  which game it is — your pick then resolves the same game for everyone on the
  server. Non-Steam applications are never auto-detected (bind them with the
  manual rules as before); manually registered rules always win over detection,
  and "Detect games automatically (IGDB)" in Settings turns the whole thing off.
  Detected games row up in Settings → Activity with a publish checkbox and the
  summed playtime next to each — uncheck one and its line never shows and its
  clock stops; the play history lives on the server, so it follows you across
  devices. The server admin now sets the
  IGDB connection up right in Server Settings → Integrations: the Twitch
  application's Client ID and Client Secret (the secret is write-only), a
  built-in ⓘ guide to registering the application, and a pause toggle that
  switches game detection off for the whole server without deleting the keys.
- Sitting in a voice room or a call now keeps your status green: the automatic
  away dot no longer turns yellow while you are in voice, even with your mic
  quiet and your hands off the keyboard — talking to people means you are at
  the computer. The away status you set by hand is not affected.
- Fixed the screen share picture constantly changing size at the viewer's end:
  the video encoder no longer silently switches resolution as the connection
  adapts (the trade the 0.6.0 freeze fix made). The stream now keeps the
  picked resolution at all times — under a tight connection the framerate
  gives in first, and the resolution only steps down deliberately when the
  sharer's CPU genuinely cannot keep up.

