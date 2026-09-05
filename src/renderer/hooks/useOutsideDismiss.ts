import { useEffect, type RefObject } from "react";

/**
 * Dismisses a floating surface (context menu, emoji picker, …) on any pointer
 * press OUTSIDE of it — including RIGHT-button presses, so opening a second
 * menu replaces the first one (oak's popup behavior; a plain "click" listener
 * misses right-clicks). Window blur, resize and Escape close it as well.
 */
export function useOutsideDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const surface = ref.current;
      if (surface === null || !surface.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [ref, onClose]);
}
