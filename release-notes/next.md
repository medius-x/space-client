# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Fixed the icon delivery introduced in 0.8.5: a missing database
  transaction silently discarded every icon the server downloaded (and
  every client offer), so icons never appeared despite the machinery
  running. The store now works from the background thread, each client
  offer is logged, and the download target is published the moment it is
  chosen — so a healthy client can deliver the icon while the server is
  still transferring.
