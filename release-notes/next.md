# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- After updating a server through the Create dialog (the adopt flow), the
  "Server version" line in Server Settings now refreshes on its own —
  previously it kept showing the old version until the client was restarted.
- Launching SPACE while it is already running no longer pops up a crash
  dialog: the duplicate launch used to keep initializing after being rejected
  by the single-instance lock and could die mid-init with an error window;
  it now exits immediately and quietly (the live window comes to the front,
  as before).
- The yellow AFK dot in the member roster now means "away from the computer",
  not "idle in a voice channel": it appears after 5 minutes without any input
  on your machine (speaking in voice or sharing your screen keeps you green)
  whether or not you are in a voice room, and it no longer depends on the
  server's AFK-channel timeout. Any input in any application brings the dot
  back to green almost instantly.
