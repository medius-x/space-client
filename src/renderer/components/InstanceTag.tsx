import { paletteColor } from "../../domain/logic/user-palette";
import { serverInitials } from "../../domain/logic/server-initials";
import { useUncachedImage } from "../hooks/useUncachedImage";

/**
 * oak's instance tag: a small server disc marking which instance an aggregated
 * friends/DM row belongs to (ids and usernames collide across instances). With
 * the instance's icon at hand it renders the icon (uncached presigned load —
 * these rows have no live session); the palette initials disc is oak's
 * no-icon fallback. The native title tooltip names the instance.
 */
export function InstanceTag({ serverName, icon }: {
  serverName: string;
  icon?: { key: string; url: string | null } | null;
}): React.JSX.Element {
  const iconUrl = useUncachedImage(icon ?? null);
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
