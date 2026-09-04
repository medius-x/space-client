import { useEffect } from "react";

/** Overlay + card; the close button sits in the card's TOP-RIGHT corner (oak
 *  window chrome idiom), Escape and backdrop clicks close too. */
export function Modal({ title, children, onClose, wide }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  /** Wider card for multi-pane settings surfaces (M7). */
  wide?: boolean;
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
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={"modal-card" + (wide === true ? " wide" : "")}>
        <div className="modal-titlebar">
          <div className="modal-title">{title}</div>
          <button className="modal-close" title="Close" onClick={onClose}>
            <span className="icon mdi-close" style={{ fontSize: 16 }} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
