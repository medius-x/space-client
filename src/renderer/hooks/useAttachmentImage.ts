import { useEffect, useState } from "react";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { CacheableImage } from "../../media/attachment-cache";

/** Cached image URL for render: instant from memory (no flash), async otherwise. */
export function useAttachmentImage(session: ConnectionSession, image: CacheableImage | null): string | null {
  const [url, setUrl] = useState<string | null>(() => (image === null ? null : session.attachmentCache.peek(image.key)));

  useEffect(() => {
    if (image === null) {
      setUrl(null);
      return;
    }
    let alive = true;
    const immediate = session.attachmentCache.peek(image.key);
    if (immediate !== null) {
      setUrl(immediate);
    }
    void session.attachmentCache.loadImage(image).then((loaded) => {
      if (alive && loaded !== null) {
        setUrl(loaded);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- image identity is key+url
  }, [session, image?.key, image?.url]);

  return url;
}
