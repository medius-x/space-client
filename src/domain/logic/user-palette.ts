/**
 * Deterministic username → color mapping (oak's AvatarService.PALETTE): the
 * same palette colors message-author nicks, quote authors and the letter
 * fallback avatars. Hash = djb2 — stable across sessions, cheap, and uniform
 * enough for a 12-color wheel.
 */
export const USER_PALETTE: readonly string[] = [
  "#5865f2", "#3ba55c", "#faa61a", "#ed4245",
  "#eb459e", "#9b59b6", "#1abc9c", "#e67e22",
  "#2ecc71", "#e91e63", "#00bcd4", "#8e44ad",
];

export function paletteColor(username: string): string {
  let hash = 5381;
  for (let index = 0; index < username.length; index++) {
    hash = ((hash << 5) + hash + username.charCodeAt(index)) | 0;
  }
  return USER_PALETTE[Math.abs(hash) % USER_PALETTE.length]!;
}
