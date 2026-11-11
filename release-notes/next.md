# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Your name in the members list can now carry an activity line — "playing
  CS2", "listening to radio", and so on — and it flips on and off by itself:
  register an application in User Settings → Activity (pick it from the
  running list, Task-Manager style with icons), and while that application
  runs, everyone sees the line under your name; close it and the line goes
  away. When several registered apps run at once, the latest launched wins;
  closing it falls back to the previous one.
- Screen shares no longer freeze for seconds when the presenter's uplink is
  narrower than the picked quality: the preset is now a ceiling, not a
  constant — the sender starts at 60% of it and adapts (up on a quiet channel,
  down on loss, keyframe requests from viewers or a growing RTT), so the
  picture degrades gracefully instead of buffering into multi-second freezes.
- A share now survives voice reconnects on its own: when the media transport
  drops, the rejoin ladder brings the SAME window or screen back up instead of
  leaving a dead tile for a manual restart.
- When the encoder cannot keep up with the picked preset (a busy machine), the
  share quietly downscales instead of dropping frames — and steps back up once
  the load passes.
- Viewers see an honest hint when the presenter minimizes the shared window:
  the frozen frame gets a "window minimized" caption instead of silence.
