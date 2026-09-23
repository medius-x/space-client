import { Emitter } from "../domain/lib/store";
import { log } from "../logging";
import { RestClient } from "../core/rest";
import {
  backgroundDmCounts,
  backgroundServerCounts,
  type BackgroundSocialSnapshot,
} from "../domain/logic/social-aggregation";
import type { ConnectionDirectory } from "../domain/session/connection-record";
import type { ConnectionSession } from "../domain/session/connection-session";
import { EXPIRED_MARKER, RecordTokenStorage } from "../domain/session/connection-record";
import type { ChannelReadState } from "../types";

/**
 * oak phase 2: the aggregated friends/DM view is fed by LIVE background
 * sessions — one ConnectionSession per saved record, kept alive across
 * switches (see runtime's sessionMap). This controller subscribes to each
 * background session's stores and rebuilds the SNAPSHOT-SHAPED entries into
 * `socialDirectory` (so the panes keep one source), coalesced by oak's
 * 1-second badge debounce (first-mark throttle — a flood cannot starve it).
 * The REST snapshot loader stays as the FALLBACK for records that cannot hold
 * a session (dead token family, failed start): live entries and REST entries
 * never cover the same record.
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

// ---------------------------------------------------------------------------
// The live bindings (background sessions → snapshot-shaped entries)
// ---------------------------------------------------------------------------

interface LiveBinding {
  session: ConnectionSession;
  directory: ConnectionDirectory;
  unsubscribers: (() => void)[];
}

const liveBindings = new Map<string, LiveBinding>();
let rebuildTimer: number | null = null;

export function hasLiveSession(recordId: string): boolean {
  return liveBindings.has(recordId);
}

/** Subscribe a background session's stores; every emit schedules ONE coalesced
 *  rebuild (oak's bgBadgeDebounce — 1s after the FIRST pending change). The
 *  BINDING itself rebuilds IMMEDIATELY: it is structural (a record switched
 *  roles), and the 1 s delay made the Home DM list visibly oscillate — the
 *  demoted record's rows vanished for the window and popped back (live report). */
export function bindLiveBackgroundSession(session: ConnectionSession, directory: ConnectionDirectory): void {
  const binding: LiveBinding = { session, directory, unsubscribers: [] };
  liveBindings.set(session.recordId, binding);
  const touch = (): void => scheduleLiveRebuild();
  for (const store of [session.socialStore, session.readStateStore, session.rosterStore]) {
    binding.unsubscribers.push(store.subscribe(touch));
  }
  binding.unsubscribers.push(directory.subscribe(touch));
  rebuildLiveEntries();
}

export function unbindLiveBackgroundSession(recordId: string): void {
  const binding = liveBindings.get(recordId);
  if (binding === undefined) {
    return;
  }
  liveBindings.delete(recordId);
  for (const unsubscribe of binding.unsubscribers) {
    unsubscribe();
  }
  rebuildLiveEntries();
}

function scheduleLiveRebuild(): void {
  if (rebuildTimer !== null) {
    return; // first-mark throttle: a flood defers to the ALREADY armed tick
  }
  rebuildTimer = window.setTimeout(() => {
    rebuildTimer = null;
    rebuildLiveEntries();
  }, 1000);
}

/** Live entries replace any REST entry of the same record; REST entries for
 *  records WITHOUT a live session survive (the fallback). */
function rebuildLiveEntries(): void {
  const entries: BackgroundSocialSnapshot[] = [];
  for (const binding of liveBindings.values()) {
    entries.push(deriveLiveSnapshot(binding));
  }
  for (const fallback of socialDirectory.getSnapshot()) {
    if (!liveBindings.has(fallback.recordId)) {
      entries.push(fallback);
    }
  }
  socialDirectory.apply(entries);
}

function deriveLiveSnapshot(binding: LiveBinding): BackgroundSocialSnapshot {
  const { session, directory } = binding;
  const record = directory.get(session.recordId);
  const social = session.socialStore.getSnapshot();
  const roster = session.rosterStore.getSnapshot();
  const readStates = session.readStateStore.getSnapshot();
  const dmIds = new Set(social.dms.map((dm) => dm.id));
  const dmCounts = new Map<number, { unread: number; mention: number }>();
  let serverUnread = 0;
  let serverMention = 0;
  for (const [channelId, state] of readStates) {
    if (dmIds.has(channelId)) {
      dmCounts.set(channelId, { unread: state.unreadCount, mention: state.mentionCount });
    } else {
      serverUnread += state.unreadCount;
      serverMention += state.mentionCount;
    }
  }
  const profile = session.serverProfile;
  return {
    recordId: session.recordId,
    serverName: profile?.name ?? record?.cachedServerName ?? record?.hostUrl ?? "",
    selfUsername: record?.username ?? "?",
    serverAvatar: profile !== null && profile.avatarKey !== null && profile.avatarUrl !== null
      ? { key: profile.avatarKey, url: profile.avatarUrl }
      : null,
    relationships: social.relationships,
    dms: social.dms,
    onlineUsernames: roster.presence,
    dmCounts,
    serverCounts: { unread: serverUnread, mention: serverMention },
  };
}

// ---------------------------------------------------------------------------
// The REST fallback (records without a live session)
// ---------------------------------------------------------------------------

/** REST-snapshot every record that has NO live session; keeps previous
 *  snapshots on failure. */
export async function loadBackgroundSocial(directory: ConnectionDirectory, activeRecordId: string): Promise<void> {
  const targets = directory.getSnapshot().filter(
    (record) => record.id !== activeRecordId
      && record.token !== EXPIRED_MARKER
      && record.refreshToken !== ""
      && !hasLiveSession(record.id),
  );
  if (targets.length === 0) {
    if (socialDirectory.getSnapshot().some((entry) => !liveBindings.has(entry.recordId))) {
      // keep only the live entries — no fallback records remain
      socialDirectory.apply(socialDirectory.getSnapshot().filter((entry) => liveBindings.has(entry.recordId)));
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
  const entries = loaded.filter((entry): entry is BackgroundSocialSnapshot => entry !== null);
  // Compose with the LIVE entries (they own their records) and any leftover
  // fallback entries of records that were not targeted this round.
  for (const live of socialDirectory.getSnapshot()) {
    if (liveBindings.has(live.recordId) || entries.some((entry) => entry.recordId === live.recordId)) {
      continue;
    }
    if (targets.some((target) => target.id === live.recordId)) {
      continue; // a failed target already contributed its kept-previous entry (or nothing)
    }
    entries.push(live);
  }
  for (const binding of liveBindings.values()) {
    entries.push(deriveLiveSnapshot(binding));
  }
  socialDirectory.apply(entries);
}
