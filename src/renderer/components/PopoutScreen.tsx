import { useEffect, useState } from "react";

/**
 * The share pop-out window's entire UI: the JPEG frame stream relayed by the main
 * process. MediaStream objects cannot cross renderer contexts, so the pop-out is a
 * frame viewer, not a WebRTC consumer.
 */
export function PopoutScreen(): React.JSX.Element {
  const [frame, setFrame] = useState<string | null>(null);

  useEffect(() => {
    window.spaceWindow?.onFrame((dataUrl) => setFrame(dataUrl));
  }, []);

  return (
    <div className="popout-root">
      {frame !== null
        ? <img src={frame} alt="Shared screen" draggable={false} />
        : <div className="popout-waiting">Waiting for the video…</div>}
    </div>
  );
}
