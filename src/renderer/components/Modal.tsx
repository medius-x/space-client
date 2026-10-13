import { useEffect } from "react";

/** Overlay + card; the close button sits in the card's TOP-RIGHT corner (oak
 *  window chrome idiom), Escape and backdrop clicks close too. `bare` drops
 *  the dark backdrop — for dialogs whose own content does the dimming (crop).
 *  `locked` freezes ALL THREE close paths: for surfaces with an in-flight
 *  background operation whose progress must not vanish behind a stray click
 *  (the provisioning run — live report 2026-10-13: a backdrop click hid the
 *  15-minute install screen; the run survived in the main process, but the
 *  UI was gone). Such a surface always offers its own explicit exit. */
export function Modal({ title, children, onClose, wide, narrow, bare = false, elevated = false, locked = false }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  /** Wider card for multi-pane settings surfaces (M7). */
  wide?: boolean;
  /** Narrower card for compact pickers (~⅔ width — the voice-invite dialog). */
  narrow?: boolean;
  /** No dark backdrop (the dialog dims its own content instead). */
  bare?: boolean;
  /** Above the settings overlay (z-100) — for dialogs opened FROM Server Settings. */
  elevated?: boolean;
  /** Block Escape, backdrop clicks and the close button (a live run owns the dialog). */
  locked?: boolean;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, locked]);

  return (
    <div
      className={"modal-overlay" + (bare ? " bare" : "") + (elevated ? " elevated" : "")}
      onMouseDown={(event) => {
        if (!locked && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={"modal-card" + (wide === true ? " wide" : "") + (narrow === true ? " narrow" : "")}>
        <div className="modal-titlebar">
          <div className="modal-title">{title}</div>
          <button className="modal-close" title={locked ? "Close (not while a setup run is in progress)" : "Close"} onClick={onClose} disabled={locked}>
            <span className="icon mdi-close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
