import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store";

describe("Store", () => {
  it("notifies subscribers only when a value actually changes", () => {
    const store = new Store({ count: 0, name: "a" });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ count: 0 }); // no-op patch — same value
    expect(listener).not.toHaveBeenCalled();

    store.set({ count: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().count).toBe(1);
  });

  it("unsubscribe stops notifications", () => {
    const store = new Store<{ flag: boolean }>({ flag: false });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.set({ flag: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it("patches shallowly — untouched keys survive", () => {
    const store = new Store({ count: 0, name: "a" });
    store.set({ name: "b" });
    expect(store.get()).toEqual({ count: 0, name: "b" });
  });
});
