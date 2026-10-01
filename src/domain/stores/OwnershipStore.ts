import { Emitter } from "../lib/store";
import type { OwnershipTransfer } from "../../types";

export interface OwnershipState {
  /** false until the first fetch lands. */
  loaded: boolean;
  /** The live PENDING offer as seen by THIS member (null when not a party to it). */
  pending: OwnershipTransfer | null;
}

const EMPTY_STATE: OwnershipState = { loaded: false, pending: null };

/**
 * The live server-ownership offer of one connection: the single PENDING row from
 * GET /api/ownership/pending (fetched at session start, so a pending offer survives
 * the recipient being offline) and refreshed on every /user/queue/ownership push —
 * the reaction to every event type is the same refetch. The snapshot rides the wire
 * response verbatim — identity is trivially stable.
 */
export class OwnershipStore extends Emitter {
  private state: OwnershipState = EMPTY_STATE;

  getSnapshot = (): OwnershipState => this.state;

  applySnapshot(pending: OwnershipTransfer | null): void {
    this.state = { loaded: true, pending };
    this.emit();
  }

  clear(): void {
    this.state = EMPTY_STATE;
    this.emit();
  }
}
