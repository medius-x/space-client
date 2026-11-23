# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Game icons no longer depend on luck when the SteamGridDB CDN stalls: a
  wedged or trickling download now dies at a hard time budget instead of
  silently blocking the icon queue forever, so the icon arrives on the next
  retry instead of never.
