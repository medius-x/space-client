# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Game icons now deliver themselves: the server keeps retrying undelivered
  icons every hour until the icon host's connection lets them through (some
  hostings throttle that CDN to a crawl), picks the smallest adequate icon
  first, and gives a slow download up to 15 minutes — the icon arrives on its
  own within hours instead of never.
