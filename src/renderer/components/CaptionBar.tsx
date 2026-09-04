import { useEffect, useState } from "react";

/**
 * The borderless-window caption (oak's WindowChrome): a 32px #1e1f22 bar with
 * the brand on the left and 46×32 window buttons on the right — close hovers
 * red, the maximize glyph flips on restore. The bar drags the window (except
 * the buttons); double-click maximizes. Native Aero Snap is lost by design —
 * the price of the custom chrome (documented oak trade-off).
 */
export function CaptionBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.spaceWindow?.onMaximizedChange(setMaximized);
  }, []);

  return (
    <div className="caption-bar">
      <span className="caption-brand">SPACE</span>
      <div className="caption-buttons">
        <button className="caption-button" title="Minimize" onClick={() => window.spaceWindow?.minimize()}>
          <span className="icon mdi-window-minimize" style={{ fontSize: 16 }} />
        </button>
        <button className="caption-button" title={maximized ? "Restore" : "Maximize"} onClick={() => window.spaceWindow?.toggleMaximize()}>
          <span className={"icon " + (maximized ? "mdi-window-restore" : "mdi-window-maximize")} style={{ fontSize: 16 }} />
        </button>
        <button className="caption-button close" title="Close" onClick={() => window.spaceWindow?.close()}>
          <span className="icon mdi-close" style={{ fontSize: 16 }} />
        </button>
      </div>
    </div>
  );
}
