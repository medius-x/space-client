import { useEffect } from "react";

/** Overlay + card; Escape and backdrop clicks close. */
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
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}
