# Release notes

A handwritten changelog per release (user decision 2026-11-03; practice starts
with v0.4.1 — v0.4.0 shipped with GitHub's auto-generated notes as a pure
smoke-release):

- The file `v<version>.md` in this directory (e.g. `v0.4.1.md`) becomes the
  BODY of that GitHub release — the release workflow picks it up automatically
  (`--notes-file`).
- No file for the tag → the release falls back to GitHub's auto-generated
  commit list (the old behaviour).
- Written for users, not for the repo: what changed on the surface, in the
  user's words; no internal ticket ids, no commit hashes.
- Committed together with the version bump, BEFORE the tag is pushed — the
  workflow reads it from the tagged commit.
- `next.md` is the running draft between releases: every user-visible commit
  (client OR server — releases are paired) appends one entry there in the
  final style. At release time it is edited into `v<version>.md` and emptied.
