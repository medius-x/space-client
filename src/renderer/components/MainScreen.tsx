import { useEffect, useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, connectionDirectory, openAccountSettings, retryConnection, setRosterStatusOverride, settingsStore, toggleUserSettings } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { ConnectionQualitySnapshot } from "../../domain/logic/connection-quality";
import type { MessageKey } from "../../domain/i18n/i18n";
import { hasServerCapability } from "../../domain/logic/server-capabilities";
import { ServerRail } from "./ServerRail";
import { Sidebar } from "./Sidebar";
import { ChatPane } from "./ChatPane";
import { FriendsPane } from "./FriendsPane";
import { RightPane } from "./SearchPane";
import { VoiceBar, RoomView, CallConflictModal } from "./VoiceRoom";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useDisplayName } from "../hooks/useDisplayName";
import { useT } from "../hooks/useT";
import { Diagnostics } from "./Diagnostics";
import { Avatar } from "./Avatar";
import type { RosterStatus } from "../../types";

/** The status line's key per STOMP state (labels come from the dictionaries). */
const STOMP_STATUS_KEYS: Record<string, { key: MessageKey; className: string }> = {
  off: { key: "userBar.status.off", className: "off" },
  connecting: { key: "userBar.status.connecting", className: "connecting" },
  connected: { key: "userBar.status.connected", className: "connected" },
  lost: { key: "userBar.status.lost", className: "lost" },
};

const STOMP_STATUS: Record<string, { text: string; className: string }> = {
  off: { text: "Offline", className: "off" },
  connecting: { text: "Connecting…", className: "connecting" },
  connected: { text: "Connected", className: "connected" },
  lost: { text: "Connection lost", className: "lost" },
};

export function MainScreen({ session }: { session: ConnectionSession }): React.JSX.Element {
  const diagOpen = useStore(appStore, (state) => state.diagOpen);
  const callState = useStore(appStore, (state) => state.callState);
  const activeVoiceChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const dmMode = useStore(appStore, (state) => state.dmMode);
  const activeDmId = useStore(appStore, (state) => state.activeDmId);
  const roomViewOpen = useStore(appStore, (state) => state.roomViewOpen);
  const searchOpen = useStore(appStore, (state) => state.searchOpen);

  // The diagnostics panel is a hidden hotkey away. It USED to live on
  // Ctrl+Shift+D — 2026-09-18 the chord moved to F12: Discord's Toggle Deafen
  // default claimed Ctrl+Shift+D, and a global chord would have opened the
  // panel on every focused deafen toggle.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.code === "F12") {
        event.preventDefault();
        appStore.patch({ diagOpen: !appStore.getSnapshot().diagOpen });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A 1:1 call does NOT take the chat pane (oak): its surfaces are the voice
  // bar + the room view (a degenerate 2-tile room). The room view is a
  // chat-area swap opened by the voice-bar click (auto-opened on accept).
  // The right column (search box header + roster/results body) is a SERVER-mode
  // fixture: hidden in Home (the DM chat keeps its full width) — except while
  // a DM search is open, when the column appears to host it.
  const friendsOccupiesContent = dmMode && activeDmId === null;
  const voiceSurfaceLive = callState !== "idle" || activeVoiceChannelId !== null;
  const roomViewOccupiesContent = roomViewOpen && voiceSurfaceLive && !friendsOccupiesContent;
  const rightPaneVisible = searchOpen
    ? !friendsOccupiesContent && !roomViewOccupiesContent
    : !dmMode && !roomViewOccupiesContent;

  return (
    <>
      <div className="main-shell">
        {/* oak's left-section: the two columns with the voice+user overlay card
            floating over their bottom (margins 8 — it spans rail + channels). */}
        <div className="left-section">
          <div className="left-columns">
            <ServerRail activeRecordId={session.recordId} session={session} />
            <Sidebar session={session} />
          </div>
          <div className="left-overlay">
            <VoiceBar session={session} />
            <UserBar session={session} />
          </div>
        </div>
        <main className="content">
          {friendsOccupiesContent ? (
            <FriendsPane session={session} />
          ) : roomViewOccupiesContent ? (
            <RoomView session={session} />
          ) : (
            <ChatPane session={session} />
          )}
          {rightPaneVisible ? <RightPane session={session} /> : null}
        </main>
      </div>
      {/* The settings overlays live in App (direct children of #app) — see App.tsx. */}
      <CallConflictModal />
      {diagOpen ? <Diagnostics /> : null}
    </>
  );
}

/** The lower half of the overlay card: avatar + nick + connection status (+ the
 *  ↻ retry while the connection is down) and the ONE chrome button (settings) —
 *  avatar editing lives in Settings (oak parity).
 *
 *  session === null (fresh install, no server connected AT ALL): a fully empty
 *  card with the gear ONLY (user spec, bug #1 of the 2026-10-16 test round) —
 *  client-scoped settings (sound, keybinds, diagnostics with the log export)
 *  must stay reachable even before the first server exists; a failed server
 *  setup leaves the user a way to pull the logs. */
export function UserBar({ session }: { session: ConnectionSession | null }): React.JSX.Element {
  const t = useT();
  if (session === null) {
    return (
      <div className="user-bar empty">
        <button className="ghost user-bar-button" title={t("userBar.settings")} onClick={toggleUserSettings}>
          <span className="icon mdi-cog" />
        </button>
      </div>
    );
  }
  return <ConnectedUserBar session={session} />;
}

/** The dot color of each roster status (the status menu's circles). */
const STATUS_DOT_COLORS: Record<RosterStatus, string> = {
  online: "var(--sp-green)",
  away: "var(--sp-yellow)",
  dnd: "var(--sp-red)",
};

function ConnectedUserBar({ session }: { session: ConnectionSession }): React.JSX.Element {
  const t = useT();
  const [statusMenu, setStatusMenu] = useState<{ x: number; y: number } | null>(null);
  const ownUsername = useStore(appStore, (state) => state.ownUsername) ?? session.username();
  const ownRosterStatus = useStore(appStore, (state) => state.ownRosterStatus);
  const ownInvisible = useStore(appStore, (state) => state.ownInvisible);
  // The rename model: the bar shows the NICKNAME; the login never renders.
  const ownDisplayName = useDisplayName(session, ownUsername);
  // The own avatar's key from the record — in the ACTIVE OFFLINE view the
  // roster never loaded, and this is the only source for a disk-cache hit.
  const ownAvatarKey = useStore(connectionDirectory, (records) =>
    records.find((record) => record.id === session.recordId)?.cachedOwnAvatarKey ?? null);
  const stompState = useStore(appStore, (state) => state.stompState);
  const stompAttempt = useStore(appStore, (state) => state.stompAttempt);
  const stompCountdown = useStore(appStore, (state) => state.stompCountdown);
  const connectionQuality = useStore(appStore, (state) => state.connectionQuality);
  const voiceConnected = useStore(appStore, (state) => state.activeVoiceChannelId !== null);
  const base = STOMP_STATUS_KEYS[stompState] ?? STOMP_STATUS_KEYS.off!;
  // oak's label exactly: "Reconnecting in Ns… M/10" while the attempt is
  // scheduled (the per-second countdown), "Reconnecting… M/10" while it flies.
  const status = stompState === "connecting" && stompAttempt > 0
    ? {
      text: stompCountdown !== null
        ? t("userBar.reconnectingIn", { seconds: stompCountdown, attempt: stompAttempt })
        : t("userBar.reconnecting", { attempt: stompAttempt }),
      className: "connecting",
    }
    : { text: t(base.key), className: base.className };
  const retryable = stompState === "lost" || stompState === "connecting";
  return (
    <div className={"user-bar" + (voiceConnected ? " with-voice" : "")}>
      {/* The avatar opens the STATUS menu on a roster-status server (user
          request 2026-11-17): Account settings rides its top row, the status
          picker sits below the separator, and the avatar itself carries the
          status dot (the roster's own dot, mirrored from the broadcast
          verdict). An older server keeps the direct Account-settings jump —
          the status wire would 404. Offline it disables — account mutations
          are REST calls. The ⚙ stays the CLIENT-scoped surface (sound,
          keybinds, diagnostics). */}
      <div className={"user-bar-id" + (stompState === "connected" ? "" : " offline")}>
        <span
          className="user-bar-avatar"
          title={t("userBar.accountSettings")}
          onClick={stompState === "connected"
            ? (event) => {
              if (hasServerCapability(session.serverProfile, "roster-status")) {
                setStatusMenu({ x: event.clientX, y: event.clientY });
              } else {
                openAccountSettings();
              }
            }
            : undefined}
        >
          <Avatar
            session={session}
            username={ownUsername}
            size={32}
            diskFallbackKey={ownAvatarKey}
            showPresence
            online={stompState === "connected" && !ownInvisible}
            away={!ownInvisible && ownRosterStatus === "away"}
            dnd={!ownInvisible && ownRosterStatus === "dnd"}
          />
        </span>
        <div className="user-bar-text">
          {/* The nick is PLAIN TEXT now (user request 2026-11-17): the avatar is
              the one hit target for the status menu / account settings. */}
          <span className="user-bar-name">
            {ownDisplayName}
          </span>
          <span className="user-bar-status-row">
            <span className={"user-bar-status " + status.className}>{status.text}</span>
            {/* The ping indicator rides ALONGSIDE the status while connected —
                while down, the status row itself already tells the story. */}
            {stompState === "connected" ? <PingBadge quality={connectionQuality} /> : null}
            {/* oak's retryButton: visible only while the connection is down; the
                slot stays reserved so the row never jumps when it appears. */}
            {retryable ? (
              <button
                className={"user-bar-retry " + status.className}
                title={t("userBar.reconnectNow")}
                onClick={retryConnection}
              >
                <span className="icon mdi-refresh" />
              </button>
            ) : <span className="user-bar-retry-slot" />}
          </span>
        </div>
      </div>
      <button className="ghost user-bar-button" title={t("userBar.settings")} onClick={toggleUserSettings}>
        <span className="icon mdi-cog" />
      </button>
      {statusMenu !== null ? (
        <AvatarStatusMenu position={statusMenu} onClose={() => setStatusMenu(null)} />
      ) : null}
    </div>
  );
}

/** The avatar-click menu (user request 2026-11-17): Account settings on top,
 *  the STATUS row below the separator — the row's label names the CHOSEN mode
 *  ("Auto", a pinned status or "Invisible", user follow-up), while its dot shows
 *  the EFFECTIVE status (grey while masked); the submenu marks the chosen entry
 *  with a check. A pick pins the status ("auto" re-arms the detector) and
 *  reaches the server at once. */
function AvatarStatusMenu({ position, onClose }: {
  position: { x: number; y: number };
  onClose(): void;
}): React.JSX.Element {
  const t = useT();
  const effective = useStore(appStore, (state) => state.ownRosterStatus);
  const invisible = useStore(appStore, (state) => state.ownInvisible);
  const override = useStore(settingsStore, (state) => state.statusOverride);
  const statusLabels: Record<RosterStatus, string> = {
    online: t("status.online"),
    away: t("status.away"),
    dnd: t("status.dnd"),
  };
  const chosenLabel = override === "auto"
    ? t("status.auto")
    : override === "invisible"
      ? t("status.invisible")
      : statusLabels[override];
  const items: ContextMenuItem[] = [
    { label: t("userBar.accountSettings"), action: openAccountSettings },
    { separator: true },
    {
      label: `${t("status.statusLabel")}: ${chosenLabel}`,
      dot: invisible ? "var(--sp-text-dim)" : STATUS_DOT_COLORS[effective],
      action: () => undefined,
      children: [
        { label: t("status.auto"), checked: override === "auto", action: () => setRosterStatusOverride("auto") },
        { separator: true },
        { label: t("status.dnd"), dot: STATUS_DOT_COLORS.dnd, checked: override === "dnd", action: () => setRosterStatusOverride("dnd") },
        { label: t("status.online"), dot: STATUS_DOT_COLORS.online, checked: override === "online", action: () => setRosterStatusOverride("online") },
        { label: t("status.away"), dot: STATUS_DOT_COLORS.away, checked: override === "away", action: () => setRosterStatusOverride("away") },
        { label: t("status.invisible"), dot: "var(--sp-text-dim)", checked: override === "invisible", action: () => setRosterStatusOverride("invisible") },
      ],
    },
  ];
  return <ContextMenu x={position.x} y={position.y} items={items} onClose={onClose} />;
}

/** The connection-quality GLYPH + ms (RTT of the STOMP socket). The bars glyph
 *  (mdi signal-cellular, user request 2026-11-17) separates the indicator from
 *  the roster's round status DOTS: 3 bars green / 2 yellow / 1 red, the OUTLINE
 *  grey while the first measurement is still in flight or the server predates
 *  the /app/ping echo (the REST request latency keeps the number alive). */
const PING_GLYPHS: Record<ConnectionQualitySnapshot["state"], string> = {
  good: "mdi-signal-cellular-3",
  weak: "mdi-signal-cellular-2",
  bad: "mdi-signal-cellular-1",
  probing: "mdi-signal-cellular-outline",
  unsupported: "mdi-signal-cellular-outline",
};

function PingBadge({ quality }: { quality: ConnectionQualitySnapshot }): React.JSX.Element {
  const t = useT();
  const millis = quality.state === "unsupported" ? quality.lastRestMillis : quality.lastRttMillis;
  const text = quality.state === "probing" || millis === null
    ? quality.state === "unsupported" ? "—" : "…"
    : t("ping.msValue", { ms: millis });
  return (
    <span className={"ping-badge " + quality.state} title={pingBadgeTitle(t, quality)}>
      <span className={"icon ping-glyph " + (PING_GLYPHS[quality.state] ?? PING_GLYPHS.probing)} />
      <span className="ping-text">{text}</span>
    </span>
  );
}

function pingBadgeTitle(t: ReturnType<typeof useT>, quality: ConnectionQualitySnapshot): string {
  if (quality.state === "probing") {
    return t("ping.measuring");
  }
  if (quality.state === "unsupported") {
    return quality.lastRestMillis === null
      ? t("ping.unsupported")
      : t("ping.unsupportedLatency", { ms: quality.lastRestMillis });
  }
  const verdict = quality.state === "good" ? t("ping.stable") : quality.state === "weak" ? t("ping.unstable") : t("ping.poor");
  const window = quality.windowAvgMillis === null
    ? ""
    : t("ping.window", {
      avg: Math.round(quality.windowAvgMillis),
      min: quality.windowMinMillis ?? 0,
      max: quality.windowMaxMillis ?? 0,
    });
  const jitter = quality.jitterMillis === null ? "" : t("ping.jitter", { ms: Math.round(quality.jitterMillis) });
  const misses = quality.consecutiveMisses > 0
    ? t("ping.lostPings", { count: quality.consecutiveMisses })
    : "";
  return t("ping.verdictLine", { verdict, rtt: quality.lastRttMillis ?? 0, window, jitter, misses });
}
