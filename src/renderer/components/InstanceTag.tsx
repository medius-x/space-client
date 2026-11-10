import { paletteColor } from "../../domain/logic/user-palette";
import { serverInitials } from "../../domain/logic/server-initials";
import { useAttachmentImage } from "../hooks/useAttachmentImage";

/**
 * oak's instance tag: a small server disc marking which instance an aggregated
 * friends/DM row belongs to (ids and usernames collide across instances). With
 * the instance's icon at hand it renders the icon through the DORMANT
 * attachment cache — disk-first (whatever the rail's live load already wrote
 * is an instant hit), then the row's own presigned URL. This used to be a bare
 * uncached fetch (useUncachedImage), which silently stayed initials forever on
 * instances where that direct fetch fails (live report 2026-11-10: server
 * icons missing from the DM column on a remote instance, fine on localhost
 * dev) — the cache path shares the rail's disk file and its [media] logging.
 * The palette initials disc stays oak's no-icon fallback.
 */
export function InstanceTag({ serverName, icon }: {
  serverName: string;
  icon?: { key: string; url: string | null } | null;
}): React.JSX.Element {
  const iconUrl = useAttachmentImage(null, icon ?? null);
  return (
    <span className="instance-tag" title={serverName} style={{ background: paletteColor(serverName) }}>
      {iconUrl !== null ? (
        <img src={iconUrl} alt={serverName} draggable={false} />
      ) : (
        serverInitials(serverName)
      )}
    </span>
  );
}
