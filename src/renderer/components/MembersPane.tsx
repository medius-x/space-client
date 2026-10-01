import { useMemo, useState } from "react";
import { useStore } from "../hooks/useStore";
import { appStore, callUser } from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Role, ServerMember } from "../../types";
import { BAN_MEMBERS_PERMISSION, KICK_MEMBERS_PERMISSION } from "../../types";
import { buildRosterGroups, canActOn, topPosition, type HierarchyView } from "../../domain/logic/roster-grouping";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";

/**
 * The member roster as its OWN right-hand column (oak parity: 190px pane next to
 * the chat, not a section of the channel sidebar). Hoist grouping, role nick
 * colors, the owner crown; the context menu carries Call + Kick/Ban moderation.
 */
export function MembersPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const roster = useStore(session.rosterStore, (state) => state);
  const memberRoster = useStore(session.memberStore, (state) => state);
  const myPermissions = useStore(session.permissionStore, (state) => state.my);
  const ownUsername = useStore(appStore, (state) => state.ownUsername);
  const activeVoiceChannelId = useStore(appStore, (state) => state.activeVoiceChannelId);
  const [memberMenu, setMemberMenu] = useState<{ member: ServerMember; x: number; y: number } | null>(null);
  const [kickTarget, setKickTarget] = useState<ServerMember | null>(null);
  const [banTarget, setBanTarget] = useState<ServerMember | null>(null);

  const rosterGroups = useMemo(
    () => memberRoster.members.length > 0
      ? buildRosterGroups(memberRoster.members, memberRoster.roles, roster.presence, ownUsername)
      : null,
    [memberRoster, roster.presence, ownUsername],
  );

  const selfHierarchy = useMemo(() => {
    const selfMember = ownUsername === null
      ? null
      : memberRoster.members.find((member) => member.username === ownUsername) ?? null;
    return {
      owner: myPermissions?.owner ?? false,
      topPosition: selfMember !== null ? topPosition(selfMember, memberRoster.roles) : null,
    };
  }, [memberRoster, myPermissions, ownUsername]);

  const moderationMenuItems = moderationEntries(
    memberMenu?.member ?? null,
    selfHierarchy,
    myPermissions?.permissions ?? [],
    memberRoster.roles,
  );
  const memberMenuItems: ContextMenuItem[] = memberMenu === null ? [] : [
    ...(roster.presence.has(memberMenu.member.username)
      ? [{ label: "Call", action: () => callUser(memberMenu.member.username) }]
      : []),
    // The roster twin of the voice channel's hover button: sitting in a room,
    // right-click a member → invite them THERE (the same live card; an offline
    // target is not offered the entry for the same reason Call hides itself).
    ...(roster.presence.has(memberMenu.member.username) && activeVoiceChannelId !== null
      ? [{ label: "Voice invite", action: () => session.sendVoiceInvite(activeVoiceChannelId, memberMenu.member.username) }]
      : []),
    // oak's member card: a separator rule between the personal action and the
    // moderation block (showMemberMenu).
    ...(roster.presence.has(memberMenu.member.username) && moderationMenuItems.length > 0
      ? [{ label: "", separator: true, action: () => undefined }]
      : []),
    ...moderationMenuItems.map((entry) => ({
      ...entry,
      action: () => {
        if (entry.kind === "kick") {
          setKickTarget(memberMenu.member);
        } else {
          setBanTarget(memberMenu.member);
        }
      },
    })),
  ];

  return (
    <aside className="members-pane">
      {rosterGroups !== null ? (
        rosterGroups.map((group) => (
          <div key={group.key}>
            <div className="pane-title roster-group-title" style={group.titleColor !== null ? { color: group.titleColor } : undefined}>
              {group.title}
            </div>
            {group.entries.map((entry) => (
              <MemberRow
                key={entry.member.userId}
                session={session}
                member={entry.member}
                online={entry.online}
                isSelf={entry.isSelf}
                nameColor={entry.nameColor}
                onMenu={(event) => {
                  event.preventDefault();
                  if (entry.member.username !== ownUsername) {
                    setMemberMenu({ member: entry.member, x: event.clientX, y: event.clientY });
                  }
                }}
              />
            ))}
          </div>
        ))
      ) : (
        <>
          <div className="pane-title">Online — {roster.users.filter((user) => roster.presence.has(user.username)).length}</div>
          {roster.users.map((user) => (
            <div key={user.id} className="member-row">
              {/* The dot rides EVERY avatar (Discord): green = online, grey = offline. */}
              <Avatar session={session} username={user.username} size={32} showPresence online={roster.presence.has(user.username)} />
              <span className="member-name">{user.displayName ?? user.username}</span>
            </div>
          ))}
        </>
      )}

      {memberMenu !== null ? (
        <ContextMenu x={memberMenu.x} y={memberMenu.y} items={memberMenuItems} onClose={() => setMemberMenu(null)} />
      ) : null}
      {kickTarget !== null ? (
        <ModerationModal
          verb="Kick"
          session={session}
          member={kickTarget}
          text={`Kick "${kickTarget.nickname}"? They will be disconnected from the server.`}
          onClose={() => setKickTarget(null)}
        />
      ) : null}
      {banTarget !== null ? (
        <ModerationModal
          verb="Ban"
          session={session}
          member={banTarget}
          text={`Ban "${banTarget.nickname}"? They will no longer be able to log in.`}
          onClose={() => setBanTarget(null)}
        />
      ) : null}
    </aside>
  );
}

/** One roster row: 36px avatar with the presence dot overlaid (oak's MemberNode). */
function MemberRow({ session, member, online, isSelf, nameColor, onMenu }: {
  session: ConnectionSession;
  member: ServerMember;
  online: boolean;
  isSelf: boolean;
  nameColor: string | null;
  onMenu: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  return (
    <div className={"member-row" + (online ? "" : " offline")} onContextMenu={onMenu}>
      {/* Discord: the presence dot rides EVERY avatar — green online, grey
          offline (a missing dot read as "no status", live report). */}
      <Avatar session={session} username={member.username} size={36} showPresence online={online} />
      <span className="member-name" style={{ color: nameColor ?? (online ? "var(--sp-text)" : "var(--sp-text-muted)") }}>
        {member.nickname}{isSelf ? " (you)" : ""}
      </span>
      {member.owner ? <span className="owner-badge" title="Server owner">👑</span> : null}
    </div>
  );
}

/** Kick/Ban menu entries — gated by the permission bit AND the hierarchy hint. */
function moderationEntries(target: ServerMember | null, selfHierarchy: HierarchyView, permissions: readonly string[], roles: readonly Role[]): { kind: "kick" | "ban"; label: string }[] {
  if (target === null) {
    return [];
  }
  const targetView: HierarchyView = { owner: target.owner, topPosition: topPosition(target, roles) };
  if (!canActOn(selfHierarchy, targetView)) {
    return [];
  }
  const items: { kind: "kick" | "ban"; label: string }[] = [];
  if (permissions.includes(KICK_MEMBERS_PERMISSION)) {
    items.push({ kind: "kick", label: "Kick" });
  }
  if (permissions.includes(BAN_MEMBERS_PERMISSION)) {
    items.push({ kind: "ban", label: "Ban" });
  }
  return items;
}

function ModerationModal({ verb, session, member, text, onClose }: {
  verb: "Kick" | "Ban";
  session: ConnectionSession;
  member: ServerMember;
  text: string;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (verb === "Kick") {
        await session.kickMember(member.userId);
      } else {
        await session.banMember(member.userId);
      }
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  };

  return (
    <Modal title={`${verb} member`} onClose={onClose}>
      <div className="modal-note">{text}</div>
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="danger" disabled={busy} onClick={() => void submit()}>{verb}</button>
      </div>
    </Modal>
  );
}
