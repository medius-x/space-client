import { useEffect, useRef } from "react";

/**
 * A SQUARE icon button that matches its row's TEXT-button height exactly
 * (user request 2026-11-17, the log-archive reveal): the button stretches to
 * the row's height (align-self: stretch — the .reveal-button rule) and a
 * ResizeObserver sets the WIDTH to the measured height. Pure CSS cannot do
 * this: aspect-ratio does not derive a flex item's main size from a stretched
 * cross size in Chromium (live report — the button collapsed to glyph width).
 */
export function RevealIconButton({ title, onClick }: { title: string; onClick(): void }): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const element = buttonRef.current;
    if (element === null) {
      return;
    }
    // The observer fires once right after observe and on every later height
    // change — the square never drifts when the row's buttons resize.
    const observer = new ResizeObserver(() => {
      element.style.width = `${element.clientHeight}px`;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <button ref={buttonRef} className="icon-button reveal-button" title={title} onClick={onClick}>
      <span className="icon mdi-folder-open-outline" />
    </button>
  );
}
