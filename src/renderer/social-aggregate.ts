import { Emitter } from "../domain/lib/store";
import { log } from "../logging";
import { RestClient } from "../core/rest";
import {
  backgroundDmCounts,
  backgroundServerCounts,
  type BackgroundSocialSnapshot,
} from "../domain/logic/social-aggregation";
import type { ConnectionDirectory } from "../domain/session/connection-record";
import { EXPIRED_MARKER, RecordTokenStorage } from "../domain/session/connection-record";
import type { ChannelReadState } from "../types";

/**
 * oak's aggregated friends/DM view, phase 1: REST SNAPSHOTS of every non-active
 * saved record (no background STOMP sessions — the live-push phase is the M8
 * background-session milestone). The unified Friends pane / DM list union these
 * snapshots with the active session's social store; they refresh on entering
 * the DM view and on every connection switch. A record whose token family died
 * keeps its LAST snapshot (rows stay until a fresh fetch succeeds) and is
 * skipped silently.
 */
class SocialDirectoryStore extends Emitter {
  private entries = new Map<string, BackgroundSocialSnapshot>();
  /** Referentially STABLE between mutations — a fresh array per getSnapshot()
   *  rips useSyncExternalStore into an infinite re-render loop (the M6 lesson). */
  private snapshot: BackgroundSocialSnapshot[] = [];

  getSnapshot = (): BackgroundSocialSnapshot[] => this.snapshot;

  apply(entries: BackgroundSocialSnapshot[]): void {
    this.entries = new Map(entries.map((entry) => [entry.recordId, entry]));
    this.snapshot = [...this.entries.values()];
    this.emit();
  }

  drop(recordId: string): void {
    if (this.entries.delete(recordId)) {
      this.snapshot = [...this.entries.values()];
      this.emit();
    }
  }
}

export const socialDirectory = new SocialDirectoryStore();

/** REST-snapshot every NON-active record; keeps previous snapshots on failure. */
export async function loadBackgroundSocial(directory: ConnectionDirectory, activeRecordId: string): Promise<void> {
  const targets = directory.getSnapshot().filter(
    (record) => record.id !== activeRecordId && record.token !== EXPIRED_MARKER && record.refreshToken !== "",
  );
  if (targets.length === 0) {
    if (socialDirectory.getSnapshot().length > 0) {
      socialDirectory.apply([]);
    }
    return;
  }
  const loaded = await Promise.all(targets.map(async (record) => {
    const client = new RestClient({
      baseUrl: record.hostUrl,
      tokenStorage: new RecordTokenStorage(directory, record.id),
    });
    try {
      const [relationships, dms, presence, readStates, profile] = await Promise.all([
        client.getRelationships(),
        client.getDmChannels(),
        client.getPresence(),
        client.getReadStates() as Promise<ChannelReadState[]>,
        client.getServerProfile(),
      ]);
      const dmIds = new Set(dms.map((dm) => dm.id));
      const snapshot: BackgroundSocialSnapshot = {
        recordId: record.id,
        serverName: profile.name ?? record.cachedServerName ?? record.hostUrl,
        selfUsername: record.username,
        serverAvatar: profile.avatarKey !== null && profile.avatarUrl !== null
          ? { key: profile.avatarKey, url: profile.avatarUrl }
          : null,
        relationships,
        dms,
        onlineUsernames: new Set(presence),
        dmCounts: backgroundDmCounts(readStates, dmIds),
        serverCounts: backgroundServerCounts(readStates, dmIds),
      };
      return snapshot;
    } catch (error) {
      log.info("social", `background snapshot for ${record.username} @ ${record.hostUrl} failed: ${error instanceof Error ? error.message : String(error)} — keeping the previous one`);
      return socialDirectory.getSnapshot().find((entry) => entry.recordId === record.id) ?? null;
    }
  }));
  socialDirectory.apply(loaded.filter((entry): entry is BackgroundSocialSnapshot => entry !== null));
}
