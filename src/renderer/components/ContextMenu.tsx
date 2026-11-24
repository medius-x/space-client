import { useEffect, useRef, useState } from "react";
import { useOutsideDismiss } from "../hooks/useOutsideDismiss";

/** How long a submenu stays open after the pointer leaves its wrap (parent
 *  row + submenu card). Without the grace, a DIAGONAL move toward a submenu
 *  item above or below the parent row crosses neighboring menu rows, leaves
 *  the wrap for a moment and the submenu snaps shut mid-travel (user report
 *  2026-11-04: reaching "Spelling"/"Formatting" items felt like surgery). */
const SUBMENU_CLOSE_GRACE_MS = 350;

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
    /** A small colored dot BEFORE the label (the status menu's status rows,
     *  user request 2026-11-17) — a CSS color string. */
    dot?: string;
    /** The row is the currently-chosen entry (the status submenu, user
     *  follow-up 2026-11-17) — a trailing check mark. */
    checked?: boolean;
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
export function ContextMenu({ x, y, items, onClose, anchor, elevated }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  anchor?: HTMLElement | null;
  /** Render ABOVE the full-screen overlays (z-index 150 > the settings
   *  overlay's 100) — the input-field menu opened over Server Settings. */
  elevated?: boolean;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Latest-ref pattern: the ref object stays stable across renders (the dismiss
  // effect's identity), .current always tracks the anchor of THIS menu.
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = anchor ?? null;
  useOutsideDismiss(menuRef, onClose, anchorRef);
  // One open submenu at a time — keyed by the parent row's label.
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  // Pending grace-close of a submenu the pointer just left — cancelled by any
  // re-entry (the wrap's onMouseEnter) so the diagonal travel above survives.
  const submenuCloseTimerRef = useRef<number | null>(null);
  const cancelSubmenuClose = (): void => {
    if (submenuCloseTimerRef.current !== null) {
      window.clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  };
  useEffect(() => cancelSubmenuClose, []);
  // Last pointermove sample — lets a row enter tell "settling on this row"
  // (vertical list navigation) from "flying right toward the submenu card"
  // (a diagonal that merely CROSSES neighboring rows on its way).
  const pointerXRef = useRef<number | null>(null);
  /** Entering a plain row closes the open submenu AT ONCE — unless the
   *  pointer just moved rightward, which is the diagonal flight the grace
   *  exists for (instant close on every crossing would bring the original
   *  bug back, user follow-up 2026-11-04: plain navigation felt sluggish). */
  const closeSubmenuUnlessFlyingRight = (event: React.MouseEvent): void => {
    const flyingRight = pointerXRef.current !== null && event.clientX - pointerXRef.current > 1;
    pointerXRef.current = event.clientX;
    if (openSubmenu === null || flyingRight) {
      return;
    }
    cancelSubmenuClose();
    setOpenSubmenu(null);
  };

  const rows = items.filter((item) => !item.separator).length;
  const left = Math.min(Math.max(8, x), window.innerWidth - 190);
  const top = Math.min(Math.max(8, y), window.innerHeight - 8 - rows * 34);
  return (
    <div
      ref={menuRef}
      className={"context-menu" + (elevated ? " elevated" : "")}
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
      onPointerMove={(event) => {
        pointerXRef.current = event.clientX;
      }}
    >
      {items.map((item, index) => item.separator ? (
        <div key={`separator-${index}`} className="context-menu-separator" />
      ) : item.children !== undefined ? (
        <div
          key={item.label}
          className={"context-menu-submenu-wrap" + (openSubmenu === item.label ? " open" : "")}
          onMouseEnter={() => {
            cancelSubmenuClose();
            setOpenSubmenu(item.label);
          }}
          onMouseLeave={() => {
            cancelSubmenuClose();
            submenuCloseTimerRef.current = window.setTimeout(() => {
              submenuCloseTimerRef.current = null;
              setOpenSubmenu((current) => current === item.label ? null : current);
            }, SUBMENU_CLOSE_GRACE_MS);
          }}
        >
          <button
            className="context-menu-item has-submenu"
            disabled={item.disabled === true}
            onClick={() => setOpenSubmenu(item.label)}
          >
            {item.dot !== undefined ? <span className="context-menu-dot" style={{ background: item.dot }} /> : null}
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
                  {child.dot !== undefined ? <span className="context-menu-dot" style={{ background: child.dot }} /> : null}
                  {child.label}
                  {child.checked === true ? <span className="icon mdi-check context-menu-check" /> : null}
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
          onMouseEnter={closeSubmenuUnlessFlyingRight}
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          {item.dot !== undefined ? <span className="context-menu-dot" style={{ background: item.dot }} /> : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}
