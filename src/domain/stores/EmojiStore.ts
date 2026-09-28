import { Emitter } from "../lib/store";
import type { CustomEmoji } from "../../types";

export interface EmojiState {
  /** Name-ordered catalog (server contract). */
  emojis: readonly CustomEmoji[];
  /** false when the server predates the feature (GET /api/emojis → 404): the picker
   *  button and the settings section hide themselves. */
  supported: boolean;
  /** Derived lookups carried IN the snapshot so useStore selectors can return them
   *  by identity (rebuilding a Set/Map inside a selector is the infinite-rerender
   *  trap; both rebuild only in applySnapshot). */
  names: ReadonlySet<string>;
  byName: ReadonlyMap<string, CustomEmoji>;
}

const EMPTY_STATE: EmojiState = { emojis: [], supported: true, names: new Set(), byName: new Map() };

/**
 * The live custom-emoji catalog. Message text carries ":name:" tokens resolved
 * client-side against this store — segmenting needs a name set and rendering needs
 * the row itself; both live in the snapshot (identity-stable between snapshots,
 * rebuilt only on applySnapshot).
 */
export class EmojiStore extends Emitter {
  private state: EmojiState = EMPTY_STATE;

  getSnapshot = (): EmojiState => this.state;

  applySnapshot(emojis: readonly CustomEmoji[]): void {
    const sorted = [...emojis].sort((left, right) => left.name.localeCompare(right.name));
    this.state = {
      ...this.state,
      emojis: sorted,
      names: new Set(sorted.map((emoji) => emoji.name)),
      byName: new Map(sorted.map((emoji) => [emoji.name, emoji] as const)),
    };
    this.emit();
  }

  markUnsupported(): void {
    this.state = { ...EMPTY_STATE, supported: false };
    this.emit();
  }
}
