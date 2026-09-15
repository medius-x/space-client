import type { DmChannel } from "../../types";

/**
 * Pure DM display helpers (oak's DmNode naming rules):
 *  - 1:1 → the OTHER participant's NICKNAME (fallback: any participant, then
 *    "Direct Message" when the roster is somehow empty);
 *  - group → the stored name, else the participant list without me, else "Group".
 *  The username never renders — it is the lookup key only (the rename model).
 */

const PREVIEW_MAX_CHARS = 40;

export function dmDisplayName(dm: DmChannel, selfUsername: string): string {
  if (dm.type === "GROUP_DM") {
    if (dm.name.trim().length > 0) {
      return dm.name;
    }
    const others = dm.participants
      .filter((participant) => participant.username !== selfUsername)
      .map((participant) => participant.displayName ?? participant.username);
    return others.length > 0 ? others.join(", ") : "Group";
  }
  const peer = dm.participants.find((participant) => participant.username !== selfUsername);
  return peer?.displayName ?? peer?.username ?? dm.participants[0]?.displayName ?? dm.participants[0]?.username ?? "Direct Message";
}

/** One-line list preview under the DM name (oak's 40-char clamp). */
export function dmPreviewText(dm: DmChannel): string {
  if (dm.lastMessagePreview === null) {
    return "No messages yet";
  }
  const collapsed = dm.lastMessagePreview.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "No messages yet";
  }
  const prefixed = dm.lastMessageAuthorName !== null && dm.lastMessageAuthorName.length > 0
    ? `${dm.lastMessageAuthorName}: ${collapsed}`
    : collapsed;
  return prefixed.length > PREVIEW_MAX_CHARS
    ? `${prefixed.slice(0, PREVIEW_MAX_CHARS)}…`
    : prefixed;
}

/**
 * Live-message update of the preview fields. Edits only refresh the preview when
 * it was the LAST message — otherwise an edit of an old message would drag the
 * DM row back to the top (oak's guard).
 */
export function shouldRefreshPreview(dm: DmChannel, messageId: number): boolean {
  return dm.lastMessageId === null || dm.lastMessageId <= messageId;
}
