import { useEffect } from "react";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  action: () => void;
}

/** Lightweight right-click menu: fixed-position card, any click/blur/resize dismisses. */
export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const left = Math.min(Math.max(8, x), window.innerWidth - 190);
  const top = Math.min(Math.max(8, y), window.innerHeight - 8 - items.length * 34);
  return (
    <div className="context-menu" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
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
