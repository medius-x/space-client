import { Emitter } from "../lib/store";
import type { InviteLink } from "../../types";

export interface InvitesState {
  /** false until the first fetch lands — the section shows "Loading invites…". */
  loaded: boolean;
  /** The server's TTL setting in minutes (the field the settings screen edits). */
  ttlMinutes: number;
  /** The ACTIVE links (used/expired/revoked ones are gone server-side). */
  invites: readonly InviteLink[];
}

const EMPTY_STATE: InvitesState = { loaded: false, ttlMinutes: 1440, invites: [] };

/**
 * The live invite-link list of one connection. Fed by GET /api/invites and refreshed
 * on every /topic/invites ping (any mutation — a mint, an expiry, a TTL change, and
 * a REGISTRATION claiming a link: the spent row drops out of an open settings screen
 * without a reopen). The snapshot rides the wire response verbatim — no derived
 * collections, identity is trivially stable.
 */
export class InvitesStore extends Emitter {
  private state: InvitesState = EMPTY_STATE;

  getSnapshot = (): InvitesState => this.state;

  applySnapshot(ttlMinutes: number, invites: readonly InviteLink[]): void {
    this.state = { loaded: true, ttlMinutes, invites };
    this.emit();
  }
}
