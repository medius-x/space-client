# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- Right-click now works in every input field: the app's own Cut/Copy/Paste/
  Select All menu (previously only Ctrl+V pasted — Electron shows no native
  menu on its own).
- The composer's right-click "Paste" now pastes for real: text AND files
  copied in the Explorer, exactly like Ctrl+V (it used to insert text only).
- Banning or removing a member now instantly burns every invite they issued.
- Voice mute/deafen icons are now visible in the channel list right away,
  even before you enter the room (previously they only appeared after a live
  flip or your own join).
- Channels can now stand between categories: drag any channel above, below or
  between category blocks, Discord-style; inside a category text still sits
  above voice.
