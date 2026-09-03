import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../src/domain/lib/store";

/** A minimal store shaped like the domain stores (getSnapshot + patch). */
class CounterStore extends Emitter {
  private state = { count: 0, name: "a" };

  getSnapshot = (): { count: number; name: string } => this.state;

  patch(partial: Partial<{ count: number; name: string }>): void {
    // The real stores own their equality check (AppStore does the same shallow compare).
    let changed = false;
    for (const key of Object.keys(partial) as ("count" | "name")[]) {
      if (this.state[key] !== partial[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return;
    }
    this.state = { ...this.state, ...partial };
    this.emit();
  }
}

describe("domain Emitter store contract", () => {
  it("subscribe is BOUND once — the same function reference every call (useSyncExternalStore)", () => {
    const store = new CounterStore();
    expect(store.subscribe).toBe(store.subscribe);
  });

  it("notifies only on real changes; snapshots are stable references until then", () => {
    const store = new CounterStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.getSnapshot();

    store.patch({ count: 0 }); // no-op
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(first);

    store.patch({ count: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot().count).toBe(1);

    unsubscribe();
    store.patch({ count: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
