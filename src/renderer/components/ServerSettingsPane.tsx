import { useEffect, useMemo, useState } from "react";
import { useStore } from "../hooks/useStore";
import {
  appStore,
  closeServerSettings,
  setServerSettingsSection,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { connectionDirectory } from "../runtime";
import type {
  Channel,
  ChannelOverride,
  ChannelType,
  ChannelUserOverride,
  PermissionCatalogEntry,
  Role,
  ServerMember,
} from "../../types";
import {
  BAN_MEMBERS_PERMISSION,
  KICK_MEMBERS_PERMISSION,
  MANAGE_CHANNELS_PERMISSION,
  MANAGE_MEMBERS_PERMISSION,
  MANAGE_ROLES_PERMISSION,
  MANAGE_SERVER_PERMISSION,
} from "../../types";
import {
  ACCESS_MANAGED_PERMISSIONS,
  applyTriState,
  buildAccessWrites,
  channelEditablePermissions,
  inferAccessMode,
  inferGrantees,
  overrideMaps,
  triStateOf,
  type AccessMode,
  type PermissionSets,
  type TriState,
} from "../../domain/logic/channel-access";
import { argbIntToCss, memberNameColor } from "../../domain/logic/roster-grouping";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";

/**
 * The in-app server settings screen (oak's ServerSettingsWindow): section nav on
 * the left, content on the right, ESC/✕ closes. Section visibility is permission-
 * gated live; the wire pushes (/topic/roles, /topic/members, channels.changed)
 * refresh the stores, so a second client's edits re-render this screen too.
 */

/** Human names + one-line descriptions for the permission catalog (no tooltips — always visible). */
const PERMISSION_INFO: Record<string, { label: string; description: string }> = {
  ADMINISTRATOR: { label: "Administrator", description: "Every permission, bypassing channel overrides." },
  MANAGE_SERVER: { label: "Manage Server", description: "Rename the server and edit its icon." },
  MANAGE_ROLES: { label: "Manage Roles", description: "Create, edit, delete and reorder roles." },
  MANAGE_CHANNELS: { label: "Manage Channels", description: "Create, rename, delete channels and edit overrides." },
  MANAGE_MEMBERS: { label: "Manage Members", description: "Assign roles to members." },
  KICK_MEMBERS: { label: "Kick Members", description: "Disconnect members from the server." },
  BAN_MEMBERS: { label: "Ban Members", description: "Ban members from logging in, and unban." },
  MANAGE_NICKNAMES: { label: "Manage Nicknames", description: "Change other members' names." },
  CHANGE_NICKNAME: { label: "Change Nickname", description: "Change your own username." },
  VIEW_AUDIT_LOG: { label: "View Audit Log", description: "See the server's moderation history." },
  MANAGE_EMOJIS: { label: "Manage Emojis", description: "Upload and remove custom emoji." },
  SEND_MESSAGES: { label: "Send Messages", description: "Type in text channels." },
  MANAGE_MESSAGES: { label: "Manage Messages", description: "Delete and edit other members' messages." },
  ATTACH_FILES: { label: "Attach Files", description: "Upload images and files." },
  EMBED_LINKS: { label: "Embed Links", description: "Links render with a preview card." },
  READ_MESSAGE_HISTORY: { label: "Read Message History", description: "Read past messages." },
  MENTION_EVERYONE: { label: "Mention Everyone", description: "@everyone and @here ping everyone." },
  USE_EXTERNAL_EMOJIS: { label: "Use External Emojis", description: "Use emoji from other servers." },
  ADD_REACTIONS: { label: "Add Reactions", description: "React to messages." },
  CONNECT: { label: "Connect", description: "Join voice channels." },
  SPEAK: { label: "Speak", description: "Talk in voice channels." },
  MUTE_MEMBERS: { label: "Mute Members", description: "Server-mute members in voice." },
  DEAFEN_MEMBERS: { label: "Deafen Members", description: "Server-deafen members in voice." },
  MOVE_MEMBERS: { label: "Move Members", description: "Move members between voice channels." },
  USE_VAD: { label: "Use Voice Activity", description: "Speak without push-to-talk." },
  PRIORITY_SPEAKER: { label: "Priority Speaker", description: "Be heard over other speakers." },
  STREAM: { label: "Stream", description: "Share your screen or camera in voice." },
  REQUEST_TO_SPEAK: { label: "Request to Speak", description: "Ask to speak on stage channels." },
  VIEW_CHANNEL: { label: "View Channel", description: "See the channel at all." },
};

/** Permissions with no server endpoint behind them yet (marked in the editor, oak parity). */
const NOT_IMPLEMENTED: ReadonlySet<string> = new Set([
  "MANAGE_SERVER", "MANAGE_NICKNAMES", "CHANGE_NICKNAME", "VIEW_AUDIT_LOG", "MANAGE_EMOJIS",
  "MANAGE_MESSAGES", "EMBED_LINKS", "MENTION_EVERYONE", "USE_EXTERNAL_EMOJIS",
  "ADD_REACTIONS", "SPEAK", "USE_VAD", "PRIORITY_SPEAKER", "STREAM", "REQUEST_TO_SPEAK",
]);

const ROLE_PALETTE: readonly number[] = [
  0xff5865f2, 0xffeb459e, 0xfff47b67, 0xfff0b232, 0xff2dc770, 0xff23a55a,
  0xff00a8fc, 0xff3ba55c, 0xff9b59b6, 0xffe91e63, 0xffe67e22, 0xff99aab5,
];

function argbToHex(argb: number): string {
  return `#${(argb >>> 0).toString(16).padStart(8, "0").slice(2)}`;
}

function hexToArgb(hex: string): number | null {
  const match = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (match === null) {
    return null;
  }
  return Number.parseInt(`ff${match[1]!}`, 16) | 0; // keep the signed Java-int form
}

export function ServerSettingsPane({ session }: { session: ConnectionSession }): React.JSX.Element {
  const section = useStore(appStore, (state) => state.serverSettingsSection);
  const permissions = useStore(session.permissionStore, (state) => state.my?.permissions ?? []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeServerSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const can = (name: string): boolean => permissions.includes(name);
  const sections = [
    { key: "overview" as const, label: "Overview", enabled: can(MANAGE_SERVER_PERMISSION) },
    { key: "roles" as const, label: "Roles", enabled: can(MANAGE_ROLES_PERMISSION) },
    { key: "members" as const, label: "Members", enabled: can(MANAGE_MEMBERS_PERMISSION) || can(KICK_MEMBERS_PERMISSION) || can(BAN_MEMBERS_PERMISSION) },
    { key: "channels" as const, label: "Channels", enabled: can(MANAGE_CHANNELS_PERMISSION) },
  ].filter((entry) => entry.enabled);
  const active = sections.find((entry) => entry.key === section) ?? sections[0];

  return (
    <div className="settings-screen">
      <div className="settings-nav">
        <div className="settings-nav-title">Server Settings</div>
        {sections.map((entry) => (
          <button
            key={entry.key}
            className={"settings-nav-item" + (entry.key === active?.key ? " active" : "")}
            onClick={() => setServerSettingsSection(entry.key)}
          >
            {entry.label}
          </button>
        ))}
        <button className="settings-close" title="Close (Esc)" onClick={closeServerSettings}>✕ esc</button>
      </div>
      <div className="settings-body">
        {active === undefined ? (
          <div className="settings-empty">No settings sections available.</div>
        ) : active.key === "overview" ? (
          <OverviewSection session={session} />
        ) : active.key === "roles" ? (
          <RolesSection session={session} />
        ) : active.key === "members" ? (
          <MembersSection session={session} />
        ) : (
          <ChannelsSection session={session} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const record = connectionDirectory.get(session.recordId);
  const [name, setName] = useState(record?.cachedServerName ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy || trimmed === (record?.cachedServerName ?? "")) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await session.rest.renameServer(trimmed);
      setStatus("Saved.");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>Overview</h2>
      <label className="settings-field">
        <span>Server name</span>
        <input type="text" value={name} onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void submit();
            }
          }} />
      </label>
      <div className="settings-hint">The name shows on the rail and in the window title; everyone sees the change live.</div>
      <div className="modal-actions">
        <button className="primary" disabled={busy || name.trim().length === 0 || name.trim() === record?.cachedServerName} onClick={() => void submit()}>
          Save
        </button>
        <span className="settings-status">{status ?? ""}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function RolesSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const roles = useStore(session.memberStore, (state) => state.roles);
  const canManageMembers = useStore(session.permissionStore, (state) => state.my?.permissions.includes(MANAGE_MEMBERS_PERMISSION) ?? false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);

  const custom = roles.filter((role) => role.kind === "CUSTOM");
  const everyone = roles.find((role) => role.kind === "EVERYONE") ?? null; // OWNER is deliberately hidden
  const ordered = [...custom, ...(everyone !== null ? [everyone] : [])];
  const selected = ordered.find((role) => role.id === selectedId) ?? null;

  const createRole = async (): Promise<void> => {
    const taken = new Set(custom.map((role) => role.name));
    let name = "New role";
    let counter = 1;
    while (taken.has(name)) {
      counter += 1;
      name = `New role ${counter}`;
    }
    try {
      const role = await session.createRole(name);
      setSelectedId(role.id);
    } catch (error: unknown) {
      window.alert(`Could not create role: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const moveRole = async (roleId: number, direction: -1 | 1): Promise<void> => {
    const ids = custom.map((role) => role.id);
    const index = ids.indexOf(roleId);
    const swapWith = index + direction;
    if (index === -1 || swapWith < 0 || swapWith >= ids.length) {
      return;
    }
    [ids[index], ids[swapWith]] = [ids[swapWith]!, ids[index]!];
    try {
      await session.reorderRoles(ids);
    } catch (error: unknown) {
      window.alert(`Could not reorder: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="roles-layout">
      <div className="roles-list">
        <div className="roles-list-header">
          <span>Roles — {custom.length}</span>
          <button className="section-add" title="Create role" onClick={() => void createRole()}>+</button>
        </div>
        {ordered.map((role, index) => (
          <div
            key={role.id}
            className={"roles-row" + (role.id === selected?.id ? " active" : "")}
            onClick={() => setSelectedId(role.id)}
          >
            {role.kind === "CUSTOM" ? (
              <span className="role-order">
                <button className="ghost tiny" title="Move up" disabled={index === 0} onClick={(event) => {
                  event.stopPropagation();
                  void moveRole(role.id, -1);
                }}>↑</button>
                <button className="ghost tiny" title="Move down" disabled={index === custom.length - 1} onClick={(event) => {
                  event.stopPropagation();
                  void moveRole(role.id, 1);
                }}>↓</button>
              </span>
            ) : (
              <span className="role-order" />
            )}
            <span className="role-color-chip" style={{ background: role.color !== null ? argbIntToCss(role.color) : "var(--sp-control)" }} />
            <span className="role-name">{role.name}</span>
            {role.kind === "CUSTOM" ? (
              <button className="ghost tiny" title="Delete role" onClick={(event) => {
                event.stopPropagation();
                setDeleteTarget(role);
              }}>🗑</button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="role-editor">
        {selected === null ? (
          <div className="settings-empty">Select a role</div>
        ) : (
          <RoleEditor session={session} role={selected} canManageMembers={canManageMembers} />
        )}
      </div>
      {deleteTarget !== null ? (
        <ConfirmModal
          title="Delete role"
          note={`Delete role "${deleteTarget.name}"? It will be removed from all members.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await session.deleteRole(deleteTarget.id);
            if (selectedId === deleteTarget.id) {
              setSelectedId(null);
            }
          }}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  );
}

function RoleEditor({ session, role, canManageMembers }: {
  session: ConnectionSession;
  role: Role;
  canManageMembers: boolean;
}): React.JSX.Element {
  const [tab, setTab] = useState<"appearance" | "permissions" | "members">("appearance");
  const builtin = role.kind !== "CUSTOM";
  return (
    <div className="role-editor-inner">
      <div className="role-editor-head">
        <span className="role-editor-name" style={{ color: role.color !== null ? argbIntToCss(role.color) : undefined }}>
          {role.name}
        </span>
        <span className="settings-hint">{role.kind === "OWNER" ? "Protected role" : role.kind === "EVERYONE" ? "Default permissions" : ""}</span>
      </div>
      <div className="friends-tabs">
        <button className={"friends-tab" + (tab === "appearance" ? " active" : "")} onClick={() => setTab("appearance")}>Appearance</button>
        <button className={"friends-tab" + (tab === "permissions" ? " active" : "")} onClick={() => setTab("permissions")}>Permissions</button>
        {canManageMembers && !builtin ? (
          <button className={"friends-tab" + (tab === "members" ? " active" : "")} onClick={() => setTab("members")}>Members</button>
        ) : null}
      </div>
      {tab === "appearance" ? (
        <RoleAppearance session={session} role={role} />
      ) : tab === "permissions" ? (
        <RolePermissions session={session} role={role} />
      ) : (
        <RoleMembers session={session} role={role} />
      )}
    </div>
  );
}

function RoleAppearance({ session, role }: { session: ConnectionSession; role: Role }): React.JSX.Element {
  const builtin = role.kind !== "CUSTOM";
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<number | null>(role.color);
  const [customHex, setCustomHex] = useState(role.color !== null ? argbToHex(role.color) : "");
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [hoist, setHoist] = useState(role.hoist);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const dirty = !builtin && (name !== role.name || color !== role.color
    || mentionable !== role.mentionable || hoist !== role.hoist);

  const submit = async (): Promise<void> => {
    if (!dirty || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await session.updateRole(role.id, {
        name: name.trim(),
        // color is UNCONDITIONAL on the wire: null resets, so send the picked value.
        color,
        mentionable,
        hoist,
      });
      setStatus("Saved.");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
      setName(role.name); // a rejected name must not look saved
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="settings-field">
        <span>Title</span>
        <input type="text" value={name} disabled={builtin} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="settings-field">
        <span>Color</span>
        <div className="role-palette">
          {ROLE_PALETTE.map((preset) => (
            <button
              key={preset}
              className={"swatch" + (color === preset ? " chosen" : "")}
              style={{ background: argbIntToCss(preset) }}
              disabled={builtin}
              onClick={() => {
                setColor(preset);
                setCustomHex(argbToHex(preset));
              }}
            />
          ))}
          <button
            className={"swatch default" + (color === null ? " chosen" : "")}
            title="No color (default)"
            disabled={builtin}
            onClick={() => {
              setColor(null);
              setCustomHex("");
            }}
          >∅</button>
        </div>
      </div>
      {!builtin ? (
        <label className="settings-field">
          <span>Custom color (HEX)</span>
          <div className="role-hex-row">
            <input type="text" placeholder="#5865f2" value={customHex} onChange={(event) => {
              setCustomHex(event.target.value);
              const parsed = hexToArgb(event.target.value);
              if (parsed !== null) {
                setColor(parsed);
              }
            }} />
            <span className="swatch" style={{ background: color !== null ? argbIntToCss(color) : "var(--sp-control)" }} />
          </div>
        </label>
      ) : null}
      <label className="settings-check">
        <input type="checkbox" checked={mentionable} disabled={builtin} onChange={(event) => setMentionable(event.target.checked)} />
        <span>Mentionable</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={hoist} disabled={builtin} onChange={(event) => setHoist(event.target.checked)} />
        <span>Display separately (hoist)</span>
      </label>
      <div className="modal-actions">
        <button className="primary" disabled={!dirty || busy} onClick={() => void submit()}>Save Changes</button>
        <span className="settings-status">{status ?? ""}</span>
      </div>
    </div>
  );
}

function RolePermissions({ session, role }: { session: ConnectionSession; role: Role }): React.JSX.Element {
  const [catalog, setCatalog] = useState<readonly PermissionCatalogEntry[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set(role.permissions));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const roleSnapshot = useStore(session.memberStore, (state) => state.roles.find((entry) => entry.id === role.id) ?? role);

  useEffect(() => {
    void session.rest.getPermissionCatalog().then(setCatalog).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  }, [session]);

  // The store row may have refreshed after our own save — follow it unless we have local edits.
  useEffect(() => {
    setChecked(new Set(roleSnapshot.permissions));
  }, [roleSnapshot]);

  const dirty = !setsEqual(checked, new Set(roleSnapshot.permissions));

  const submit = async (): Promise<void> => {
    if (!dirty || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await session.updateRole(role.id, { permissions: [...checked] });
      setStatus("Saved.");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (role.kind === "OWNER") {
    return <div className="settings-empty">The OWNER role cannot be edited.</div>;
  }

  return (
    <div>
      <div className="settings-hint">
        Checked permissions are granted to everyone holding this role. VIEW_CHANNEL has no checkbox —
        the server always re-grants it to @everyone; visibility is owned by the Channels → Access tab.
      </div>
      {catalog === null ? (
        <div className="settings-empty">Loading catalog…</div>
      ) : (
        (["GENERAL", "TEXT", "VOICE"] as const).map((group) => {
          const entries = catalog.filter((entry) => entry.group === group && entry.name !== "VIEW_CHANNEL");
          if (entries.length === 0) {
            return null;
          }
          return (
            <div key={group}>
              <div className="friends-section">{group === "GENERAL" ? "General" : group === "TEXT" ? "Text" : "Voice"}</div>
              {entries.map((entry) => {
                const info = PERMISSION_INFO[entry.name] ?? { label: entry.name, description: "" };
                return (
                  <label key={entry.name} className="permission-row">
                    <input
                      type="checkbox"
                      checked={checked.has(entry.name)}
                      onChange={(event) => {
                        setChecked((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) {
                            next.add(entry.name);
                          } else {
                            next.delete(entry.name);
                          }
                          return next;
                        });
                      }}
                    />
                    <span className="permission-label">
                      {info.label}
                      {NOT_IMPLEMENTED.has(entry.name) ? <em className="not-implemented"> (not implemented yet)</em> : null}
                      <small>{info.description}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          );
        })
      )}
      <div className="modal-actions">
        <button className="primary" disabled={!dirty || busy} onClick={() => void submit()}>Save Changes</button>
        <span className="settings-status">{status ?? ""}</span>
      </div>
    </div>
  );
}

function RoleMembers({ session, role }: {
  session: ConnectionSession;
  role: Role;
}): React.JSX.Element {
  const members = useStore(session.memberStore, (state) => state.members);
  const roles = useStore(session.memberStore, (state) => state.roles);
  const [pickerOpen, setPickerOpen] = useState(false);
  const holders = members.filter((member) => member.roleIds.includes(role.id));
  const candidates = members.filter((member) => !member.roleIds.includes(role.id) && !member.owner);

  const setHolding = async (member: ServerMember, hold: boolean): Promise<void> => {
    const next = hold
      ? [...new Set([...member.roleIds, role.id])]
      : member.roleIds.filter((id) => id !== role.id);
    try {
      await session.rest.updateMemberRoles(member.userId, next);
    } catch (error: unknown) {
      window.alert(`Could not update roles: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div>
      <div className="settings-hint">Members holding this role. Assignment is a full-set PUT — the /topic/members push refreshes every viewer.</div>
      <div className="modal-actions">
        <button className="primary" disabled={candidates.length === 0} onClick={() => setPickerOpen(true)}>Add member</button>
      </div>
      {holders.length === 0 ? (
        <div className="settings-empty">No members have this role.</div>
      ) : (
        holders.map((member) => (
          <div key={member.userId} className="friend-row">
            <Avatar session={session} username={member.username} size={26} />
            <span className="member-name" style={{ color: memberNameColor(member, roles) ?? undefined }}>{member.username}</span>
            <button className="ghost friend-action" title="Remove role" onClick={() => void setHolding(member, false)}>×</button>
          </div>
        ))
      )}
      {pickerOpen ? (
        <Modal title={`Add members to ${role.name}`} onClose={() => setPickerOpen(false)}>
          <div className="friend-picker-list">
            {candidates.map((member) => (
              <div key={member.userId} className="friend-picker-row">
                <Avatar session={session} username={member.username} size={24} />
                <span>{member.username}</span>
                <button className="ghost" onClick={() => {
                  void setHolding(member, true);
                  setPickerOpen(false);
                }}>Add</button>
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setPickerOpen(false)}>Close</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members (moderation)
// ---------------------------------------------------------------------------

function MembersSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const members = useStore(session.memberStore, (state) => state.members);
  const roles = useStore(session.memberStore, (state) => state.roles);
  const permissions = useStore(session.permissionStore, (state) => state.my?.permissions ?? []);
  const [banned, setBanned] = useState<readonly ServerMember[]>([]);
  const [selected, setSelected] = useState<ServerMember | null>(null);

  const loadBans = (): void => {
    void session.rest.getBannedMembers().then(setBanned).catch((error: unknown) => {
      window.alert(`Could not load bans: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  useEffect(loadBans, [session]);

  const canKick = permissions.includes(KICK_MEMBERS_PERMISSION);
  const canBan = permissions.includes(BAN_MEMBERS_PERMISSION);
  const active = selected !== null ? members.find((member) => member.userId === selected.userId) ?? banned.find((member) => member.userId === selected.userId) ?? null : null;
  const selectedBanned = active !== null && banned.some((member) => member.userId === active.userId);

  return (
    <div className="roles-layout">
      <div className="roles-list">
        <div className="roles-list-header"><span>Members — {members.length}</span></div>
        {members.map((member) => (
          <div key={member.userId} className={"roles-row" + (member.userId === active?.userId ? " active" : "")}
            onClick={() => setSelected(member)}>
            <Avatar session={session} username={member.username} size={20} />
            <span className="member-name" style={{ color: memberNameColor(member, roles) ?? undefined }}>{member.username}</span>
            {member.owner ? <span className="owner-badge">OWNER</span> : null}
          </div>
        ))}
        {banned.length > 0 ? (
          <>
            <div className="roles-list-header"><span>Banned — {banned.length}</span></div>
            {banned.map((member) => (
              <div key={member.userId} className={"roles-row" + (member.userId === active?.userId ? " active" : "")}
                onClick={() => setSelected(member)}>
                <span className="member-name">{member.username}</span>
                <span className="banned-badge">BANNED</span>
              </div>
            ))}
          </>
        ) : null}
      </div>
      <div className="role-editor">
        {active === null ? (
          <div className="settings-empty">Select a member</div>
        ) : (
          <div>
            <h2>{active.username}</h2>
            <div className="settings-hint">Member actions</div>
            <div className="modal-actions">
              {selectedBanned ? (
                canBan ? (
                  <button className="primary" onClick={() => {
                    void session.unbanMember(active.userId).then(() => {
                      loadBans();
                      setSelected(null);
                    });
                  }}>Unban</button>
                ) : null
              ) : (
                <>
                  {canKick && !active.owner ? (
                    <button className="danger" onClick={() => {
                      void session.kickMember(active.userId).then(() => setSelected(null));
                    }}>Kick</button>
                  ) : null}
                  {canBan && !active.owner ? (
                    <button className="danger" onClick={() => {
                      void session.banMember(active.userId).then(() => {
                        loadBans();
                        setSelected(null);
                      });
                    }}>Ban</button>
                  ) : null}
                </>
              )}
            </div>
            <div className="settings-hint">Roles (managed in Roles → Members)</div>
            {active.roleIds.length === 0 ? (
              <div className="settings-empty">No roles</div>
            ) : (
              active.roleIds
                .map((roleId) => roles.find((entry) => entry.id === roleId))
                .filter((entry): entry is Role => entry !== undefined)
                .sort((left, right) => right.position - left.position)
                .map((entry) => (
                  <div key={entry.id} className="friend-row">
                    <span className="role-color-chip" style={{ background: entry.color !== null ? argbIntToCss(entry.color) : "var(--sp-control)" }} />
                    <span>{entry.name}</span>
                  </div>
                ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channels (tri-state overrides + Access)
// ---------------------------------------------------------------------------

function ChannelsSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const channels = useStore(session.channelStore, (channels) => channels);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const list = channels.filter((channel) => channel.type === "TEXT" || channel.type === "VOICE");
  const selected = list.find((channel) => channel.id === selectedId) ?? null;

  return (
    <div className="roles-layout">
      <div className="roles-list">
        <div className="roles-list-header"><span>Channels — {list.length}</span></div>
        {list.map((channel) => (
          <div key={channel.id} className={"roles-row" + (channel.id === selected?.id ? " active" : "")}
            onClick={() => setSelectedId(channel.id)}>
            <span>{channel.type === "VOICE" ? "🔊" : "#"} {channel.name}{channel.locked ? " 🔒" : ""}</span>
          </div>
        ))}
      </div>
      <div className="role-editor">
        {selected === null ? (
          <div className="settings-empty">Select a channel</div>
        ) : (
          <ChannelEditor session={session} channel={selected} />
        )}
      </div>
    </div>
  );
}

function ChannelEditor({ session, channel }: { session: ConnectionSession; channel: Channel }): React.JSX.Element {
  const [tab, setTab] = useState<"permissions" | "access">("permissions");
  return (
    <div className="role-editor-inner">
      <div className="role-editor-head">
        <span className="role-editor-name">{channel.type === "VOICE" ? "🔊" : "#"} {channel.name}</span>
      </div>
      <div className="friends-tabs">
        <button className={"friends-tab" + (tab === "permissions" ? " active" : "")} onClick={() => setTab("permissions")}>Permissions</button>
        <button className={"friends-tab" + (tab === "access" ? " active" : "")} onClick={() => setTab("access")}>Access</button>
      </div>
      {tab === "permissions" ? (
        <ChannelPermissionsTab session={session} channel={channel} />
      ) : (
        <ChannelAccessTab session={session} channel={channel} />
      )}
    </div>
  );
}

function ChannelPermissionsTab({ session, channel }: {
  session: ConnectionSession;
  channel: Channel;
}): React.JSX.Element {
  const roles = useStore(session.memberStore, (state) => state.roles);
  const [catalog, setCatalog] = useState<readonly PermissionCatalogEntry[] | null>(null);
  const [overrides, setOverrides] = useState<Map<number, PermissionSets> | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = (): void => {
    void session.rest.getChannelOverrides(channel.id).then((rows: ChannelOverride[]) => {
      setOverrides(overrideMaps(rows, []).roleOverrides);
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  };
  useEffect(load, [session, channel.id]);
  useEffect(() => {
    void session.rest.getPermissionCatalog().then(setCatalog).catch(() => undefined);
  }, [session]);

  const editableRoles = roles.filter((role) => role.kind !== "OWNER");
  const selectedRole = editableRoles.find((role) => role.id === selectedRoleId) ?? null;
  const sets = selectedRole !== null && overrides !== null
    ? overrides.get(selectedRole.id) ?? { allow: [], deny: [] }
    : null;

  const setState = (permission: string, next: TriState): void => {
    if (selectedRole === null || sets === null || overrides === null) {
      return;
    }
    const updated = applyTriState(sets, permission, next);
    setOverrides(new Map(overrides).set(selectedRole.id, updated));
  };

  const submit = async (): Promise<void> => {
    if (selectedRole === null || sets === null || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await session.rest.upsertChannelOverride(channel.id, selectedRole.id, sets);
      setStatus("Saved.");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="settings-hint">
        Allow (✓) / Deny (✗) per permission; Inherit (—) uses the role's base. Deny @everyone
        SEND_MESSAGES = a read-only channel. VIEW_CHANNEL lives in the Access tab.
      </div>
      <label className="settings-field">
        <span>Role</span>
        <select value={selectedRole?.id ?? ""} onChange={(event) => setSelectedRoleId(event.target.value === "" ? null : Number(event.target.value))}>
          <option value="">Select a role…</option>
          {editableRoles.map((role) => (
            <option key={role.id} value={role.id}>{role.name}</option>
          ))}
        </select>
      </label>
      {selectedRole === null || sets === null || catalog === null ? (
        <div className="settings-empty">{overrides === null ? "Loading…" : "Pick a role to edit overrides."}</div>
      ) : (
        <>
          {channelEditablePermissions(catalog).map((entry) => (
            <div key={entry.name} className="tri-row">
              <TriStateControl
                label={PERMISSION_INFO[entry.name]?.label ?? entry.name}
                state={triStateOf(entry.name, sets)}
                onChange={(next) => setState(entry.name, next)}
              />
            </div>
          ))}
          <div className="modal-actions">
            <button className="primary" disabled={busy} onClick={() => void submit()}>Save Changes</button>
            <button className="ghost" disabled={busy} onClick={() => {
              void session.rest.deleteChannelOverride(channel.id, selectedRole.id).then(() => {
                load();
                setStatus("Row deleted — the role's base applies.");
              });
            }}>Reset to inherit</button>
            <span className="settings-status">{status ?? ""}</span>
          </div>
        </>
      )}
    </div>
  );
}

function TriStateControl({ label, state, onChange }: {
  label: string;
  state: TriState;
  onChange(next: TriState): void;
}): React.JSX.Element {
  return (
    <div className="tri-control">
      <span className="tri-label">{label}</span>
      <div className="tri-buttons">
        {(["allow", "inherit", "deny"] as const).map((candidate) => (
          <button
            key={candidate}
            className={"tri-button " + candidate + (state === candidate ? " chosen" : "")}
            title={candidate === "allow" ? "Allow" : candidate === "deny" ? "Deny" : "Inherit"}
            onClick={() => onChange(candidate)}
          >
            {candidate === "allow" ? "✓" : candidate === "deny" ? "✗" : "—"}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChannelAccessTab({ session, channel }: {
  session: ConnectionSession;
  channel: Channel;
}): React.JSX.Element {
  const roles = useStore(session.memberStore, (state) => state.roles);
  const members = useStore(session.memberStore, (state) => state.members);
  const [state, setState] = useState<{
    mode: AccessMode;
    roleOverrides: Map<number, PermissionSets>;
    userOverrides: Map<number, PermissionSets>;
    grantedRoleIds: Set<number>;
    grantedUserIds: Set<number>;
    everyoneRoleId: number | null;
    usernames: Map<number, string>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      session.rest.getChannelOverrides(channel.id),
      session.rest.getChannelUserOverrides(channel.id),
    ]).then(([roleRows, userRows]: [ChannelOverride[], ChannelUserOverride[]]) => {
      if (cancelled) {
        return;
      }
      const maps = overrideMaps(roleRows, userRows);
      // Read the roles from the store AT LOAD TIME (not the render closure) and keep
      // them out of the deps — an unrelated roles push must not wipe unsaved edits.
      const everyoneRoleId = session.memberStore.getSnapshot().roles.find((role) => role.kind === "EVERYONE")?.id ?? null;
      const everyoneDeny = new Set(maps.roleOverrides.get(everyoneRoleId ?? -1)?.deny ?? []);
      const mode = inferAccessMode(everyoneDeny, channel.type as ChannelType);
      const grantees = inferGrantees(mode, channel.type as ChannelType, maps.roleOverrides, maps.userOverrides);
      setState({
        mode,
        ...maps,
        grantedRoleIds: new Set(grantees.roleIds),
        grantedUserIds: new Set(grantees.userIds),
        everyoneRoleId,
        usernames: new Map(userRows.map((row) => [row.userId, row.username])),
      });
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [session, channel.id, channel.type]);

  if (state === null) {
    return <div className="settings-empty">{status ?? "Loading…"}</div>;
  }

  const submit = async (): Promise<void> => {
    if (busy || state.everyoneRoleId === null) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const writes = buildAccessWrites({
        channelType: channel.type as ChannelType,
        mode: state.mode,
        roleOverrides: state.roleOverrides,
        userOverrides: state.userOverrides,
        everyoneRoleId: state.everyoneRoleId,
        grantedRoleIds: [...state.grantedRoleIds],
        grantedUserIds: [...state.grantedUserIds],
      });
      for (const write of writes) {
        if (write.remove) {
          if (write.kind === "role") {
            await session.rest.deleteChannelOverride(channel.id, write.id);
          } else {
            await session.rest.deleteChannelUserOverride(channel.id, write.id);
          }
        } else if (write.allow.length > 0 || write.deny.length > 0) {
          if (write.kind === "role") {
            await session.rest.upsertChannelOverride(channel.id, write.id, { allow: write.allow, deny: write.deny });
          } else {
            await session.rest.upsertChannelUserOverride(channel.id, write.id, { allow: write.allow, deny: write.deny });
          }
        }
      }
      setStatus("Saved.");
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const grantableRoles = roles.filter((role) => role.kind === "CUSTOM");

  return (
    <div>
      <div className="settings-hint">
        Locked: everyone sees the channel, only the listed roles/members can use it.
        Hidden: everyone else does not see it at all. Writes the same overrides as the
        Permissions tab (managed set: {ACCESS_MANAGED_PERMISSIONS.join(", ")}).
      </div>
      <label className="settings-field">
        <span>Visibility</span>
        <select value={state.mode} onChange={(event) => {
          const mode = event.target.value as AccessMode;
          setState({ ...state, mode });
        }}>
          <option value="public">Public</option>
          <option value="locked">Locked</option>
          <option value="hidden">Hidden</option>
        </select>
      </label>
      {state.mode === "public" ? (
        <div className="settings-hint">Public — no access lists.</div>
      ) : (
        <>
          <div className="friends-section">Roles with access</div>
          {grantableRoles.length === 0 ? (
            <div className="settings-empty">No custom roles to grant.</div>
          ) : (
            grantableRoles.map((role) => (
              <label key={role.id} className="settings-check">
                <input
                  type="checkbox"
                  checked={state.grantedRoleIds.has(role.id)}
                  onChange={(event) => {
                    const next = new Set(state.grantedRoleIds);
                    if (event.target.checked) {
                      next.add(role.id);
                    } else {
                      next.delete(role.id);
                    }
                    setState({ ...state, grantedRoleIds: next });
                  }}
                />
                <span className="role-color-chip" style={{ background: role.color !== null ? argbIntToCss(role.color) : "var(--sp-control)" }} />
                <span>{role.name}</span>
              </label>
            ))
          )}
          <div className="friends-section">Members with access</div>
          {[...state.grantedUserIds].map((userId) => (
            <div key={userId} className="friend-row">
              <Avatar session={session} username={state.usernames.get(userId) ?? `#${userId}`} size={24} />
              <span>{state.usernames.get(userId) ?? `user ${userId}`}</span>
              <button className="ghost friend-action" onClick={() => {
                const next = new Set(state.grantedUserIds);
                next.delete(userId);
                setState({ ...state, grantedUserIds: next });
              }}>×</button>
            </div>
          ))}
          <label className="settings-field">
            <span>Add member</span>
            <select value="" onChange={(event) => {
              const userId = Number(event.target.value);
              if (!Number.isNaN(userId)) {
                const member = members.find((entry) => entry.userId === userId);
                const nextUsers = new Set(state.grantedUserIds);
                nextUsers.add(userId);
                const nextNames = new Map(state.usernames);
                if (member) {
                  nextNames.set(userId, member.username);
                }
                setState({ ...state, grantedUserIds: nextUsers, usernames: nextNames });
              }
            }}>
              <option value="">Pick a member…</option>
              {members
                .filter((member) => !state.grantedUserIds.has(member.userId) && !member.owner)
                .map((member) => (
                  <option key={member.userId} value={member.userId}>{member.username}</option>
                ))}
            </select>
          </label>
        </>
      )}
      <div className="modal-actions">
        <button className="primary" disabled={busy} onClick={() => void submit()}>Save Changes</button>
        <span className="settings-status">{status ?? ""}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function ConfirmModal({ title, note, confirmLabel, onConfirm, onClose }: {
  title: string;
  note: string;
  confirmLabel: string;
  onConfirm(): Promise<void>;
  onClose(): void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-note">{note}</div>
      <div className="error-line">{error ?? ""}</div>
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="danger" disabled={busy} onClick={() => {
          setBusy(true);
          void onConfirm().then(onClose).catch((error_: unknown) => {
            setError(error_ instanceof Error ? error_.message : String(error_));
            setBusy(false);
          });
        }}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const name of left) {
    if (!right.has(name)) {
      return false;
    }
  }
  return true;
}
