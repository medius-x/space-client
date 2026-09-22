import { useEffect, useState } from "react";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { dormantAttachmentCache } from "../../media/attachment-cache";

/** Cached image URL for render: instant from memory (no flash), async otherwise.
 *  A null session (no live connection) falls back to the DORMANT disk-only
 *  cache — saved server icons still render at an offline startup. */
export function useAttachmentImage(session: ConnectionSession | null, image: { key: string; url: string | null } | null): string | null {
  const cache = session !== null ? session.attachmentCache : dormantAttachmentCache();
  const [url, setUrl] = useState<string | null>(() => (image === null ? null : cache.peek(image.key)));

  useEffect(() => {
    if (image === null) {
      setUrl(null);
      return;
    }
    let alive = true;
    const immediate = cache.peek(image.key);
    if (immediate !== null) {
      setUrl(immediate);
    }
    void cache.loadImage(image).then((loaded) => {
      if (alive && loaded !== null) {
        setUrl(loaded);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- image identity is key+url
  }, [cache, image?.key, image?.url]);

  return url;
}
