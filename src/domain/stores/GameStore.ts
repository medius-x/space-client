/**
 * The game-card cache of the IGDB auto-detect (round 2, 2026-11-19): every
 * card the renderer has seen (own detections, pick candidates, other members'
 * roster lines) keyed by IGDB id, plus the ONE pending pick dialog the
 * detector opens when the ladder answers "close, not equal". Cards are stable
 * by construction (the server caches them forever), so a card already present
 * is never replaced — only new ids emit.
 *
 * The snapshot is a frozen view object replaced wholesale on write (the
 * referential-stability rule of lib/store.ts).
 */
import type { GameCard } from "../../types";
import { Emitter } from "../lib/store";

/** The "which game is this?" dialog's payload: the identifying inputs the
 *  lookup carried (confirm re-sends them verbatim) + the offered candidates. */
export interface GamePickRequest {
  exeName: string;
  appId: string | null;
  folderName: string | null;
  candidates: GameCard[];
}

export interface GameStoreSnapshot {
  /** IGDB id → card, every card seen so far. */
  cards: ReadonlyMap<number, GameCard>;
  /** The pending pick dialog, null when closed. */
  pendingPick: GamePickRequest | null;
}

export class GameStore extends Emitter {
  private cards = new Map<number, GameCard>();
  private pendingPick: GamePickRequest | null = null;
  private view: GameStoreSnapshot = { cards: this.cards, pendingPick: null };

  getSnapshot = (): GameStoreSnapshot => this.view;

  /** Adds the cards not present yet; a no-op when everything is already cached. */
  applyCards(cards: readonly GameCard[]): void {
    let added = false;
    for (const card of cards) {
      if (!this.cards.has(card.igdbId)) {
        this.cards.set(card.igdbId, card);
        added = true;
      }
    }
    if (added) {
      this.view = { cards: this.cards, pendingPick: this.pendingPick };
      this.emit();
    }
  }

  /** Opens (or replaces) the pick dialog. */
  openPick(request: GamePickRequest): void {
    this.pendingPick = request;
    this.view = { cards: this.cards, pendingPick: request };
    this.emit();
  }

  /** Closes the dialog without a choice (the "skip" button, or the game closed). */
  closePick(): void {
    if (this.pendingPick !== null) {
      this.pendingPick = null;
      this.view = { cards: this.cards, pendingPick: null };
      this.emit();
    }
  }
}
