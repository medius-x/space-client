import { useRef, useState } from "react";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";

/** A thin rule instead of a row (oak's popupSeparator) — the message menu's
 *  grouped sections (user request 2026-11-03). */
export type ContextMenuItem =
  | { separator: true }
  | {
    label: string;
    danger?: boolean;
    /** Greyed out and unclickable — the composer's Cut/Back-space rows when
     *  nothing is selected (the editor context menu, 2026-10-27). */
    disabled?: boolean;
    action: () => void;
    /** Narrowing tag only — a regular row is never a separator. */
    separator?: false;
    /** A nested menu opening to the RIGHT on hover (the spelling block,
     *  Telegram-style, user request 2026-11-03). One level deep; the parent
     *  row's action is a no-op — the submenu items do the work. */
    children?: ContextMenuItem[];
  };

/**
 * Lightweight right-click menu: fixed-position card. Any pointer press outside
 * (left OR right — so a second menu replaces the first), Escape, blur or
 * resize dismisses it. `anchor` (optional, a click-trigger element — the
 * sidebar's server header) counts as INSIDE the surface so its click can
 * toggle the menu closed instead of racing outside-dismiss into a reopen.
 */
export function ContextMenu({ x, y, items, onClose, anchor }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  anchor?: HTMLElement | null;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Latest-ref pattern: the ref object stays stable across renders (the dismiss
  // effect's identity), .current always tracks the anchor of THIS menu.
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = anchor ?? null;
  useOutsideDismiss(menuRef, onClose, anchorRef);
  // One open submenu at a time — keyed by the parent row's label.
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);

  const rows = items.filter((item) => !item.separator).length;
  const left = Math.min(Math.max(8, x), window.innerWidth - 190);
  const top = Math.min(Math.max(8, y), window.innerHeight - 8 - rows * 34);
  return (
    <div ref={menuRef} className="context-menu" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
      {items.map((item, index) => item.separator ? (
        <div key={`separator-${index}`} className="context-menu-separator" />
      ) : item.children !== undefined ? (
        <div
          key={item.label}
          className={"context-menu-submenu-wrap" + (openSubmenu === item.label ? " open" : "")}
          onMouseEnter={() => setOpenSubmenu(item.label)}
          onMouseLeave={() => setOpenSubmenu((current) => current === item.label ? null : current)}
        >
          <button
            className="context-menu-item has-submenu"
            disabled={item.disabled === true}
            onClick={() => setOpenSubmenu(item.label)}
          >
            {item.label}
            <span className="submenu-arrow" />
          </button>
          {openSubmenu === item.label ? (
            <div className="context-menu context-submenu">
              {item.children.map((child, childIndex) => child.separator ? (
                <div key={`separator-${childIndex}`} className="context-menu-separator" />
              ) : (
                <button
                  key={child.label}
                  className={"context-menu-item" + (child.danger ? " danger" : "")}
                  disabled={child.disabled === true}
                  onClick={() => {
                    onClose();
                    child.action();
                  }}
                >
                  {child.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          key={item.label}
          className={"context-menu-item" + (item.danger ? " danger" : "")}
          disabled={item.disabled === true}
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
