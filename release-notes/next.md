# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Game icons now arrive over ANY working route: a client whose network
  reaches the icon host fetches it directly and hands the bytes to the
  server (first delivery wins), and the server itself keeps resuming a
  strangled download in bursts — on hostile links the icon lands within
  minutes of someone playing the game, and nothing hangs forever: every
  route has its own deadline.
