import { el, clear } from "./dom";
import type { Channel, UserSummary } from "../types";

export interface SidebarActions {
  joinVoiceChannel(channel: Channel): void;
}

export interface SidebarState {
  channels: Channel[];
  users: UserSummary[];
  presence: ReadonlySet<string>;
  /** channelId → usernames currently in that voice channel (from /topic/voice). */
  voiceMembers: ReadonlyMap<number, ReadonlySet<string>>;
  activeVoiceChannelId: number | null;
}

/**
 * Channel sidebar. Rebuilt on membership/presence changes only (cold path — a few events
 * per minute), so a plain full re-render is fine here; nothing focusable lives inside.
 */
export function renderSidebar(container: HTMLElement, state: SidebarState, actions: SidebarActions): void {
  clear(container);

  const voiceChannels = state.channels.filter((channel) => channel.type === "VOICE");
  container.append(el("div", { class: "sidebar-section-title" }, "Voice channels"));
  for (const channel of voiceChannels) {
    const row = el("div", {
      class: "channel-row"
        + (channel.id === state.activeVoiceChannelId ? " active" : "")
        + (channel.locked ? " locked" : ""),
      onclick: channel.locked ? undefined : () => actions.joinVoiceChannel(channel),
    }, "🔊 " + channel.name);
    container.append(row);

    if (channel.id === state.activeVoiceChannelId || state.voiceMembers.get(channel.id)?.size) {
      for (const username of state.voiceMembers.get(channel.id) ?? []) {
        container.append(el("div", { class: "member-row" },
          el("span", { class: "presence-dot online" }),
          username,
        ));
      }
    }
  }

  container.append(el("div", { class: "sidebar-section-title" }, "Online"));
  for (const user of state.users) {
    const online = state.presence.has(user.username);
    container.append(el("div", { class: "member-row" },
      el("span", { class: "presence-dot" + (online ? " online" : "") }),
      user.username,
    ));
  }
}
