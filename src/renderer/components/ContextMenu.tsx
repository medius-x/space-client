import { useRef } from "react";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  /** A thin rule instead of a row (oak's popupSeparator) — Call | — | Kick/Ban. */
  separator?: boolean;
  action: () => void;
}

/**
 * Lightweight right-click menu: fixed-position card. Any pointer press outside
 * (left OR right — so a second menu replaces the first), Escape, blur or
 * resize dismisses it.
 */
export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useOutsideDismiss(menuRef, onClose);

  const rows = items.filter((item) => !item.separator).length;
  const left = Math.min(Math.max(8, x), window.innerWidth - 190);
  const top = Math.min(Math.max(8, y), window.innerHeight - 8 - rows * 34);
  return (
    <div ref={menuRef} className="context-menu" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
      {items.map((item, index) => item.separator ? (
        <div key={`separator-${index}`} className="context-menu-separator" />
      ) : (
        <button
          key={item.label}
          className={"context-menu-item" + (item.danger ? " danger" : "")}
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
