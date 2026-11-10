# Unreleased

A running draft of user-visible changes for the next release. Every
user-visible commit appends one entry here, written for users right
away in the style of the final notes. At release time this file is
edited into `v<version>.md` and emptied.

What belongs here: features and fixes a user can see or feel. What
does not: CI, docs, refactoring, internal rework.

- After updating a server through the Create dialog (the adopt flow), the
  "Server version" line in Server Settings now refreshes on its own —
  previously it kept showing the old version until the client was restarted.
- Launching SPACE while it is already running no longer pops up a crash
  dialog: the duplicate launch used to keep initializing after being rejected
  by the single-instance lock and could die mid-init with an error window;
  it now exits immediately and quietly (the live window comes to the front,
  as before).
- Fixed spell check breaking after you add a word to the dictionary: on the
  next start every typed word would be underlined as misspelled. The custom
  words no longer interfere with loading the built-in dictionaries, and a
  dictionary load failure now logs its reason instead of failing silently
  (underlines simply stay off in that case).
- When your microphone stops delivering audio mid-call (a wedged audio
  device), the client now escalates carefully instead of tearing the voice
  room apart: it rebuilds the audio pipeline, then re-opens the microphone
  outright (without dropping the room), and only rejoins the room twice as a
  last resort. If the microphone is still dead after that, it shows the amber
  mic hint and leaves everyone's incoming audio intact — previously a wedged
  mic caused an endless reconnect loop that chopped the audio for the whole
  room every half a minute.
- The screen-share quality step now opens on what you used last instead of
  the default preset — including the named preset row itself when the share
  rode a saved preset. Window shares remember their settings per window
  title: sharing the same window again reopens exactly what you used for it
  last time (the 10 most recently shared window titles are kept).
- Your own last message no longer lights up the Home badge after a client
  restart: the unread counter used to include the messages you sent
  yourself, so your own latest DM looked like an unread incoming message.
- The small server icons in the direct-messages list no longer disappear
  after the client has been running for a while: they used to re-download
  from a link that expires after an hour, and once it did they silently fell
  back to letter discs until a restart. They now load from the local cache
  the server rail already uses, and a failed download leaves a trace in the
  logs instead of vanishing quietly.
- The yellow AFK dot in the member roster now means "away from the computer",
  not "idle in a voice channel": it appears after 5 minutes without any input
  on your machine (speaking in voice or sharing your screen keeps you green)
  whether or not you are in a voice room, and it no longer depends on the
  server's AFK-channel timeout. Any input in any application brings the dot
  back to green almost instantly.
