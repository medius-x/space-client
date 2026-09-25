import { useEffect, useState } from "react";

/**
 * The borderless-window caption (oak's WindowChrome): a 32px #1e1f22 bar with
 * the brand on the left and 46×32 window buttons on the right — close hovers
 * red, the maximize glyph flips on restore. The bar drags the window (except
 * the buttons); double-click maximizes. Native Aero Snap is lost by design —
 * the price of the custom chrome (documented oak trade-off). The window
 * control IPC acts on the SENDER's window, so the same bar serves the main
 * window and the share pop-out (subtitle "Screen share").
 */
export function CaptionBar({ subtitle }: { subtitle?: string }): React.JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.spaceWindow?.onMaximizedChange(setMaximized);
  }, []);

  return (
    <div className="caption-bar">
      <span className="caption-brand">
        SPACE
        {subtitle === undefined ? null : <span className="caption-subtitle">{subtitle}</span>}
      </span>
      <div className="caption-buttons">
        <button className="caption-button" title="Minimize" onClick={() => window.spaceWindow?.minimize()}>
          <span className="icon mdi-window-minimize" />
        </button>
        <button className="caption-button" title={maximized ? "Restore" : "Maximize"} onClick={() => window.spaceWindow?.toggleMaximize()}>
          <span className={"icon " + (maximized ? "mdi-window-restore" : "mdi-window-maximize")} />
        </button>
        <button className="caption-button close" title="Close" onClick={() => window.spaceWindow?.close()}>
          <span className="icon mdi-close" />
        </button>
      </div>
    </div>
  );
}
