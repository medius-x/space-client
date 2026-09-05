/**
 * The rail placeholder for a server without an icon: a colored disc carrying
 * the name's initials. Port of oak's AvatarService.serverInitials — the first
 * letters of the first ~2 words ("My OAK" → "MO"), so a server reads as its
 * name rather than a username's single letter.
 */
export function serverInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "?";
  }
  const initials: string[] = [];
  for (const word of trimmed.split(/\s+/)) {
    if (word.length === 0) {
      continue;
    }
    initials.push(word.charAt(0).toUpperCase());
    if (initials.length === 2) {
      break;
    }
  }
  return initials.join("");
}
