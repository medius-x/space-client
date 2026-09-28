import { useEffect, type RefObject } from "react";

/**
 * Dismisses a floating surface (context menu, emoji picker, …) on any pointer
 * press OUTSIDE of it — including RIGHT-button presses, so opening a second
 * menu replaces the first one (oak's popup behavior; a plain "click" listener
 * misses right-clicks). Window blur, resize and Escape close it as well.
 *
 * `anchorRef` (optional) marks a trigger element that counts as INSIDE the
 * surface: its own pointerdown does not dismiss, so the trigger's onClick can
 * toggle the surface honestly. Without it the sequence "outside-press closes →
 * click toggles open again" makes the toggle button unable to ever close the
 * surface (live report: the composer's emoji button reopened the picker).
 */
export function useOutsideDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  anchorRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const surface = ref.current;
      const anchor = anchorRef?.current ?? null;
      const target = event.target as Node;
      const inside = (surface !== null && surface.contains(target)) || (anchor !== null && anchor.contains(target));
      if (!inside) {
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
  }, [ref, onClose, anchorRef]);
}
