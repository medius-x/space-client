/**
 * Minimal observable store — the whole "framework" of this spike. Views re-render from
 * subscriptions; inputs only commit on change events so a re-render never steals focus.
 */
export type Listener = () => void;

export class Store<State> {
  private state: State;
  private readonly listeners = new Set<Listener>();

  constructor(initial: State) {
    this.state = initial;
  }

  get(): State {
    return this.state;
  }

  /** Immutably patch the state and notify (skipped when nothing actually changed). */
  set(patch: Partial<State>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof State)[]) {
      if (this.state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
