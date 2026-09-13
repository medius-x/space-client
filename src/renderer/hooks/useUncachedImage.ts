import { useEffect, useState } from "react";

/**
 * Session-less image load for rows of NON-active instances (the aggregated
 * friends/DM lists): a plain presigned fetch → blob URL, revoked on
 * change/unmount. The presigned URL is minted by the snapshot fetch itself, so
 * it is always fresh; there is no attachment cache to ride (that belongs to a
 * live ConnectionSession).
 */
export function useUncachedImage(image: { key: string; url: string | null } | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (image === null || image.url === null || image.key.length === 0) {
      setUrl(null);
      return;
    }
    let alive = true;
    let objectUrl: string | null = null;
    void globalThis.fetch(image.url)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!alive || blob === null) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- image identity is key+url
  }, [image?.key, image?.url]);

  return url;
}
