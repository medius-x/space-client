import { useEffect, useState } from "react";
import { gameCoverUrl } from "../runtime";

/**
 * A game's cover thumbnail rendered from the SERVER-PROXIED bytes (V23): the picture
 * CDN is unreachable from some client machines, so every game picture the UI shows comes through our own server
 * as bytes and an object URL. While the bytes are in flight (or the game has
 * no picture at all) NOTHING renders — no broken-image boxes, ever.
 */
export function GameCoverThumb({ igdbId }: { igdbId: number }): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    void gameCoverUrl(igdbId).then((resolved) => {
      if (!cancelled) {
        setUrl(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [igdbId]);
  return url !== null
    ? <img alt="" src={url} />
    : <span className="game-pick-blank" />; /* the row keeps its geometry while the bytes fly */
}
