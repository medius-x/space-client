import { useEffect } from "react";

/** Overlay + card; the close button sits in the card's TOP-RIGHT corner (oak
 *  window chrome idiom), Escape and backdrop clicks close too. `bare` drops
 *  the dark backdrop — for dialogs whose own content does the dimming (crop). */
export function Modal({ title, children, onClose, wide, narrow, bare = false }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  /** Wider card for multi-pane settings surfaces (M7). */
  wide?: boolean;
  /** Narrower card for compact pickers (~⅔ width — the voice-invite dialog). */
  narrow?: boolean;
  /** No dark backdrop (the dialog dims its own content instead). */
  bare?: boolean;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={"modal-overlay" + (bare ? " bare" : "")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={"modal-card" + (wide === true ? " wide" : "") + (narrow === true ? " narrow" : "")}>
        <div className="modal-titlebar">
          <div className="modal-title">{title}</div>
          <button className="modal-close" title="Close" onClick={onClose}>
            <span className="icon mdi-close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
