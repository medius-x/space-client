import { useSyncExternalStore } from "react";

/** The store contract: bound-stable subscribe + snapshot getter (see domain Emitter). */
interface StoreLike<State> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): State;
}

/**
 * Select a slice of a store. The selector MUST return a referentially stable value
 * across unrelated mutations (the store contract) — a fresh array/object here means
 * an infinite re-render loop.
 */
export function useStore<State, Slice>(store: StoreLike<State>, select: (snapshot: State) => Slice): Slice {
  const getSlice = () => select(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, getSlice, getSlice);
}
