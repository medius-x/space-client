# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Icons now survive dead network windows: the client keeps re-checking for
  half an hour instead of giving up in seconds, a failed check no longer
  silences a game for the whole session, and the server retries a known
  download target straight at the icon host instead of waiting for its
  catalogue host to come back — the icon lands whenever ANY of the routes
  breathes.
