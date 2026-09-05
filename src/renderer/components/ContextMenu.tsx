import { useRef } from "react";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
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

  const left = Math.min(Math.max(8, x), window.innerWidth - 190);
  const top = Math.min(Math.max(8, y), window.innerHeight - 8 - items.length * 34);
  return (
    <div ref={menuRef} className="context-menu" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
      {items.map((item) => (
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
