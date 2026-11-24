import { useEffect, useState } from "react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useT } from "../hooks/useT";

/** The live shape of the open field menu (the probe patches canPaste in). */
type InputEditMenuState = {
  x: number;
  y: number;
  hasSelection: boolean;
  hasValue: boolean;
  canPaste: boolean;
};

/**
 * The app-wide right-click menu for REAL input fields (input/textarea). The
 * composer is a contentEditable with its own styled menu and never matches
 * the selector, so the two never double up. Before this, Electron showed
 * NOTHING on a right click in the settings fields (no native menu is built
 * anywhere in the app) and only Ctrl+V worked — now every field offers
 * Cut/Copy/Paste/Select All in the app's own menu style (2026-11-24).
 *
 * Paste goes through main's webContents.paste() — a REAL paste event, which
 * the DOM APIs cannot synthesize (Chromium blocks execCommand("paste")). A
 * right click focuses the field in Chromium, so the execCommand verbs
 * (cut/copy/selectAll) operate on the clicked field.
 */
export function InputEditMenu(): React.JSX.Element | null {
  const t = useT();
  const [menu, setMenu] = useState<InputEditMenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      const field = target?.closest("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
      if (field === null || field.disabled || field.readOnly) {
        return;
      }
      event.preventDefault();
      const selectionStart = field.selectionStart;
      const selectionEnd = field.selectionEnd;
      setMenu({
        x: event.clientX,
        y: event.clientY,
        hasSelection: selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart,
        hasValue: field.value.length > 0,
        canPaste: false,
      });
      // Async probe (sees file-only clipboards — the DOM APIs cannot); a
      // transport hiccup falls back to ENABLED, the honest default for a
      // clipboard we cannot look into.
      void window.spaceEdit?.canPaste()
        .then((canPaste) => setMenu((current) =>
          current === null ? current : { ...current, canPaste: canPaste === true }))
        .catch(() => setMenu((current) =>
          current === null ? current : { ...current, canPaste: true }));
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  if (menu === null) {
    return null;
  }
  const items: ContextMenuItem[] = [
    { label: t("chat.cut"), disabled: !menu.hasSelection, action: () => document.execCommand("cut") },
    { label: t("chat.copy"), disabled: !menu.hasSelection, action: () => document.execCommand("copy") },
    { label: t("chat.paste"), disabled: !menu.canPaste, action: () => window.spaceEdit?.paste() },
    { separator: true },
    { label: t("chat.selectAll"), disabled: !menu.hasValue, action: () => document.execCommand("selectAll") },
  ];
  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} elevated />;
}
