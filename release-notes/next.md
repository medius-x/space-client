# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Video previews in chat obey the same 320px size cap as pictures (a
  widescreen clip used to render nearly twice as wide), and the preview
  card no longer reacts to window resizes: the frame and its border stay
  exactly at the preview's size, and the play triangle sits dead-center
  in its circle. A long file name no longer stretches the card wider
  than its preview — the name trims to the frame with an ellipsis while
  the extension (".mp4" and friends) stays readable at the end.
