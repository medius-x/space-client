import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { log } from "../../logging";
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
  StorageStatus,
} from "../../types";
import {
  BAN_MEMBERS_PERMISSION,
  CHANGE_NICKNAME_PERMISSION,
  KICK_MEMBERS_PERMISSION,
  MANAGE_CHANNELS_PERMISSION,
  MANAGE_MEMBERS_PERMISSION,
  MANAGE_NICKNAMES_PERMISSION,
  MANAGE_ROLES_PERMISSION,
  MANAGE_SERVER_PERMISSION,
  MANAGE_STORAGE_PERMISSION,
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
import { argbIntToCss, canActOn, memberNameColor, topPosition } from "../../domain/logic/roster-grouping";
import { ApiError } from "../../core/rest";
import { moveRoleIdTowards } from "../../domain/logic/role-drag";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import { AvatarEditor, serverAvatarApi } from "./ProfileModal";
import { ChannelGlyph } from "./ChannelGlyph";
import { ColorPickerDialog } from "./ColorPickerDialog";
import { ServerIconPreview } from "./ServerRail";

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

/**
 * oak's EXACT role palette (ServerSettingsWindow.presetColors): 11 hues
 * {0,30,50,90,130,165,190,220,260,300,330} + a grey column, bright row
 * hsb(h,.78,.95) over muted hsb(h,.58,.60) — 12 columns × 2 rows, swatch 28px.
 * Mapped through `| 0`: the wire carries ARGB as a SIGNED Java int, and the
 * raw literals (> 0x7fffffff) 400 at the server's JSON parse (live report).
 */
const ROLE_PALETTE_TOP: readonly number[] = [
  0xfff23535, 0xfff29435, 0xfff2d335, 0xff94f235, 0xff35f255, 0xff35f2c3,
  0xff35d3f2, 0xff3574f2, 0xff7435f2, 0xfff235f2, 0xfff23594, 0xffd9d9d9,
].map((argb) => argb | 0);
const ROLE_PALETTE_BOTTOM: readonly number[] = [
  0xff994040, 0xff996d40, 0xff998a40, 0xff6d9940, 0xff40994f, 0xff409983,
  0xff408a99, 0xff405e99, 0xff5e4099, 0xff994099, 0xff99406d, 0xff808080,
].map((argb) => argb | 0);

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
    { key: "server" as const, label: "Server", enabled: can(MANAGE_STORAGE_PERMISSION) },
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
        ) : active.key === "server" ? (
          <ServerStorageSection session={session} />
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
  const serverName = record?.cachedServerName ?? "";
  const [name, setName] = useState(serverName);
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || busy || trimmed === serverName) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await session.rest.renameServer(trimmed);
      setSaved(true);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {/* The heading styled EXACTLY like the roles-list-header label ("Roles — N"). */}
      <div className="roles-list-header overview-heading"><span>Overview</span></div>
      {/* The server name rides under the heading in the role-name typography,
          edited by the same hover pencil (inline, caret at the end). */}
      <div className="role-editor-title-row">
        {editingName ? (
          <input
            className="role-editor-name-input"
            autoFocus
            value={name}
            style={{ width: `${Math.max(name.length, serverName.length, 4) + 1}ch` }}
            onFocus={(event) => {
              event.target.setSelectionRange(event.target.value.length, event.target.value.length);
            }}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setEditingName(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                setEditingName(false);
                void submit();
              } else if (event.key === "Escape") {
                setName(serverName); // cancel — back to the stored name
                setEditingName(false);
              }
            }}
          />
        ) : (
          <span className="role-editor-name">{serverName}</span>
        )}
        {!editingName ? (
          <button className="ghost tiny role-editor-pencil" title="Rename server" onClick={() => {
            setName(serverName);
            setEditingName(true);
          }}>
            <span className="icon mdi-pencil" />
          </button>
        ) : null}
      </div>
      <AvatarEditor
        session={session}
        api={serverAvatarApi(session)}
        preview={<ServerIconPreview session={session} size={96} />}
        stacked
        removeTitle="Remove server icon"
        removeNote="Remove the server icon? This cannot be undone."
      />
      <div className="modal-actions left">
        <SaveButton
          label="Save Changes"
          saved={saved}
          dirty={name.trim().length > 0 && name.trim() !== serverName}
          busy={busy}
          onClick={() => void submit()}
        />
        {status !== null ? <span className="settings-status">{status}</span> : null}
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
  /** The drag in flight (oak's draggedRole): the dragged role renders as the
   *  drop gap, drag-over live-previews the position, the drop persists. */
  const [draggedId, setDraggedId] = useState<number | null>(null);
  /** Optimistic order while a drag is live; null = the store's order. A drag
   *  cancelled without a drop just drops this — the store is the truth. */
  const [previewIds, setPreviewIds] = useState<readonly number[] | null>(null);
  /** Pointer-drag bookkeeping: the press that MIGHT become a drag (movement
   *  past the threshold commits it) and the list container for hit-testing. */
  const dragCandidateRef = useRef<{ roleId: number; startX: number; startY: number } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The floating copy of the dragged row — driven IMPERATIVELY (transform on
   *  pointermove) so the hot path never re-renders React. */
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const everyone = roles.find((role) => role.kind === "EVERYONE") ?? null; // OWNER is deliberately hidden
  const custom = roles.filter((role) => role.kind === "CUSTOM");
  const storeIds = custom.map((role) => role.id);
  const orderedIds = previewIds ?? storeIds;
  const ordered = [
    ...orderedIds.map((id) => roleById.get(id)).filter((role): role is Role => role !== undefined),
    ...(everyone !== null ? [everyone] : []),
  ];
  const selected = ordered.find((role) => role.id === selectedId) ?? null;

  const createRole = async (): Promise<void> => {
    const taken = new Set(custom.map((role) => role.name));
    // The default name must already pass the server's role-name validation
    // ([\p{L}\p{N}_-]{1,32} — any alphabet, no spaces); "New-role" is the
    // user-picked default (user decision; renaming in the editor is free-form).
    let name = "New-role";
    let counter = 1;
    while (taken.has(name)) {
      counter += 1;
      name = `New-role-${counter}`;
    }
    try {
      const role = await session.createRole(name);
      setSelectedId(role.id);
    } catch (error: unknown) {
      // The alert is momentary — the failure (with the exact name sent) must also
      // land in space.log; a silent-server 400 here was twice blamed on the client
      // (ResponseStatusException never reaches the server's own log).
      const message = error instanceof Error ? error.message : String(error);
      log.error("settings", `role create failed (name="${name}"): ${message}`);
      window.alert(`Could not create role: ${message}`);
    }
  };

  // The shared drag-over/drop math (oak's moveDraggedTo): above the target's
  // midline inserts before it, below — after; the pinned @everyone row appends.
  // Returns the resulting order so the DROP can persist exactly what it previewed.
  const previewTowards = (targetRoleId: number | null, belowTarget: boolean): readonly number[] => {
    const currentIds = previewIds ?? storeIds;
    if (draggedId === null) {
      return currentIds;
    }
    const next = moveRoleIdTowards(currentIds, draggedId, targetRoleId, belowTarget);
    if (next !== currentIds) {
      setPreviewIds(next);
    }
    return next;
  };

  const persistOrder = async (ids: readonly number[]): Promise<void> => {
    try {
      await session.reorderRoles(ids);
      // The optimistic preview STAYS until the refetched store catches up —
      // clearing it right on the drop let the list flash back to the OLD order
      // for the PUT+refetch round trip (live report).
    } catch (error: unknown) {
      // The alert is momentary — the SAME failure must land in space.log (and
      // the diag panel) or a "periodic reorder error" is undebuggable after
      // the dialog is dismissed (live report). A failed reorder rolls the
      // preview back to the store's truth.
      const message = error instanceof Error ? error.message : String(error);
      log.error("settings", `role reorder failed (${ids.length} ids): ${message}`);
      window.alert(`Could not reorder: ${message}`);
      setPreviewIds(null);
    }
  };

  // The catch-up: once the store's order equals the optimistic preview, drop
  // the preview and let the store be the truth again.
  useEffect(() => {
    if (previewIds === null) {
      return;
    }
    if (previewIds.length === storeIds.length && previewIds.every((id, index) => id === storeIds[index])) {
      setPreviewIds(null);
    }
  }, [previewIds, storeIds]);

  const clearDrag = (): void => {
    setDraggedId(null);
    setPreviewIds(null);
  };

  // The drag itself is POINTER-DRIVEN, not HTML5 DnD: the native drag paints
  // its own system cursor (the flickering forbidden circle over any area that
  // missed a dragover-preventDefault — live report ×2, uncureable from JS) and
  // Chromium drops the session when the node under the pointer moves (the
  // "works every other time" drop bug). A pointer drag owns the cursor via CSS
  // and no DOM reorder can interrupt it.
  useEffect(() => {
    // Re-asserted on every (re)subscribe: the commit-time add is wiped moments
    // later when this effect re-runs on the draggedId change — its CLEANUP
    // removes the class and nothing re-added it, so the grabbing cursor flashed
    // and fell back to default mid-drag (live report).
    if (draggedId !== null) {
      document.body.classList.add("role-dragging");
    }
    const onPointerMove = (event: PointerEvent): void => {
      const candidate = dragCandidateRef.current;
      if (candidate === null) {
        return;
      }
      if (draggedId === null) {
        if (Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY) < 4) {
          return; // still a press, not a drag — a click must stay a click
        }
        setDraggedId(candidate.roleId);
        document.body.classList.add("role-dragging");
      }
      if (ghostRef.current !== null) {
        // The floating copy rides beside the pointer (a touch right and below,
        // like the native drag image used to); "positioned" reveals it — until
        // the first transform it stays hidden (a 0,0 flash otherwise).
        ghostRef.current.style.transform = `translate(${event.clientX + 12}px, ${event.clientY - 14}px)`;
        ghostRef.current.classList.add("positioned");
      }
      if (listRef.current !== null) {
        const hit = dropPositionUnderPointer(listRef.current, event.clientY);
        if (hit !== null) {
          previewTowards(hit.targetRoleId, hit.belowTarget);
        }
      }
    };
    const onPointerUp = (event: PointerEvent): void => {
      const wasDragging = draggedId !== null;
      dragCandidateRef.current = null;
      document.body.classList.remove("role-dragging");
      if (!wasDragging) {
        return;
      }
      const hit = listRef.current !== null ? dropPositionUnderPointer(listRef.current, event.clientY) : null;
      const finalIds = hit !== null ? previewTowards(hit.targetRoleId, hit.belowTarget) : previewIds ?? storeIds;
      if (finalIds !== storeIds) {
        void persistOrder(finalIds);
      }
      // Drop the DRAG (the gap row), keep the PREVIEW order — it is the
      // optimistic truth until the refetched store matches it.
      setDraggedId(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && draggedId !== null) {
        dragCandidateRef.current = null;
        document.body.classList.remove("role-dragging");
        clearDrag();
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("role-dragging");
    };
  }, [draggedId, storeIds, previewIds]);

  // The drop target is the LIST CONTAINER, never a row: the live preview
  // REORDERS the rows while dragging, and Chromium silently drops the drag
  // session when the node under the pointer gets moved — the drop then never
  // fires and the dragEnd rollback eats the reorder (the "works every other
  // time" live report). The container is stable; the position comes from
  // hit-testing the rows by pointer geometry.
  const dropPositionUnderPointer = (container: HTMLElement, clientY: number): { targetRoleId: number | null; belowTarget: boolean } | null => {
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-role-id]"));
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        if (row.dataset.roleDragged === "true") {
          return null; // over the gap itself — keep the current preview
        }
        if (row.dataset.roleKind === "EVERYONE") {
          return { targetRoleId: null, belowTarget: true }; // hovering @everyone → append
        }
        return { targetRoleId: Number(row.dataset.roleId), belowTarget: clientY > rect.top + rect.height / 2 };
      }
    }
    if (rows.length > 0) {
      const last = rows[rows.length - 1]!;
      if (clientY > last.getBoundingClientRect().bottom) {
        return { targetRoleId: null, belowTarget: true }; // below every row → append
      }
    }
    return null;
  };

  return (
    <div className="roles-layout">
      <div className="roles-list" ref={listRef}>
        <div className="roles-list-header">
          <span>Roles — {custom.length}</span>
          <button className="section-add" title="Create role" onClick={() => void createRole()}>+</button>
        </div>
        {ordered.map((role) => {
          const isDragged = draggedId === role.id;
          const draggable = role.kind === "CUSTOM";
          return (
            <div
              key={role.id}
              className={"roles-row"
                + (draggable ? " draggable" : "")
                + (role.id === selected?.id ? " active" : "")
                + (isDragged ? " drop-gap" : "")}
              data-role-id={role.id}
              data-role-kind={role.kind}
              data-role-dragged={isDragged ? "true" : undefined}
              onClick={() => setSelectedId(role.id)}
              onPointerDown={(event) => {
                // The press that may become a drag; the window-level
                // pointermove commits it past the threshold. Left button only.
                if (event.button === 0 && draggable) {
                  dragCandidateRef.current = { roleId: role.id, startX: event.clientX, startY: event.clientY };
                }
              }}
            >
              <span className={"role-grip" + (draggable ? "" : " pinned")}>⠿</span>
              <span className="role-color-chip" style={{ background: role.color !== null ? argbIntToCss(role.color) : "var(--sp-role-chip-default)" }} />
              <span className="role-name">{role.name}</span>
              {role.kind === "CUSTOM" ? (
                <button className="ghost tiny" title="Delete role" onClick={(event) => {
                  event.stopPropagation();
                  setDeleteTarget(role);
                }}><span className="icon mdi-trash-can" /></button>
              ) : null}
            </div>
          );
        })}
      </div>
      {draggedId !== null ? (() => {
        // The floating snapshot of the dragged row (the native drag image died
        // with HTML5 DnD) — the list itself shows the gap, the ghost shows WHAT
        // is being dragged. Position is imperative (ghostRef), never React.
        const ghostRole = roleById.get(draggedId);
        return ghostRole !== undefined ? (
          <div ref={ghostRef} className="roles-row drag-ghost">
            <span className="role-grip">⠿</span>
            <span className="role-color-chip" style={{ background: ghostRole.color !== null ? argbIntToCss(ghostRole.color) : "var(--sp-role-chip-default)" }} />
            <span className="role-name">{ghostRole.name}</span>
          </div>
        ) : null;
      })() : null}
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
  // The editable name lives HERE (the pencil in the title row replaces the old
  // Title field) — reset on selection change so a switch never carries the
  // previous role's draft (the same stale-state class the tabs are keyed for).
  const [name, setName] = useState(role.name);
  const [editingName, setEditingName] = useState(false);
  useEffect(() => {
    setName(role.name);
    setEditingName(false);
  }, [role.id]);
  return (
    <div className="role-editor-inner">
      <div className="role-editor-head">
        {/* oak: the editor column is captioned "Role details" (pane-title in a
            24px row, on the same line as the left column's "Roles" header). */}
        <div className="pane-title role-editor-caption">Role details</div>
        <div className="role-editor-title-row">
          {editingName ? (
            <input
              className="role-editor-name-input"
              autoFocus
              value={name}
              /* The field IS the label: same font, same color, no chrome — the
                  only cue of edit mode is the caret at the end (user decision). */
              style={{
                width: `${Math.max(name.length, role.name.length, 4) + 1}ch`,
                color: role.color !== null ? argbIntToCss(role.color) : undefined,
              }}
              onFocus={(event) => {
                event.target.setSelectionRange(event.target.value.length, event.target.value.length);
              }}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setEditingName(false);
                } else if (event.key === "Escape") {
                  setName(role.name); // cancel — back to the stored name
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <span className="role-editor-name" style={{ color: role.color !== null ? argbIntToCss(role.color) : undefined }}>
              {role.name}
            </span>
          )}
          {!builtin && !editingName && tab === "appearance" ? (
            <button className="ghost tiny role-editor-pencil" title="Rename role" onClick={() => setEditingName(true)}>
              <span className="icon mdi-pencil" />
            </button>
          ) : null}
          <span className="settings-hint">{role.kind === "OWNER" ? "Protected role" : role.kind === "EVERYONE" ? "Default permissions" : ""}</span>
        </div>
      </div>
      <div className="settings-tabs">
        <button className={"settings-tab" + (tab === "appearance" ? " active" : "")} onClick={() => setTab("appearance")}>Appearance</button>
        <button className={"settings-tab" + (tab === "permissions" ? " active" : "")} onClick={() => setTab("permissions")}>Permissions</button>
        {canManageMembers && !builtin ? (
          <button className={"settings-tab" + (tab === "members" ? " active" : "")} onClick={() => setTab("members")}>Members</button>
        ) : null}
      </div>
      {/* key=role.id REMOUNTS the tab on selection change: the tabs hold local
          edit state (name/color/checkboxes) initialized from the role — without
          the remount a switch kept the PREVIOUS role's values and lit the Save
          button as if the user had made them (live report). The outer tab state
          survives, matching oak's TabPane. The wrapper owns the tab's scroll:
          the head and the tab row stay pinned above it. */}
      <div className="role-tab-body">
        {tab === "appearance" ? (
          <RoleAppearance key={role.id} session={session} role={role} name={name} setName={setName} />
        ) : tab === "permissions" ? (
          <RolePermissions key={role.id} session={session} role={role} />
        ) : (
          <RoleMembers key={role.id} session={session} role={role} />
        )}
      </div>
    </div>
  );
}

function RoleAppearance({ session, role, name, setName }: {
  session: ConnectionSession;
  role: Role;
  name: string;
  setName(next: string): void;
}): React.JSX.Element {
  const builtin = role.kind !== "CUSTOM";
  const [color, setColor] = useState<number | null>(role.color);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [hoist, setHoist] = useState(role.hoist);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saved, setSaved] = useState(false);
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
        // oak's partial-PATCH contract: the name travels ONLY when the user
        // actually changed it. The server validates names on update, and legacy
        // roles (created before that rule) can carry spaces — sending their
        // stored name on every save bounced color-only edits with 400 (live
        // report). null leaves the stored name untouched.
        name: name.trim() !== role.name ? name.trim() : null,
        // color is UNCONDITIONAL on the wire: null resets, so send the picked value.
        color,
        mentionable,
        hoist,
      });
      setSaved(true);
    } catch (error: unknown) {
      // Same contract as reorder: the inline status is momentary — a rejected color
      // must also land in space.log (with what was actually sent) or the failure is
      // undebuggable once the selection changes (live report).
      const message = error instanceof Error ? error.message : String(error);
      log.error("settings", `role update failed (id=${role.id}, color=${color}, name="${name.trim()}"): ${message}`);
      setStatus(message);
      setName(role.name); // a rejected name must not look saved
    } finally {
      setBusy(false);
    }
  };

  // oak's swatch grid rows (presetColors): bright on top, muted below.
  const swatchRow = (presets: readonly number[], rowKey: string): React.JSX.Element => (
    <div className="role-palette-row" key={rowKey}>
      {presets.map((preset) => (
        <button
          key={`${rowKey}-${preset}`}
          className={"swatch" + (color === preset ? " chosen" : "")}
          style={{ background: argbIntToCss(preset) }}
          disabled={builtin}
          onClick={() => setColor(preset)}
        />
      ))}
    </div>
  );

  return (
    <div className="role-appearance">
      {/* The name itself is edited by the pencil in the editor header — no
          Title field here (user decision; oak keeps a Title input). */}
      <div className="settings-field">
        {/* oak: a live 22×22 preview beside the "Color" label — the Default
            (no-color) state reads at a glance (grey #99aab5 there). */}
        <div className="role-field-label">
          <span>Color</span>
          <span className="role-color-preview" style={{ background: color !== null ? argbIntToCss(color) : "var(--sp-role-chip-default)" }} />
        </div>
        {/* oak's picker row: a two-button column (Default / Custom) beside the
            12×2 swatch grid, all controls one 28px height rhythm. Custom opens a
            color PICKER (oak: modal SV/hue dialog; web: the native one). */}
        <div className="role-picker-row">
          <div className="role-picker-buttons">
            <button className="ghost wide-add" disabled={builtin} onClick={() => setColor(null)}>Default</button>
            <button className="ghost" disabled={builtin} onClick={() => setPickerOpen(true)}>Custom</button>
          </div>
          <div className="role-palette">
            {swatchRow(ROLE_PALETTE_TOP, "top")}
            {swatchRow(ROLE_PALETTE_BOTTOM, "bottom")}
          </div>
        </div>
        {pickerOpen ? (
          <ColorPickerDialog
            initialHex={color !== null ? argbToHex(color) : "#99aab5"}
            onApply={(hex) => {
              const parsed = hexToArgb(hex);
              if (parsed !== null) {
                setColor(parsed);
              }
            }}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
      <div className="role-flags-row">
        <label className="settings-check">
          {/* oak: mentionable stays editable even for @everyone (only name/color/
              hoist are builtin-locked) — configureEditorForSelection. */}
          <input type="checkbox" checked={mentionable} disabled={role.kind === "OWNER"} onChange={(event) => setMentionable(event.target.checked)} />
          <span>Mentionable</span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={hoist} disabled={builtin} onChange={(event) => setHoist(event.target.checked)} />
          <span>Display separately (hoist)</span>
        </label>
      </div>
      <div className="modal-actions left">
        <SaveButton label="Save Changes" saved={saved} dirty={dirty} busy={busy} onClick={() => void submit()} />
        {status !== null ? <span className="settings-status">{status}</span> : null}
      </div>
    </div>
  );
}

function RolePermissions({ session, role }: { session: ConnectionSession; role: Role }): React.JSX.Element {
  const [catalog, setCatalog] = useState<readonly PermissionCatalogEntry[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set(role.permissions));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
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
      setSaved(true);
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
      {/* oak: the tab is captioned "Permissions" — no explainer paragraph (the
          VIEW_CHANNEL story lives in its absence: the checkbox simply isn't there). */}
      <div className="settings-hint">Permissions</div>
      {catalog === null ? (
        <div className="settings-empty">Loading catalog…</div>
      ) : (
        /* Only the permission LIST scrolls (oak's permissions-scroll) — the
           caption and the Save button stay put. */
        <div className="permissions-scroll-box">
          {(["GENERAL", "TEXT", "VOICE"] as const).map((group) => {
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
          })}
        </div>
      )}
      <div className="modal-actions left">
        <SaveButton label="Save Changes" saved={saved} dirty={dirty} busy={busy} onClick={() => void submit()} />
        {status !== null ? <span className="settings-status">{status}</span> : null}
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
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const holders = members.filter((member) => member.roleIds.includes(role.id));
  // oak's AddMemberDialog candidates: everyone WITHOUT the role, name-sorted.
  // The NICKNAME is the display name everywhere (the rename model) — rows keyed
  // by username underneath, never showing it (live report: logins leaked here).
  const candidates = [...members]
    .filter((member) => !member.roleIds.includes(role.id))
    .sort((left, right) => left.nickname.localeCompare(right.nickname));

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

  // oak assigns each picked member separately (assignRole per selection, Apply).
  const applyPicked = async (): Promise<void> => {
    if (busy || picked.size === 0) {
      return;
    }
    setBusy(true);
    for (const userId of picked) {
      const member = members.find((entry) => entry.userId === userId);
      if (member !== undefined) {
        await setHolding(member, true);
      }
    }
    setBusy(false);
    setPickerOpen(false);
    setPicked(new Set());
  };

  return (
    <div>
      {/* oak's members tab: just the scrollable holder list with the full-width
          "Add member" button UNDER it — no explainer paragraph. */}
      {holders.length === 0 ? (
        <div className="settings-empty">No members have this role</div>
      ) : (
        holders.map((member) => (
          <div key={member.userId} className="list-row">
            <Avatar session={session} username={member.username} size={28} />
            <span className="member-name" style={{ color: memberNameColor(member, roles) ?? undefined }}>{member.nickname}</span>
            {/* oak's removal glyph: the small close icon on the row's right
                (role-trash-button + Icons.close), not a textual "×". */}
            <button className="ghost tiny role-remove" title="Remove role" onClick={() => void setHolding(member, false)}>
              <span className="icon mdi-close" />
            </button>
          </div>
        ))
      )}
      <button className="primary wide-add" disabled={candidates.length === 0} onClick={() => {
        setPicked(new Set());
        setPickerOpen(true);
      }}>Add member</button>
      {pickerOpen ? (
        <Modal title={`Add members to ${role.name}`} onClose={() => setPickerOpen(false)}>
          <div className="friend-picker-list">
            {candidates.length === 0 ? (
              <div className="settings-empty">Every member already has this role.</div>
            ) : candidates.map((member) => (
              <label key={member.userId} className="settings-check friend-picker-row">
                <input
                  type="checkbox"
                  checked={picked.has(member.userId)}
                  onChange={(event) => {
                    const next = new Set(picked);
                    if (event.target.checked) {
                      next.add(member.userId);
                    } else {
                      next.delete(member.userId);
                    }
                    setPicked(next);
                  }}
                />
                <Avatar session={session} username={member.username} size={24} />
                <span>{member.nickname}</span>
              </label>
            ))}
          </div>
          <div className="modal-actions left">
            <button className="ghost" onClick={() => setPickerOpen(false)}>Cancel</button>
            <button className="primary" disabled={busy || picked.size === 0} onClick={() => void applyPicked()}>
              Add {picked.size > 0 ? `(${picked.size})` : ""}
            </button>
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [kickTarget, setKickTarget] = useState<ServerMember | null>(null);
  const [banTarget, setBanTarget] = useState<ServerMember | null>(null);
  // The rename form state (the nickname is the ONE display name).
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameStatus, setRenameStatus] = useState<string | null>(null);

  const canKick = permissions.includes(KICK_MEMBERS_PERMISSION);
  const canBan = permissions.includes(BAN_MEMBERS_PERMISSION);

  const selfId = session.selfUserId();
  /** Rename gates (Discord): yourself under CHANGE_NICKNAME; someone else under
   *  MANAGE_NICKNAMES + strictly-higher hierarchy (an OWNER target is immune). */
  const canRenameMember = (member: ServerMember): boolean => {
    if (member.userId === selfId) {
      return permissions.includes(CHANGE_NICKNAME_PERMISSION);
    }
    if (!permissions.includes(MANAGE_NICKNAMES_PERMISSION)) {
      return false;
    }
    const self = members.find((entry) => entry.userId === selfId);
    if (self === undefined) {
      return false;
    }
    const hierarchyOf = (entry: ServerMember) => ({ owner: entry.owner, topPosition: topPosition(entry, roles) });
    return canActOn(hierarchyOf(self), hierarchyOf(member));
  };

  /** Role-removal gates (the server's assignRoles mirrored client-side):
   *  MANAGE_MEMBERS + hierarchy over the target + the actor's top role strictly
   *  above the role being removed (canAssignRole's formula; the OWNER row never
   *  renders a button — that role is not in roleIds, it has its own row). */
  const canRemoveRole = (member: ServerMember, role: Role): boolean => {
    if (!permissions.includes(MANAGE_MEMBERS_PERMISSION)) {
      return false;
    }
    const self = members.find((entry) => entry.userId === selfId);
    if (self === undefined) {
      return false;
    }
    const hierarchyOf = (entry: ServerMember) => ({ owner: entry.owner, topPosition: topPosition(entry, roles) });
    return canActOn(hierarchyOf(self), hierarchyOf(member)) && hierarchyOf(self).topPosition > role.position;
  };

  /** Full-replacement PUT minus the one role (RoleMembers' setHolding pattern);
   *  the /topic/members push repaints the pane, failures surface via alert. */
  const removeRole = async (member: ServerMember, role: Role): Promise<void> => {
    try {
      await session.rest.updateMemberRoles(member.userId, member.roleIds.filter((id) => id !== role.id));
    } catch (error: unknown) {
      window.alert(`Could not remove role: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyRename = async (member: ServerMember): Promise<void> => {
    const nickname = renameDraft?.trim() ?? "";
    if (nickname.length === 0 || renameBusy) {
      return;
    }
    setRenameBusy(true);
    setRenameStatus("Saving…");
    try {
      await session.renameMember(member.userId, nickname);
      setRenameDraft(null);
      setRenameStatus(null);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setRenameStatus("Nickname is already taken.");
      } else {
        setRenameStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setRenameBusy(false);
    }
  };

  const resetRename = async (member: ServerMember): Promise<void> => {
    if (renameBusy) {
      return;
    }
    setRenameBusy(true);
    setRenameStatus("Resetting…");
    try {
      await session.resetMemberNickname(member.userId);
      setRenameDraft(null);
      setRenameStatus(null);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setRenameStatus("Nickname is already taken.");
      } else {
        setRenameStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setRenameBusy(false);
    }
  };
  const active = selectedId !== null ? members.find((member) => member.userId === selectedId) ?? null : null;

  return (
    <div className="roles-layout">
      <div className="roles-list">
        <div className="roles-list-header"><span>Members — {members.length}</span></div>
        {/* oak's members pane is ONE list out of GET /api/members — the server
            ships banned members there with a flag; a banned row differs only by
            its BANNED badge and its action set (Unban instead of Kick/Ban). */}
        {members.map((member) => (
          <div key={member.userId} className={"roles-row" + (member.userId === active?.userId ? " active" : "")}
            onClick={() => setSelectedId(member.userId)}>
            <Avatar session={session} username={member.username} size={20} />
            <span className="member-name" style={{ color: memberNameColor(member, roles) ?? undefined }}>{member.nickname}</span>
            {member.owner ? <span className="owner-badge">OWNER</span> : null}
            {member.banned ? <span className="banned-badge">BANNED</span> : null}
          </div>
        ))}
      </div>
      <div className="role-editor">
        {active === null ? (
          <div className="settings-empty">Select a member</div>
        ) : (
          <div>
            <span className="role-editor-name">{active.nickname}</span>
            <div className="settings-hint">Member actions</div>
            <div className="modal-actions left">
              {active.banned ? (
                canBan ? (
                  /* oak: Unban carries no confirmation — it restores access. */
                  <button className="primary" onClick={() => {
                    void session.unbanMember(active.userId).catch((error: unknown) => {
                      window.alert(`Could not unban: ${error instanceof Error ? error.message : String(error)}`);
                    });
                  }}>Unban</button>
                ) : null
              ) : (
                <>
                  {canKick ? (
                    /* oak shows Kick/Ban DISABLED for the owner (not hidden) — the
                       owner is immune, the buttons just never fire. */
                    <button className="danger" disabled={active.owner} onClick={() => setKickTarget(active)}>Kick</button>
                  ) : null}
                  {canBan ? (
                    <button className="danger" disabled={active.owner} onClick={() => setBanTarget(active)}>Ban</button>
                  ) : null}
                </>
              )}
              {canRenameMember(active) ? (
                renameDraft === null ? (
                  <button className="ghost" onClick={() => {
                    setRenameDraft(active.nickname);
                    setRenameStatus(null);
                  }}>Rename</button>
                ) : (
                  <button className="ghost" onClick={() => {
                    setRenameDraft(null);
                    setRenameStatus(null);
                  }}>Cancel rename</button>
                )
              ) : null}
            </div>
            {renameDraft !== null ? (
              <div className="member-rename-form">
                <label className="settings-field"><span>Nickname</span>
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void applyRename(active);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setRenameDraft(null);
                        setRenameStatus(null);
                      }
                    }}
                  />
                </label>
                <div className="modal-actions left">
                  <button className="primary" disabled={renameBusy || renameDraft.trim().length === 0} onClick={() => void applyRename(active)}>
                    Save nickname
                  </button>
                  <button className="ghost" disabled={renameBusy} onClick={() => void resetRename(active)}>Reset to login</button>
                </div>
                <span className="settings-status">{renameStatus ?? ""}</span>
              </div>
            ) : null}
            <div className="settings-hint">Roles</div>
            {/* oak lists the OWNER row explicitly — the OWNER role is not among
                the roles, so the owner would otherwise read as "No roles". */}
            {active.owner ? (
              <div className="list-row">
                <span className="role-color-chip" style={{ background: "var(--sp-role-chip-default)" }} />
                <span>Owner</span>
              </div>
            ) : null}
            {!active.owner && active.roleIds.length === 0 ? (
              <div className="settings-empty">No roles</div>
            ) : (
              active.roleIds
                .map((roleId) => roles.find((entry) => entry.id === roleId))
                .filter((entry): entry is Role => entry !== undefined)
                .sort((left, right) => right.position - left.position)
                .map((entry) => (
                  <div key={entry.id} className="list-row">
                    <span className="role-color-chip" style={{ background: entry.color !== null ? argbIntToCss(entry.color) : "var(--sp-role-chip-default)" }} />
                    <span>{entry.name}</span>
                    {canRemoveRole(active, entry) ? (
                      <button
                        className="ghost member-role-remove"
                        title="Remove role"
                        onClick={() => void removeRole(active, entry)}
                      >
                        <span className="icon mdi-close" />
                      </button>
                    ) : null}
                  </div>
                ))
            )}
          </div>
        )}
      </div>
      {kickTarget !== null ? (
        <ConfirmModal
          title="Kick member"
          note={`Kick "${kickTarget.nickname}"? They will be disconnected from the server.`}
          confirmLabel="Kick"
          onConfirm={async () => {
            await session.kickMember(kickTarget.userId);
          }}
          onClose={() => setKickTarget(null)}
        />
      ) : null}
      {banTarget !== null ? (
        <ConfirmModal
          title="Ban member"
          note={`Ban "${banTarget.nickname}"? They will no longer be able to log in.`}
          confirmLabel="Ban"
          onConfirm={async () => {
            await session.banMember(banTarget.userId);
          }}
          onClose={() => setBanTarget(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channels (tri-state overrides + Access)
// ---------------------------------------------------------------------------

function ChannelsSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const channels = useStore(session.channelStore, (channels) => channels);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);
  const list = channels.filter((channel) => channel.type === "TEXT" || channel.type === "VOICE");
  const selected = list.find((channel) => channel.id === selectedId) ?? null;

  return (
    <div className="roles-layout">
      <div className="roles-list">
        <div className="roles-list-header"><span>Channels — {list.length}</span></div>
        {list.map((channel) => (
          <div key={channel.id} className={"roles-row" + (channel.id === selected?.id ? " active" : "")}
            onClick={() => setSelectedId(channel.id)}>
            <ChannelGlyph voice={channel.type === "VOICE"} locked={channel.locked} />
            <span className="role-name">{channel.name}</span>
            {/* oak's ChannelListCell carries the trash right in the row — deleting
                from the settings window does not require hunting the sidebar. */}
            <button className="ghost tiny" title="Delete channel" onClick={(event) => {
              event.stopPropagation();
              setDeleteTarget(channel);
            }}><span className="icon mdi-trash-can" /></button>
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
      {deleteTarget !== null ? (
        <ConfirmModal
          title="Delete channel"
          note={`Delete channel "${deleteTarget.name}"? Its messages will be permanently removed.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await session.deleteChannel(deleteTarget.id);
            // The open editor dies with its channel — clear the selection (oak
            // clears the editor BEFORE the REST call even leaves).
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

function ChannelEditor({ session, channel }: { session: ConnectionSession; channel: Channel }): React.JSX.Element {
  const [tab, setTab] = useState<"permissions" | "access">("permissions");
  // The channel name edits INLINE via the hover pencil, like the role name.
  // There is no Appearance tab here, so Enter commits straight away (the tab
  // Save buttons own the overrides, not the name) — Escape rolls back.
  const [name, setName] = useState(channel.name);
  const [editingName, setEditingName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    setName(channel.name);
    setEditingName(false);
  }, [channel.id]);

  const commitName = async (): Promise<void> => {
    const trimmed = name.trim();
    setEditingName(false);
    if (busy || trimmed.length === 0 || trimmed === channel.name) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await session.renameChannel(channel.id, trimmed);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
      setName(channel.name); // a rejected name must not look saved
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="role-editor-inner">
      <div className="role-editor-head">
        <div className="role-editor-title-row">
          {editingName ? (
            <input
              className="role-editor-name-input"
              autoFocus
              value={name}
              style={{ width: `${Math.max(name.length, channel.name.length, 4) + 1}ch` }}
              onFocus={(event) => {
                event.target.setSelectionRange(event.target.value.length, event.target.value.length);
              }}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitName();
                } else if (event.key === "Escape") {
                  setName(channel.name); // cancel — back to the stored name
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <span className="role-editor-name"><span className={"icon " + (channel.type === "VOICE" ? "mdi-volume-high" : "mdi-pound")} /> {channel.name}</span>
          )}
          {!editingName ? (
            <button className="ghost tiny role-editor-pencil" title="Rename channel" onClick={() => {
              setName(channel.name);
              setEditingName(true);
            }}>
              <span className="icon mdi-pencil" />
            </button>
          ) : null}
          {status !== null ? <span className="settings-status">{status}</span> : null}
        </div>
      </div>
      <div className="settings-tabs">
        <button className={"settings-tab" + (tab === "permissions" ? " active" : "")} onClick={() => setTab("permissions")}>Permissions</button>
        <button className={"settings-tab" + (tab === "access" ? " active" : "")} onClick={() => setTab("access")}>Access</button>
      </div>
      {/* key=channel.id — same remount contract as the role editor: local edit
          state must never survive a channel switch. The wrapper owns the tab's
          scroll (the head and the tab row stay pinned above it). */}
      <div className="role-tab-body">
        {tab === "permissions" ? (
          <ChannelPermissionsTab key={channel.id} session={session} channel={channel} />
        ) : (
          <ChannelAccessTab key={channel.id} session={session} channel={channel} />
        )}
      </div>
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
  /** The loaded snapshot — the dirty check compares the working map against it
   *  (oak's overridesDirty: Save lights up ONLY on unsaved edits). */
  const originalRef = useRef<Map<number, PermissionSets> | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = (): void => {
    void session.rest.getChannelOverrides(channel.id).then((rows: ChannelOverride[]) => {
      const loaded = overrideMaps(rows, []).roleOverrides;
      originalRef.current = loaded;
      setOverrides(loaded);
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

  const dirty = overrides !== null && originalRef.current !== null && !permissionMapsEqual(overrides, originalRef.current);

  const submit = async (): Promise<void> => {
    if (selectedRole === null || sets === null || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await session.rest.upsertChannelOverride(channel.id, selectedRole.id, sets);
      originalRef.current = new Map(overrides ?? []);
      setSaved(true);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="settings-hint">
        Click cycles Inherit → Allow (✓, blurple) → Deny (✗, red) — Inherit uses the role's base.
        Deny @everyone SEND_MESSAGES = a read-only channel. VIEW_CHANNEL lives in the Access tab.
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
          {/* Only the permission LIST scrolls (oak's permissions-scroll): the
              hint, the role picker and the buttons stay put. Grouped and laid
              out EXACTLY like the role-permissions list (same sections, same
              row geometry, same fonts) — only the box is the tri-state cycler. */}
          <div className="permissions-scroll-box">
            {(["GENERAL", "TEXT", "VOICE"] as const).map((group) => {
              const entries = channelEditablePermissions(catalog).filter((entry) => entry.group === group);
              if (entries.length === 0) {
                return null;
              }
              return (
                <div key={group}>
                  <div className="friends-section">{group === "GENERAL" ? "General" : group === "TEXT" ? "Text" : "Voice"}</div>
                  {entries.map((entry) => (
                    <TriStateControl
                      key={entry.name}
                      label={PERMISSION_INFO[entry.name]?.label ?? entry.name}
                      description={PERMISSION_INFO[entry.name]?.description ?? ""}
                      notImplemented={NOT_IMPLEMENTED.has(entry.name)}
                      state={triStateOf(entry.name, sets)}
                      onChange={(next) => setState(entry.name, next)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
          <div className="modal-actions left">
            <SaveButton label="Save Changes" saved={saved} dirty={dirty} busy={busy} onClick={() => void submit()} />
            {status !== null ? <span className="settings-status">{status}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * oak's tri-state CheckBox (allowIndeterminate): ONE box the click CYCLES —
 * Inherit (empty) → Allow (blurple check) → Deny (red cross) → Inherit. The row
 * carries the permission's description and the "(not implemented yet)" note,
 * exactly like the role-permissions list. The check/cross are CSS-drawn and
 * perfectly centered (a font glyph sat visually above the box's center).
 */
function TriStateControl({ label, description, notImplemented, state, onChange }: {
  label: string;
  description: string;
  notImplemented: boolean;
  state: TriState;
  onChange(next: TriState): void;
}): React.JSX.Element {
  const next = state === "inherit" ? "allow" : state === "allow" ? "deny" : "inherit";
  return (
    <div className="tri-control">
      {/* The EXACT permission-row composition (Roles → Permissions): the box
          FIRST on the left, then the label column — name, the not-implemented
          note and the description as the column's children. */}
      <button
        type="button"
        className={"tri-check " + state}
        title={state === "allow" ? "Allow — click to deny" : state === "deny" ? "Deny — click to inherit" : "Inherit — click to allow"}
        onClick={() => onChange(next)}
      />
      <span className="tri-label">
        {label}
        {notImplemented ? <em className="not-implemented"> (not implemented yet)</em> : null}
        <small>{description}</small>
      </span>
    </div>
  );
}

function permissionMapsEqual(left: ReadonlyMap<number, PermissionSets>, right: ReadonlyMap<number, PermissionSets>): boolean {
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of keys) {
    const leftSets = left.get(key);
    const rightSets = right.get(key);
    if (leftSets === undefined && rightSets === undefined) {
      continue;
    }
    if (leftSets === undefined || rightSets === undefined) {
      return false;
    }
    if (new Set(leftSets.allow).size !== new Set([...leftSets.allow, ...rightSets.allow]).size
      || new Set(rightSets.deny).size !== new Set([...leftSets.deny, ...rightSets.deny]).size) {
      return false;
    }
  }
  return true;
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
  /** The loaded snapshot — the dirty check compares mode + grant sets against
   *  it (oak's accessDirty: Save lights up ONLY on unsaved edits). */
  const originalRef = useRef<{ mode: AccessMode; grantedRoleIds: Set<number>; grantedUserIds: Set<number> } | null>(null);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
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
      const grantedRoleIds = new Set(grantees.roleIds);
      const grantedUserIds = new Set(grantees.userIds);
      originalRef.current = { mode, grantedRoleIds, grantedUserIds };
      setState({
        mode,
        ...maps,
        grantedRoleIds,
        grantedUserIds,
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
      originalRef.current = { mode: state.mode, grantedRoleIds: new Set(state.grantedRoleIds), grantedUserIds: new Set(state.grantedUserIds) };
      setSaved(true);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dirty = originalRef.current !== null
    && (state.mode !== originalRef.current.mode
      || !setsOfIdsEqual(state.grantedRoleIds, originalRef.current.grantedRoleIds)
      || !setsOfIdsEqual(state.grantedUserIds, originalRef.current.grantedUserIds));

  // oak's picker candidates: roles/members NOT in the working set, by name.
  const grantableRoles = roles
    .filter((role) => role.kind === "CUSTOM" && !state.grantedRoleIds.has(role.id))
    .sort((left, right) => left.name.localeCompare(right.name));
  const candidateMembers = [...members]
    .filter((member) => !state.grantedUserIds.has(member.userId))
    .sort((left, right) => left.nickname.localeCompare(right.nickname));
  const grantedRoleList = roles.filter((role) => state.grantedRoleIds.has(role.id));
  /** The DISPLAY name of a granted user: the nickname (the rename model — the
   *  usernames map holds the LOGIN, which is the Avatar's roster key only). */
  const grantedUserLabel = (userId: number): string =>
    members.find((member) => member.userId === userId)?.nickname
    ?? state.usernames.get(userId)
    ?? `user ${userId}`;

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
          {/* oak's Access lists: granted rows with "×" + an "Add role…" picker —
              the pickers edit the LOCAL working set; one Save writes everything. */}
          <div className="friends-section">Roles with access</div>
          {grantedRoleList.length === 0 ? (
            <div className="settings-empty">No roles granted</div>
          ) : (
            grantedRoleList.map((role) => (
              <div key={role.id} className="list-row">
                <span className="role-color-chip" style={{ background: role.color !== null ? argbIntToCss(role.color) : "var(--sp-role-chip-default)" }} />
                <span>{role.name}</span>
                <button className="ghost tiny role-remove" title="Revoke" onClick={() => {
                  const next = new Set(state.grantedRoleIds);
                  next.delete(role.id);
                  setState({ ...state, grantedRoleIds: next });
                }}><span className="icon mdi-close" /></button>
              </div>
            ))
          )}
          <button className="ghost wide-add" disabled={grantableRoles.length === 0} onClick={() => setRolePickerOpen(true)}>Add role…</button>
          <div className="friends-section">Members with access</div>
          {state.grantedUserIds.size === 0 ? (
            <div className="settings-empty">No members granted</div>
          ) : (
            [...state.grantedUserIds].map((userId) => (
              <div key={userId} className="list-row">
                <Avatar session={session} username={state.usernames.get(userId) ?? `#${userId}`} size={24} />
                <span>{grantedUserLabel(userId)}</span>
                <button className="ghost tiny role-remove" title="Revoke" onClick={() => {
                  const next = new Set(state.grantedUserIds);
                  next.delete(userId);
                  setState({ ...state, grantedUserIds: next });
                }}><span className="icon mdi-close" /></button>
              </div>
            ))
          )}
          <button className="ghost wide-add" disabled={candidateMembers.length === 0} onClick={() => setMemberPickerOpen(true)}>Add member…</button>
        </>
      )}
      <div className="modal-actions left">
        <SaveButton label="Save Changes" saved={saved} dirty={dirty} busy={busy} onClick={() => void submit()} />
        {status !== null ? <span className="settings-status">{status}</span> : null}
      </div>
      {rolePickerOpen ? (
        <AccessPickerModal
          session={session}
          title="Add roles with access"
          emptyNote="Every role already has access."
          rows={grantableRoles.map((role) => ({
            id: role.id,
            label: role.name,
            chip: role.color !== null ? argbIntToCss(role.color) : "var(--sp-role-chip-default)",
          }))}
          onApply={(picked) => {
            setState({ ...state, grantedRoleIds: new Set([...state.grantedRoleIds, ...picked]) });
            setRolePickerOpen(false);
          }}
          onClose={() => setRolePickerOpen(false)}
        />
      ) : null}
      {memberPickerOpen ? (
        <AccessPickerModal
          session={session}
          title="Add members with access"
          emptyNote="Every member already has access."
          rows={candidateMembers.map((member) => ({
            id: member.userId,
            label: member.nickname,
            avatar: member.username,
          }))}
          onApply={(picked) => {
            const nextUsers = new Set(state.grantedUserIds);
            const nextNames = new Map(state.usernames);
            for (const userId of picked) {
              nextUsers.add(userId);
              const member = members.find((entry) => entry.userId === userId);
              if (member !== undefined) {
                nextNames.set(userId, member.username);
              }
            }
            setState({ ...state, grantedUserIds: nextUsers, usernames: nextNames });
            setMemberPickerOpen(false);
          }}
          onClose={() => setMemberPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** oak's AddRoleDialog/AddMemberDialog: checkbox multi-select + Apply — the
 *  picked rows land in the LOCAL working set; nothing hits the wire until Save. */
function AccessPickerModal({ session, title, emptyNote, rows, onApply, onClose }: {
  session: ConnectionSession;
  title: string;
  emptyNote: string;
  rows: readonly { id: number; label: string; chip?: string; avatar?: string }[];
  onApply(picked: readonly number[]): void;
  onClose(): void;
}): React.JSX.Element {
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  return (
    <Modal title={title} onClose={onClose}>
      <div className="friend-picker-list">
        {rows.length === 0 ? (
          <div className="settings-empty">{emptyNote}</div>
        ) : rows.map((row) => (
          <label key={row.id} className="settings-check friend-picker-row">
            <input
              type="checkbox"
              checked={picked.has(row.id)}
              onChange={(event) => {
                const next = new Set(picked);
                if (event.target.checked) {
                  next.add(row.id);
                } else {
                  next.delete(row.id);
                }
                setPicked(next);
              }}
            />
            {row.chip !== undefined ? <span className="role-color-chip" style={{ background: row.chip }} /> : null}
            {row.avatar !== undefined ? <Avatar session={session} username={row.avatar} size={24} /> : null}
            <span>{row.label}</span>
          </label>
        ))}
      </div>
      <div className="modal-actions left">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={picked.size === 0} onClick={() => onApply([...picked])}>Add</button>
      </div>
    </Modal>
  );
}

function setsOfIdsEqual(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false;
    }
  }
  return true;
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
      <div className="modal-actions left">
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

/** The save button with the WIDTH-STABLE "Saved" marker: the real label stays
 *  mounted as an invisible underlay and the marker overlays it centered — a
 *  shorter label used to shrink the button (live report). The marker shows
 *  while there are NO unsaved edits; any new edit flips back to the label. */
function SaveButton({ label, saved, dirty, busy, onClick }: {
  label: string;
  saved: boolean;
  dirty: boolean;
  busy: boolean;
  onClick(): void;
}): React.JSX.Element {
  const working = dirty || busy;
  const showSaved = saved && !working;
  return (
    <button className="primary save-button" disabled={!working} onClick={onClick}>
      <span className={showSaved ? "save-button-underlay" : undefined}>{label}</span>
      {showSaved ? <span className="save-button-overlay">Saved</span> : null}
    </button>
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

// ---------------------------------------------------------------------------
// Server — storage housekeeping (MANAGE_STORAGE): the GC policy, a live disk
// reading, and a run-now trigger. The cleanup itself is watermark-driven and
// age-agnostic: history lives as long as the disk allows.
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) {
    return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatMinuteOfDay(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The nightly-run time input writes "HH:mm"; invalid input keeps the field but blocks Save. */
function parseTimeToMinuteOfDay(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

function ServerStorageSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [high, setHigh] = useState("");
  const [low, setLow] = useState("");
  const [runTime, setRunTime] = useState("");
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [saved, setSaved] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);

  const applyStatus = (next: StorageStatus): void => {
    setStatus(next);
    setHigh(String(next.policy.highWatermarkPercent));
    setLow(String(next.policy.lowWatermarkPercent));
    setRunTime(formatMinuteOfDay(next.policy.gcMinuteOfDay));
    setAutoEnabled(next.policy.gcEnabled);
  };

  const refresh = (): void => {
    void session.rest.getStorageStatus()
      .then(applyStatus)
      .catch((refreshError: unknown) =>
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError)));
  };

  useEffect(refresh, [session]);

  // While a manual run is in flight, poll for the report (the server runs it in
  // the background and answers 202).
  const runInFlight = status !== null && status.running;
  useEffect(() => {
    if (!runInFlight) {
      return;
    }
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is a stable shape over setStatus/session only
  }, [runInFlight, session]);

  const highNumber = Number(high);
  const lowNumber = Number(low);
  const minuteOfDay = parseTimeToMinuteOfDay(runTime);
  const valid = Number.isInteger(highNumber) && highNumber > 0 && highNumber <= 99
    && Number.isInteger(lowNumber) && lowNumber >= 0 && lowNumber <= 98
    && highNumber > lowNumber && minuteOfDay !== null;
  // SaveButton's dirty: any control drifted from the stored policy (an INVALID
  // draft keeps the button disabled — dirty only counts when the draft is valid).
  const dirty = status !== null && valid && (
    highNumber !== status.policy.highWatermarkPercent
    || lowNumber !== status.policy.lowWatermarkPercent
    || minuteOfDay !== status.policy.gcMinuteOfDay
    || autoEnabled !== status.policy.gcEnabled
  );

  const save = async (): Promise<void> => {
    if (busy || !valid || minuteOfDay === null) {
      return;
    }
    setBusy(true);
    try {
      applyStatus(await session.rest.updateStorageSettings({
        highWatermarkPercent: highNumber,
        lowWatermarkPercent: lowNumber,
        gcMinuteOfDay: minuteOfDay,
        gcEnabled: autoEnabled,
      }));
      setSaved(true);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.rest.triggerStorageGc();
      refresh();
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) {
    return <div className="settings-hint">{error ?? "Loading storage state…"}</div>;
  }

  const usedPercent = Math.round(status.usage.usedPercent);
  const lastRun = status.lastRun;

  return (
    <div>
      <div className="roles-list-header overview-heading"><span>Storage</span></div>

      <h3>Disk usage</h3>
      {/* The instance's data disk (Postgres + MinIO live on it): the watermark
          policy is measured against exactly this bar. */}
      <div className="settings-hint">
        {formatBytes(status.usage.usedBytes)} of {formatBytes(status.usage.totalBytes)} used — {usedPercent}%
      </div>
      <div style={{
        height: 10,
        borderRadius: 5,
        background: "#1e1f22",
        border: "1px solid #383a40",
        overflow: "hidden",
        margin: "8px 0 16px",
      }}>
        <div style={{
          height: "100%",
          width: `${Math.min(100, usedPercent)}%`,
          background: usedPercent >= status.policy.highWatermarkPercent ? "#da373c" : "#3ba55d",
        }} />
      </div>

      <h3>Cleanup policy</h3>
      <div className="settings-hint">
        Cleanup is need-driven, not age-driven: when the disk crosses the high threshold at night,
        the oldest messages and unreferenced attachments are removed until it drops below the low
        one. Attachments whose last message is deleted go immediately; the newest history is always
        kept.
      </div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={autoEnabled}
          onChange={(event) => setAutoEnabled(event.target.checked)}
        />
        <span>Automatic cleanup</span>
      </label>
      <label className="settings-field">
        <span>Start cleanup above — {high || "?"}% full</span>
        <input type="range" min={1} max={99} value={high} onChange={(event) => setHigh(event.target.value)} />
      </label>
      <label className="settings-field">
        <span>Clean down to — {low || "?"}% full</span>
        <input type="range" min={0} max={98} value={low} onChange={(event) => setLow(event.target.value)} />
      </label>
      <label className="settings-field">
        <span>Nightly run at (local time)</span>
        <input
          type="text"
          value={runTime}
          placeholder="03:30"
          disabled={!autoEnabled}
          onChange={(event) => setRunTime(event.target.value)}
        />
      </label>
      <div className="modal-actions left">
        <SaveButton label="Save changes" saved={saved} dirty={dirty} busy={busy} onClick={() => void save()} />
        <button className="ghost" disabled={busy || status.running} onClick={() => setConfirmRun(true)}>
          {status.running ? "Cleaning…" : "Run cleanup now"}
        </button>
        <span className="settings-status">
          {valid ? "" : "The high threshold must be above the low one; time as HH:mm."}
        </span>
      </div>

      {confirmRun ? (
        <Modal
          title="Run cleanup now?"
          onClose={() => setConfirmRun(false)}
        >
          <div className="modal-note">
            The cleanup may take a while, and while it runs the server can hang for a few
            seconds — the chat freezes until it finishes. Are you sure you want to run it now?
          </div>
          <div className="modal-actions">
            <button className="ghost" onClick={() => setConfirmRun(false)}>Cancel</button>
            <button className="danger" onClick={() => {
              setConfirmRun(false);
              void runNow();
            }}>Run cleanup</button>
          </div>
        </Modal>
      ) : null}
      {lastRun !== null ? (
        <div className="settings-hint">
          Last run {lastRun.trigger} — {lastRun.outcome}. Swept {lastRun.sweptOrphanObjects} orphan
          object(s) ({formatBytes(lastRun.sweptBytes)}), removed {lastRun.purgedMessages} message(s)
          and {lastRun.purgedAttachmentObjects} attachment object(s)
          {lastRun.finalUsedPercent >= 0 ? `; disk now ${Math.round(lastRun.finalUsedPercent)}%` : ""}.
        </div>
      ) : null}
      {error !== null ? <div className="settings-warning">{error}</div> : null}
    </div>
  );
}
