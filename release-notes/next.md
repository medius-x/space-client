# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- The voice panel's corner game picture can now be the game's real square APP
  ICON: the server admin connects SteamGridDB in Server Settings → Integrations
  (a free key from steamgriddb.com, a built-in ⓘ guide to getting it), and
  icons appear for detected Steam games — the cover thumbnail stays as the
  fallback. The icon layer has its own pause toggle (pausing the game
  detection mutes both), and every game picture — icons and covers alike —
  now travels through your own server, so client machines behind strict
  networks see pictures too.
