import { el, clear } from "./dom";
import type { FeedInfo, VoiceRoomState } from "../types";

export interface RoomActions {
  leave(): void;
  toggleShare(): void;
  toggleTestTone(channel: "left" | "right"): void;
  setVoiceVolume(username: string, gain: number): void;
  setShareVolume(username: string, gain: number): void;
  toggleApm(): void;
  toggleViewing(feedId: number): void;
}

export interface RoomState {
  ownUsername: string;
  voiceState: VoiceRoomState;
  stateDetail: string | null;
  participants: FeedInfo[];
  speaking: ReadonlySet<string>;
  sharing: boolean;
  testToneChannel: "left" | "right" | null;
  apmEnabled: boolean;
  /** usernames currently muted at the source (badge only). */
  viewingFeedId: number | null;
}

export interface RoomView {
  /** Cold path: the participant set changed (join/leave/share state) — full rebuild. */
  rebuild(state: RoomState): void;
  /** Hot path: speaking ring toggles — imperative, no rebuild (10 Hz). */
  setSpeaking(username: string, speaking: boolean): void;
}

const VOICE_STATE_LABEL: Record<VoiceRoomState, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  live: "Voice connected",
  reconnecting: "Reconnecting…",
  failed: "Connection failed",
};

/**
 * The voice room: status bar, participant tiles (speaking ring + volume sliders),
 * toolbar. Tiles are kept in a username→element map so the 10 Hz speaking/level updates
 * never rebuild the grid (a rebuild would rip the range sliders out from under the cursor).
 */
export function renderRoom(container: HTMLElement, initial: RoomState, actions: RoomActions): RoomView {
  clear(container);
  const tiles = new Map<string, HTMLElement>();
  let lastParticipantsKey = "";

  const statusLine = el("div", { class: "voice-status" }, VOICE_STATE_LABEL[initial.voiceState]);
  const tileGrid = el("div", { class: "tile-grid" });
  const toolbar = el("div", { class: "room-toolbar" });
  const shareButton = el("button", {}, "Share screen");
  const toneLeftButton = el("button", { class: "ghost" }, "Tone L");
  const toneRightButton = el("button", { class: "ghost" }, "Tone R");
  const apmButton = el("button", { class: "ghost" }, "APM: on");
  const leaveButton = el("button", { class: "danger" }, "Leave");

  shareButton.addEventListener("click", () => actions.toggleShare());
  toneLeftButton.addEventListener("click", () => actions.toggleTestTone("left"));
  toneRightButton.addEventListener("click", () => actions.toggleTestTone("right"));
  apmButton.addEventListener("click", () => actions.toggleApm());
  leaveButton.addEventListener("click", () => actions.leave());
  toolbar.append(shareButton, toneLeftButton, toneRightButton, apmButton, leaveButton);

  const body = el("div", { class: "content-body" }, tileGrid);
  container.append(statusLine, body, toolbar);

  function tileUsername(feed: FeedInfo): string {
    return feed.display;
  }

  function buildTile(username: string, isSelf: boolean, isViewed: boolean, feedId: number | null): HTMLElement {
    const avatarLetter = (username[0] ?? "?").toUpperCase();
    const voiceSlider = el("input", { type: "range", min: 0, max: 200, value: 100 }) as HTMLInputElement;
    voiceSlider.value = localStorage.getItem(`space.vol.voice.${username}`) ?? "100";
    voiceSlider.addEventListener("input", () => {
      localStorage.setItem(`space.vol.voice.${username}`, String(voiceSlider.value));
      actions.setVoiceVolume(username, voiceSlider.valueAsNumber / 100);
    });
    const shareSlider = el("input", { type: "range", min: 0, max: 200, value: 100 }) as HTMLInputElement;
    shareSlider.value = localStorage.getItem(`space.vol.share.${username}`) ?? "100";
    shareSlider.addEventListener("input", () => {
      localStorage.setItem(`space.vol.share.${username}`, String(shareSlider.value));
      actions.setShareVolume(username, shareSlider.valueAsNumber / 100);
    });

    const watchButton = feedId === null ? null : el("button", { class: "ghost" }, isViewed ? "Stop watching" : "Watch screen");
    watchButton?.addEventListener("click", () => {
      if (feedId !== null) {
        actions.toggleViewing(feedId);
      }
    });

    return el("div", { class: "tile" + (isSelf ? " self" : "") },
      el("div", { class: "tile-head" },
        el("div", { class: "tile-avatar" }, avatarLetter),
        el("div", { class: "tile-name" }, username),
        el("div", { class: "tile-badges" }, isSelf ? "you" : ""),
      ),
      el("div", { class: "tile-controls" },
        el("label", {}, "voice"),
        voiceSlider,
        el("span", { class: "level-meter", "data-meter-voice": username }, "—"),
      ),
      el("div", { class: "tile-controls" },
        el("label", {}, "share"),
        shareSlider,
        el("span", { class: "level-meter", "data-meter-share": username }, "—"),
      ),
      watchButton ?? "",
    );
  }

  return {
    rebuild(state: RoomState): void {
      statusLine.className = "voice-status " + state.voiceState;
      statusLine.textContent = VOICE_STATE_LABEL[state.voiceState] + (state.stateDetail ? ` — ${state.stateDetail}` : "");
      shareButton.textContent = state.sharing ? "Stop sharing" : "Share screen";
      shareButton.className = state.sharing ? "on" : "";
      toneLeftButton.className = state.testToneChannel === "left" ? "on" : "ghost";
      toneRightButton.className = state.testToneChannel === "right" ? "on" : "ghost";
      apmButton.textContent = "APM: " + (state.apmEnabled ? "on" : "off");

      const participantsKey = state.participants.map((feed) => `${feed.feedId}:${feed.display}:${feed.streams.map((stream) => stream.mid + (stream.disabled ? "!" : "")).join(",")}`).join("|")
        + "#" + (state.viewingFeedId ?? -1);
      if (participantsKey === lastParticipantsKey) {
        for (const username of state.speaking) {
          tiles.get(username)?.classList.add("speaking");
        }
        return;
      }
      lastParticipantsKey = participantsKey;

      clear(tileGrid);
      tiles.clear();
      const ownTile = buildTile(state.ownUsername, true, false, null);
      tiles.set(state.ownUsername, ownTile);
      tileGrid.append(ownTile);
      for (const feed of state.participants) {
        const username = tileUsername(feed);
        const tile = buildTile(username, false, feed.feedId === state.viewingFeedId, feed.feedId);
        tiles.set(username, tile);
        tileGrid.append(tile);
      }
      for (const username of state.speaking) {
        tiles.get(username)?.classList.add("speaking");
      }
    },
    setSpeaking(username: string, speaking: boolean): void {
      tiles.get(username)?.classList.toggle("speaking", speaking);
    },
  };
}
