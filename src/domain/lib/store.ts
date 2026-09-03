/**
 * The whole state "framework": an emitter whose subscribe is BOUND ONCE so it is
 * referentially stable — the exact contract useSyncExternalStore needs.
 *
 * Hard rule for every store: snapshots must be REFERENTIALLY STABLE across unrelated
 * mutations — replace objects/arrays on write, never rebuild derived data inside the
 * selector/getSnapshot (a fresh array there = an infinite render loop).
 */
export abstract class Emitter {
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
