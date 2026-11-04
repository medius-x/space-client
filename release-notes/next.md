# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- After jumping to an older message (a search result or a pinned
  message), scrolling up to load even older history could stop
  working after a second jump — fixed.
- After you download a file, its download button turns into a button
  that opens the folder containing the file. The file is remembered
  between restarts; if it has been moved or deleted meanwhile, the
  button quietly turns back into a download button.
- When the microphone device stops responding, joining a voice room no
  longer hangs on "Connecting" forever — the problem is detected
  within ten seconds and reported as a clear failure instead.
- A voice room that got lost on the gateway no longer leaves the
  channel stuck with phantom participants: the server now detects
  this and heals the room automatically, and a live client re-joins
  seamlessly. Tokens left behind by clients that died without leaving
  the voice are cleaned up automatically too.
- When the microphone stops delivering sound in the middle of a call
  (a sleeping wireless headset is the typical cause), the voice panel
  now says so instead of looking healthy — after a minute and a half of
  total silence the status line turns amber: "Mic is silent". The hint
  disappears the moment the microphone wakes up.
- Small polish in the chat: the text you type now starts on the same
  line as the messages above it, and editing a message no longer makes
  its text visually larger.
- Spell checking while you type: misspelled English and Russian words
  are underlined everywhere you type, and right-clicking a misspelled
  word opens a "Spelling" submenu with corrections and "Add to
  dictionary" (added words are remembered between restarts). The
  dictionaries are bundled with the app — it works the same offline,
  on any machine. Can be turned off in Settings → General.
- Message formatting, Discord-style: `**bold**`, `*italic*`,
  `__underline__`, `~~strike~~`, `` `code` `` and `||spoiler||` (click a
  spoiler to reveal it). The selection gets wrapped by Ctrl+B/I/U,
  Ctrl+Shift+X, or a new "Formatting" submenu in the composer's right-click
  menu. The composer is a WYSIWYG editor: the markers are hidden and the
  text looks the way it will in chat while you type. Quote previews render
  formatting too.
- The right-click menu's submenus ("Spelling", "Formatting") no longer snap
  shut while you move the mouse diagonally toward an item — they stay open
  for a moment after the pointer leaves the parent row. Moving the mouse to
  another menu item still closes them right away.
- The time shown beside a message on hover is now always 24-hour, matching
  the rest of the chat's timestamps (under an English interface it used to
  flip to AM/PM).
- The roster's presence dot gained a third state: a member sitting in a
  voice channel who has been idle past the server's AFK timeout shows a
  yellow dot instead of green, turning back to green the moment they become
  active. Works even when the server has no AFK channel configured.
- The DeepFilterNet3 "Suppression limit" slider now works in an honest 6–40 dB
  band with a 15 dB default. The old 0–100 scale parked the default at
  "effectively unlimited", most of its range had no audible effect, and leftmost
  (0) paradoxically meant the strongest suppression.
- The installed app no longer opens extra full windows when something launches
  it again while it is already running — the running window is focused instead
  (previously each extra launch doubled every sound until you closed the twins).
