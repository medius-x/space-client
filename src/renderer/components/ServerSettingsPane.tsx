import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../hooks/useStore";
import { log } from "../../logging";
import {
  appStore,
  closeServerSettings,
  openOwnershipTransfer,
  setServerSettingsSection,
} from "../runtime";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { connectionDirectory } from "../runtime";
import { formatExportReport, formatImportReport, planPackImport, type ImportDecision } from "../../domain/logic/expression-pack";
import {
  catalogSnapshotOf,
  exportExpressionPack,
  importPackArchive,
  readPackArchive,
  type ExportScope,
  type ParsedPackArchive,
} from "../expression-exchange";
import type {
  Channel,
  ChannelOverride,
  ChannelType,
  ChannelUserOverride,
  CustomEmoji,
  InviteLink,
  PermissionCatalogEntry,
  Role,
  ServerHealth,
  ServerHealthEntry,
  ServerMember,
  Sticker,
  StickerPack,
  StorageStatus,
} from "../../types";
import {
  BAN_MEMBERS_PERMISSION,
  CHANGE_NICKNAME_PERMISSION,
  KICK_MEMBERS_PERMISSION,
  MANAGE_CHANNELS_PERMISSION,
  MANAGE_EMOJIS_PERMISSION,
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
  permissionMapsEqual,
  triStateOf,
  type AccessMode,
  type PermissionSets,
  type TriState,
} from "../../domain/logic/channel-access";
import { argbIntToCss, canActOn, memberNameColor, topPosition } from "../../domain/logic/roster-grouping";
import {
  membershipCandidates,
  membershipRows,
  nextRoleIdsFor,
  reconcileMembershipPending,
  type MembershipIntent,
} from "../../domain/logic/role-membership";
import { downloadClientLogs } from "../logs-export";
import { ApiError } from "../../core/rest";
import { useAttachmentImage } from "../hooks/useAttachmentImage";
import { measureImageSize } from "../../media/image-size";
import { sanitizeSlotFileName } from "../../domain/logic/ascii-name";
import { emojiNameFromFileName } from "../../domain/logic/emoji-picker";
import { formatExpiresIn, formatTtlWords } from "../../domain/logic/invite-link";
import { moveRoleIdTowards } from "../../domain/logic/role-drag";
import { isOutgoingPending } from "../../domain/logic/ownership-transfer";
import { Modal } from "./Modal";
import { AFK_TIMEOUT_PRESETS, CreateChannelModal } from "./CreateChannelModal";
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

/** Human names + one-line descriptions for the permission catalog (no tooltips — always visible).
 *  Mirrors the server's enforcement map — the retired bits (EMBED_LINKS, USE_EXTERNAL_EMOJIS)
 *  are gone from /api/permissions entirely, so they carry no rows here either. */
const PERMISSION_INFO: Record<string, { label: string; description: string }> = {
  ADMINISTRATOR: { label: "Administrator", description: "Every permission, bypassing channel overrides." },
  MANAGE_SERVER: { label: "Manage Server", description: "Rename the server, edit its icon and connection info." },
  MANAGE_ROLES: { label: "Manage Roles", description: "Create, edit, delete and reorder roles." },
  MANAGE_CHANNELS: { label: "Manage Channels", description: "Create, rename, delete channels and edit overrides." },
  MANAGE_MEMBERS: { label: "Manage Members", description: "Assign roles to members and manage invites." },
  KICK_MEMBERS: { label: "Kick Members", description: "Remove members from the server. Removal is permanent." },
  BAN_MEMBERS: { label: "Ban Members", description: "Ban members from logging in, and unban." },
  MANAGE_NICKNAMES: { label: "Manage Nicknames", description: "Change other members' names." },
  CHANGE_NICKNAME: { label: "Change Nickname", description: "Change your own username." },
  VIEW_AUDIT_LOG: { label: "View Audit Log", description: "See the server's moderation history." },
  MANAGE_EMOJIS: { label: "Manage Emojis & Stickers", description: "Upload and remove custom emoji and stickers." },
  SEND_MESSAGES: { label: "Send Messages", description: "Type in text channels." },
  MANAGE_MESSAGES: { label: "Manage Messages", description: "Delete and edit other members' messages." },
  ATTACH_FILES: { label: "Attach Files", description: "Upload images and files." },
  READ_MESSAGE_HISTORY: { label: "Read Message History", description: "Read past messages." },
  MENTION_EVERYONE: { label: "Mention Everyone", description: "@everyone and @here ping everyone." },
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
  MANAGE_STORAGE: { label: "Manage Storage", description: "Edit the storage cleanup policy and trigger manual runs." },
  RESTRICT_PRIVATE_MESSAGES: {
    label: "Restrict Private Messages",
    description: "Holders cannot send or receive direct messages. Existing conversations stay readable.",
  },
};

/** Permissions with no server enforcement behind them yet (marked in the editor, oak parity).
 *  Kept in lockstep with the server's never-enforced list — every other bit HAS call sites.
 *  SPEAK and STREAM left the set with security round 6 (join-time perm-mute + sweeps /
 *  the client share gate fed by the per-channel bit). */
const NOT_IMPLEMENTED: ReadonlySet<string> = new Set([
  "VIEW_AUDIT_LOG", "USE_VAD", "PRIORITY_SPEAKER", "REQUEST_TO_SPEAK",
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
    { key: "invites" as const, label: "Invites", enabled: can(MANAGE_MEMBERS_PERMISSION) },
    { key: "channels" as const, label: "Channels", enabled: can(MANAGE_CHANNELS_PERMISSION) },
    { key: "emojis" as const, label: "Emoji", enabled: can(MANAGE_EMOJIS_PERMISSION) },
    { key: "stickers" as const, label: "Stickers", enabled: can(MANAGE_EMOJIS_PERMISSION) },
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
        ) : active.key === "invites" ? (
          <InvitesSection session={session} />
        ) : active.key === "emojis" ? (
          <ServerEmojiSection session={session} />
        ) : active.key === "stickers" ? (
          <ServerStickerSection session={session} />
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
          // The draft is per-ROLE: switching the selection must re-seed it. Without
          // the key the editor instance survives the switch and an unsaved draft
          // (name/toggles/membership) carries into the NEXT role's PATCH — the
          // "settings travel between roles" live report (2026-10-19): the same
          // renamed value left the client as PATCHes of other role ids with 409s.
          <RoleEditor key={selected.id} session={session} role={selected} canManageMembers={canManageMembers} />
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

/** The role editor's cross-tab staged draft: every tab writes HERE and the single
 *  "Save Changes" at the editor's foot commits the whole thing in ONE PATCH. The
 *  per-tab saves are gone for a reason: a permissions-only PATCH carries no color
 *  key, and the server's color contract is "null = reset" — saving permissions
 *  alone silently wiped the color picked in Appearance (live report). */
interface RoleDraft {
  name: string;
  color: number | null;
  mentionable: boolean;
  hoist: boolean;
  permissions: ReadonlySet<string>;
}

function draftOf(role: Role): RoleDraft {
  return {
    name: role.name,
    color: role.color,
    mentionable: role.mentionable,
    hoist: role.hoist,
    permissions: new Set(role.permissions),
  };
}

function RoleEditor({ session, role, canManageMembers }: {
  session: ConnectionSession;
  role: Role;
  canManageMembers: boolean;
}): React.JSX.Element {
  const [tab, setTab] = useState<"appearance" | "permissions" | "members">("appearance");
  const builtin = role.kind !== "CUSTOM";
  const roleSnapshot = useStore(session.memberStore, (state) => state.roles.find((entry) => entry.id === role.id) ?? role);
  const members = useStore(session.memberStore, (state) => state.members);
  const [draft, setDraft] = useState<RoleDraft>(() => draftOf(roleSnapshot));
  // Staged membership (user decision 2026-10-19): adds/removes park here and
  // ride the SAME "Save Changes" as the role draft — the Members tab no longer
  // fires immediate PUTs (their /topic/members echo refetched the store, fresh
  // Role objects re-seeded this draft, and unsaved edits from the other tabs
  // were wiped — the live bug this whole rework closes).
  const [pendingMembership, setPendingMembership] = useState<Map<number, MembershipIntent>>(new Map());
  const [editingName, setEditingName] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const roleDirty = builtin
    ? (!setsEqual(draft.permissions, new Set(roleSnapshot.permissions))
      || draft.mentionable !== roleSnapshot.mentionable)
    : (draft.name.trim() !== roleSnapshot.name || draft.color !== roleSnapshot.color
      || draft.mentionable !== roleSnapshot.mentionable || draft.hoist !== roleSnapshot.hoist
      || !setsEqual(draft.permissions, new Set(roleSnapshot.permissions)));
  const dirty = roleDirty || pendingMembership.size > 0;

  // Follow the store row — a save of ours refreshes it (the draft then equals
  // the saved state), and so does any /topic/roles push. BUT never re-seed
  // while there are unsaved edits: the draft wins until it is saved or the
  // role is re-selected (the remount re-seeds), so a background refetch can no
  // longer wipe what the user is typing (the other half of the live bug).
  useEffect(() => {
    if (!dirty) {
      setDraft(draftOf(roleSnapshot));
      setEditingName(false);
    }
  }, [roleSnapshot, dirty]);

  // Pendings reconcile against fresh member rows (another admin may have
  // applied the same change): satisfied intents drop out by themselves.
  useEffect(() => {
    setPendingMembership((current) => reconcileMembershipPending(current, members, role.id));
  }, [members, role.id]);

  const patchDraft = (partial: Partial<RoleDraft>): void => {
    setDraft((previous) => ({ ...previous, ...partial }));
  };

  const stageMembership = (userId: number, intent: MembershipIntent | null): void => {
    setPendingMembership((current) => {
      const next = new Map(current);
      if (intent === null) {
        next.delete(userId);
      } else {
        next.set(userId, intent);
      }
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (!dirty || busy) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (roleDirty) {
        await session.updateRole(role.id, builtin
          ? {
            // @everyone: only permissions and mentionable are editable — no color
            // key at all (the server ignores it for the base row anyway).
            permissions: [...draft.permissions],
            mentionable: draft.mentionable,
          }
          : {
            // oak's partial-PATCH contract: the name travels ONLY when the user
            // actually changed it. The server validates names on update, and legacy
            // roles (created before that rule) can carry spaces — sending their
            // stored name on every save bounced color-only edits with 400 (live
            // report). null leaves the stored name untouched.
            name: draft.name.trim() !== roleSnapshot.name ? draft.name.trim() : null,
            // color is UNCONDITIONAL on the wire: null resets, so send the picked value.
            color: draft.color,
            permissions: [...draft.permissions],
            mentionable: draft.mentionable,
            hoist: draft.hoist,
          });
      }
      // The staged membership rides the same save: one PUT per member, bodies
      // built from the FRESH snapshot rows. Applied intents clear; a failure
      // keeps the rest staged and reports — the user retries Save.
      const failed: string[] = [];
      const applied: number[] = [];
      for (const [userId, intent] of pendingMembership) {
        const member = members.find((entry) => entry.userId === userId);
        if (member === undefined) {
          continue;
        }
        try {
          await session.rest.updateMemberRoles(userId, nextRoleIdsFor(member, role.id, intent));
          applied.push(userId);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          log.error("settings", `membership update failed (role=${role.id}, user=${userId}, intent=${intent}): ${message}`);
          failed.push(`${member.nickname}: ${message}`);
        }
      }
      if (applied.length > 0) {
        setPendingMembership((current) => {
          const next = new Map(current);
          for (const userId of applied) {
            next.delete(userId);
          }
          return next;
        });
      }
      if (failed.length > 0) {
        setStatus(`${failed.length} membership change${failed.length > 1 ? "s" : ""} failed — ${failed[0]}`);
      } else {
        setSaved(true);
      }
    } catch (error: unknown) {
      // The inline status is momentary — a rejected save must also land in
      // space.log (with what was actually sent) or the failure is undebuggable
      // once the selection changes (live report). The draft STAYS so the user
      // can fix and retry; only the status explains.
      const message = error instanceof Error ? error.message : String(error);
      log.error("settings", `role update failed (id=${role.id}, color=${draft.color}, name="${draft.name.trim()}"): ${message}`);
      setStatus(message);
    } finally {
      setBusy(false);
    }
  };

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
              value={draft.name}
              /* The field IS the label: same font, same color, no chrome — the
                  only cue of edit mode is the caret at the end (user decision). */
              style={{
                width: `${Math.max(draft.name.length, roleSnapshot.name.length, 4) + 1}ch`,
                color: draft.color !== null ? argbIntToCss(draft.color) : undefined,
              }}
              onFocus={(event) => {
                event.target.setSelectionRange(event.target.value.length, event.target.value.length);
              }}
              onChange={(event) => patchDraft({ name: event.target.value })}
              onBlur={() => setEditingName(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setEditingName(false);
                } else if (event.key === "Escape") {
                  patchDraft({ name: roleSnapshot.name }); // cancel — back to the stored name
                  setEditingName(false);
                }
              }}
            />
          ) : (
            /* The SPAN shows the DRAFT (name AND color), not the store row: both
               are only PATCHed on "Save Changes", so reading the store here
               reverted the display on every blur/tab-switch while the draft was
               intact. */
            <span className="role-editor-name" style={{ color: draft.color !== null ? argbIntToCss(draft.color) : undefined }}>
              {draft.name}
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
      {/* key=role.id REMOUNTS the tab on selection change (the tabs still hold
          selection-adjacent local state like the fetched catalog — without the
          remount a switch kept the PREVIOUS role's values; live report). The
          editor-level DRAFT is re-seeded by the snapshot effect above; the outer
          tab state survives, matching oak's TabPane. The wrapper owns the tab's
          scroll: the head, the tab row and the save row stay pinned. */}
      <div className="role-tab-body">
        {tab === "appearance" ? (
          <RoleAppearance key={role.id} role={role} draft={draft} patchDraft={patchDraft} />
        ) : tab === "permissions" ? (
          <RolePermissions key={role.id} session={session} role={role} draft={draft} patchDraft={patchDraft} />
        ) : (
          <RoleMembers key={role.id} session={session} role={role}
            pending={pendingMembership} onStage={stageMembership} />
        )}
      </div>
      {/* ONE cross-tab save — pinned below the scroll body, visible on every tab.
          It commits the WHOLE editor: the role draft (one PATCH) and every staged
          membership change (one PUT per member) — nothing applies piecemeal. */}
      {role.kind !== "OWNER" ? (
        <div className="modal-actions left role-editor-save">
          <SaveButton label="Save Changes" saved={saved} dirty={dirty} busy={busy} onClick={() => void submit()} />
          {status !== null ? <span className="settings-status">{status}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function RoleAppearance({ role, draft, patchDraft }: {
  role: Role;
  draft: RoleDraft;
  patchDraft(partial: Partial<RoleDraft>): void;
}): React.JSX.Element {
  const builtin = role.kind !== "CUSTOM";
  const [pickerOpen, setPickerOpen] = useState(false);
  const { color } = draft;

  // oak's swatch grid rows (presetColors): bright on top, muted below.
  const swatchRow = (presets: readonly number[], rowKey: string): React.JSX.Element => (
    <div className="role-palette-row" key={rowKey}>
      {presets.map((preset) => (
        <button
          key={`${rowKey}-${preset}`}
          className={"swatch" + (color === preset ? " chosen" : "")}
          style={{ background: argbIntToCss(preset) }}
          disabled={builtin}
          onClick={() => patchDraft({ color: preset })}
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
            <button className="ghost wide-add" disabled={builtin} onClick={() => patchDraft({ color: null })}>Default</button>
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
                patchDraft({ color: parsed });
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
          <input type="checkbox" checked={draft.mentionable} disabled={role.kind === "OWNER"} onChange={(event) => patchDraft({ mentionable: event.target.checked })} />
          <span>Mentionable</span>
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={draft.hoist} disabled={builtin} onChange={(event) => patchDraft({ hoist: event.target.checked })} />
          <span>Display separately (hoist)</span>
        </label>
      </div>
    </div>
  );
}

function RolePermissions({ session, role, draft, patchDraft }: {
  session: ConnectionSession;
  role: Role;
  draft: RoleDraft;
  patchDraft(partial: Partial<RoleDraft>): void;
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<readonly PermissionCatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const checked = draft.permissions;

  useEffect(() => {
    void session.rest.getPermissionCatalog().then(setCatalog).catch((error: unknown) => {
      setCatalogError(error instanceof Error ? error.message : String(error));
    });
  }, [session]);

  if (role.kind === "OWNER") {
    return <div className="settings-empty">The OWNER role cannot be edited.</div>;
  }

  return (
    <div className="fill-tab">
      {/* oak: the tab is captioned "Permissions" — no explainer paragraph (the
          VIEW_CHANNEL story lives in its absence: the checkbox simply isn't there). */}
      <div className="settings-hint">Permissions</div>
      {catalogError !== null ? (
        <div className="settings-empty">{catalogError}</div>
      ) : catalog === null ? (
        <div className="settings-empty">Loading catalog…</div>
      ) : (
        /* The permission list FILLS the tab body (user decision 2026-10-05): its
           scroll area reaches the divider above the pinned cross-tab Save button —
           no fixed cap, no dead space under a short-looking list. */
        <div className="permissions-scroll-box">
          {(["GENERAL", "TEXT", "VOICE"] as const).map((group) => {
            const entries = catalog.filter((entry) => entry.group === group && entry.name !== "VIEW_CHANNEL"
              // The DM restriction reads RAW held roles only — @everyone's copy of the bit is
              // ignored by the server check, so the checkbox on the base row would be a lie.
              && !(role.kind === "EVERYONE" && entry.name === "RESTRICT_PRIVATE_MESSAGES"));
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
                          const next = new Set(checked);
                          if (event.target.checked) {
                            next.add(entry.name);
                          } else {
                            next.delete(entry.name);
                          }
                          patchDraft({ permissions: next });
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
    </div>
  );
}

function RoleMembers({ session, role, pending, onStage }: {
  session: ConnectionSession;
  role: Role;
  /** The editor's staged membership map — the tab is fully controlled. */
  pending: ReadonlyMap<number, MembershipIntent>;
  onStage(userId: number, intent: MembershipIntent | null): void;
}): React.JSX.Element {
  const members = useStore(session.memberStore, (state) => state.members);
  const roles = useStore(session.memberStore, (state) => state.roles);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const rows = membershipRows(members, role.id, pending);
  // oak's AddMemberDialog candidates: everyone WITHOUT the role (and without a
  // staged add already sitting in the list), name-sorted. The NICKNAME is the
  // display name everywhere (the rename model) — rows keyed by username
  // underneath, never showing it (live report: logins leaked here).
  const candidates = membershipCandidates(members, role.id, pending);

  return (
    <div>
      {/* oak's members tab: just the scrollable holder list with the full-width
          "Add member" button UNDER it — no explainer paragraph. Staged rows
          carry their highlight; nothing leaves until "Save Changes". */}
      {rows.length === 0 ? (
        <div className="settings-empty">No members have this role</div>
      ) : (
        rows.map((row) => (
          <div key={row.member.userId} className={"list-row role-member-row " + row.state}>
            <Avatar session={session} username={row.member.username} size={28} />
            <span className="member-name" style={{ color: memberNameColor(row.member, roles) ?? undefined }}>{row.member.nickname}</span>
            {row.state === "pending-remove" ? (
              /* A staged removal is undoable until Save: the row stays visible,
                 dimmed and struck, and the button puts it back. */
              <button className="ghost tiny role-remove" title="Undo removal (staged)"
                onClick={() => onStage(row.member.userId, null)}>
                <span className="icon mdi-undo" />
              </button>
            ) : row.state === "pending-add" ? (
              <button className="ghost tiny role-remove" title="Unstage (not saved yet)"
                onClick={() => onStage(row.member.userId, null)}>
                <span className="icon mdi-close" />
              </button>
            ) : (
              /* oak's removal glyph: the small close icon on the row's right
                 (role-trash-button + Icons.close), not a textual "×". */
              <button className="ghost tiny role-remove" title="Remove role"
                onClick={() => onStage(row.member.userId, "remove")}>
                <span className="icon mdi-close" />
              </button>
            )}
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
            <button className="primary" disabled={picked.size === 0} onClick={() => {
              /* Staging, not sending: the picker's picks join the pending map —
                 the cross-tab Save applies them with everything else. */
              for (const userId of picked) {
                onStage(userId, "add");
              }
              setPickerOpen(false);
              setPicked(new Set());
            }}>
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
  // The transfer entry is OWNER-ONLY and invisible (not disabled) to everyone else —
  // a non-owner seeing a dead button would only wonder (user decision).
  const selfIsOwner = useStore(session.permissionStore, (state) => state.my?.owner ?? false);
  // The live outgoing offer (if any): its recipient's row swaps the button to the
  // cancel flow (user decision — the recipient is the "pending" state, not a fresh offer).
  const pendingTransfer = useStore(session.ownershipStore, (state) => state.pending);
  const selfUserId = session.selfUserId();
  const outgoingTransfer = pendingTransfer !== null && selfUserId !== null
    && isOutgoingPending(pendingTransfer, selfUserId) ? pendingTransfer : null;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ServerMember | null>(null);
  const [banTarget, setBanTarget] = useState<ServerMember | null>(null);
  // The rename form state (the nickname is the ONE display name).
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameStatus, setRenameStatus] = useState<string | null>(null);
  /** The removal audit — removed members never appear in /api/members, they ride
   *  /api/members/bans with removed=true. Refetched whenever the member snapshot
   *  changes (the "removed" push rides the same /topic/members refetch). */
  const [removedMembers, setRemovedMembers] = useState<ServerMember[]>([]);

  useEffect(() => {
    let cancelled = false;
    session.rest.getBannedMembers()
      .then((banned) => {
        if (!cancelled) {
          setRemovedMembers(banned.filter((member) => member.removed === true));
        }
      })
      .catch((refreshError: unknown) => {
        // a transient failure keeps the previous audit list — but not silently
        log.warn("settings", `banned/removed audit refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [session.rest, members]);

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
        {/* The removal audit — permanent rows, no actions (there is no un-remove). */}
        {removedMembers.length > 0 ? (
          <>
            <div className="roles-list-header"><span>Removed — {removedMembers.length}</span></div>
            {removedMembers.map((member) => (
              <div key={member.userId} className="roles-row" title="Cannot rejoin the server">
                <Avatar session={session} username={member.username} size={20} />
                <span className="member-name">{member.nickname}</span>
                <span className="removed-badge">REMOVED</span>
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
                    /* oak shows the moderation buttons DISABLED for the owner (not
                       hidden) — the owner is immune, the buttons just never fire. */
                    <button className="danger" disabled={active.owner} onClick={() => setRemoveTarget(active)}>Remove from server</button>
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
              {/* The owner may hand the crown to any plain member right from the row —
                  the modal opens at the confirm step for this member (user decision:
                  the entry point lives HERE, not in the server menu). Hidden for a
                  banned member (the server refuses the offer) and for the owner row.
                  The LIVE offer's recipient swaps the button to the cancel flow. */}
              {selfIsOwner && !active.banned && !active.owner ? (
                outgoingTransfer !== null && outgoingTransfer.toUserId === active.userId ? (
                  <button className="danger" onClick={() => openOwnershipTransfer(active.userId)}>
                    Cancel ownership transfer
                  </button>
                ) : (
                  <button className="primary" onClick={() => openOwnershipTransfer(active.userId)}>
                    Transfer ownership
                  </button>
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
      {removeTarget !== null ? (
        <ConfirmModal
          title="Remove member"
          note={`Remove "${removeTarget.nickname}" from the server? They will be permanently removed and will not be able to rejoin.`}
          confirmLabel="Remove"
          onConfirm={async () => {
            await session.removeMember(removeTarget.userId);
          }}
          onClose={() => setRemoveTarget(null)}
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
// Invites (registration links, MANAGE_MEMBERS)
// ---------------------------------------------------------------------------

/** The Invites section: the TTL setting (authored in MINUTES with a live human-word
 *  rendering beside the field; retroactive on the server — saving may kill or extend
 *  existing links) and the ACTIVE links list. Used/expired/revoked links are gone from
 *  the list (server's choice); Copy copies the assembled link, not the bare secret.
 *  Data lives in the session's InvitesStore — a /topic/invites ping (a mint, an expiry,
 *  a TTL change, or a REGISTRATION claiming a link) refreshes it, so a spent link drops
 *  out of an open screen without a reopen. */
function InvitesSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const invitesState = useStore(session.invitesStore, (state) => state);
  const [ttlDraft, setTtlDraft] = useState("");
  /** True once the user typed in the TTL field — loaded values stop overwriting the
   *  draft (an empty mid-edit field must not snap back to the stored number). */
  const ttlTouchedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expireAllOpen, setExpireAllOpen] = useState(false);
  /** The invite whose link was just copied — the Copy glyph flips to a check briefly. */
  const [copiedId, setCopiedId] = useState<number | null>(null);
  /** The "Copied to clipboard" popover by the Create button (create copies
   *  silently into the clipboard — the popover is the only confirmation). */
  const [copiedFlash, setCopiedFlash] = useState(false);
  const copiedFlashTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copiedFlashTimerRef.current !== null) {
      window.clearTimeout(copiedFlashTimerRef.current);
    }
  }, []);
  /** Ticks every 15 s so the "expires in …" labels stay honest — they render from
   *  Date.now() and nothing else re-renders the section, so a label could sit frozen at
   *  "1m" forever while the link is long dead (only a Copy click happened to refresh
   *  it — user report). */
  const [, setExpiryTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setExpiryTick((tick) => tick + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // The mount fetch (and every later ping) lands through the store.
  useEffect(() => {
    session.refreshInvites();
  }, [session]);

  useEffect(() => {
    if (!ttlTouchedRef.current) {
      setTtlDraft(String(invitesState.ttlMinutes));
    }
  }, [invitesState.ttlMinutes]);

  const ttlNumber = Number(ttlDraft);
  const ttlValid = Number.isInteger(ttlNumber) && ttlNumber >= 1 && ttlNumber <= 525_600;
  // An INVALID draft keeps Save disabled — dirty only counts when the draft is valid.
  const ttlDirty = invitesState.loaded && ttlValid && ttlNumber !== invitesState.ttlMinutes;

  const saveTtl = async (): Promise<void> => {
    if (busy || !ttlValid) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Retroactive: the server reschedules every ACTIVE link to createdAt + the new TTL.
      await session.rest.updateInviteSettings(ttlNumber);
      ttlTouchedRef.current = false; // the store's echo is the authority again
      setSaved(true);
      session.refreshInvites();
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The fresh link goes to the clipboard IMMEDIATELY (user request
      // 2026-10-19): creating an invite exists to hand it to someone, the
      // per-row Copy button stays for later re-copies. A two-second popover
      // by the Create button confirms the copy (second-pass user request —
      // NOT a toast in the corner).
      copyLink(await session.rest.createInvite());
      setCopiedFlash(true);
      if (copiedFlashTimerRef.current !== null) {
        window.clearTimeout(copiedFlashTimerRef.current);
      }
      copiedFlashTimerRef.current = window.setTimeout(() => setCopiedFlash(false), 2000);
      session.refreshInvites();
    } catch (createError: unknown) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  };

  const expireOne = async (inviteId: number): Promise<void> => {
    try {
      await session.rest.revokeInvite(inviteId);
    } catch (revokeError: unknown) {
      setError(revokeError instanceof Error ? revokeError.message : String(revokeError));
    }
    session.refreshInvites();
  };

  const copyLink = (invite: InviteLink): void => {
    void navigator.clipboard.writeText(invite.link).catch(() => undefined);
    setCopiedId(invite.id);
    window.setTimeout(() => {
      setCopiedId((previous) => previous === invite.id ? null : previous);
    }, 1500);
  };

  return (
    <div>
      <div className="roles-list-header overview-heading"><span>Invites</span></div>
      <div className="settings-hint">
        An invite link registers exactly ONE new member and stops working after its TTL.
        Registration on this server is invite-only.
      </div>
      <div className="invite-ttl-row">
        <div className="invite-ttl-input-row">
          <span className="invite-ttl-label">Invite links expire after</span>
          {/* Only the INPUT is wrapped: the human rendering hangs off it absolutely
              (top: 100%), flush under the field, completely outside the row's flow —
              the label/"min"/Save arrangement cannot shift. */}
          <span className="invite-ttl-input-wrap">
            <input
              type="number"
              min={1}
              max={525_600}
              value={ttlDraft}
              onChange={(event) => {
                ttlTouchedRef.current = true;
                setTtlDraft(event.target.value);
                setSaved(false);
              }}
            />
            <span className="invite-ttl-human">{ttlValid ? formatTtlWords(ttlNumber) : ""}</span>
          </span>
          <span className="invite-ttl-unit">min</span>
          <SaveButton label="Save changes" saved={saved} dirty={ttlDirty} busy={busy} onClick={() => void saveTtl()} />
        </div>
      </div>
      <div className="settings-hint">Changing the TTL reschedules every active link (lowering it may expire some immediately).</div>
      <div className="modal-actions left">
        {/* The copy confirmation rides NEXT TO THE BUTTON (user request
            2026-10-19, second pass: a toast in the far corner is easy to miss
            and the action happened HERE). */}
        <span className="invite-create-wrap">
          {copiedFlash ? <span className="copied-popover">Copied to clipboard</span> : null}
          <button className="primary" disabled={busy} onClick={() => void createInvite()}>Create invite</button>
        </span>
        <button className="ghost" disabled={busy || invitesState.invites.length === 0} onClick={() => setExpireAllOpen(true)}>
          Expire all
        </button>
      </div>
      {error !== null ? <div className="error-line">{error}</div> : null}
      {!invitesState.loaded ? (
        <div className="settings-empty">Loading invites…</div>
      ) : invitesState.invites.length === 0 ? (
        <div className="settings-empty">No active invites. Create one to let a new member register.</div>
      ) : (
        invitesState.invites.map((invite) => {
          const expiresIn = formatExpiresIn(invite.expiresAt, Date.now());
          return (
          <div key={invite.id} className="list-row invite-row">
            <span className="invite-secret" title={invite.link}>{invite.secretPreview}</span>
            <span className="invite-meta">created by {invite.createdBy}</span>
            {/* "expired" stands alone — no "expires in" prefix on a dead link. */}
            <span className="invite-meta">{expiresIn === "expired" ? "expired" : `expires in ${expiresIn}`}</span>
            <span className="invite-actions">
              <button
                className="ghost tiny"
                title="Copy link"
                onClick={() => copyLink(invite)}
              ><span className={"icon " + (copiedId === invite.id ? "mdi-check" : "mdi-content-copy")} /></button>
              <button
                className="ghost tiny"
                title="Expire this invite"
                disabled={busy}
                onClick={() => void expireOne(invite.id)}
              ><span className="icon mdi-close" /></button>
            </span>
          </div>
          );
        })
      )}
      {expireAllOpen ? (
        <ConfirmModal
          title="Expire all invites"
          note="Every active invite link will stop working immediately. New members will need a fresh link."
          confirmLabel="Expire all"
          onConfirm={async () => {
            await session.rest.expireAllInvites();
            session.refreshInvites();
          }}
          onClose={() => setExpireAllOpen(false)}
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
  const [createOpen, setCreateOpen] = useState(false);
  const list = channels.filter((channel) => channel.type === "TEXT" || channel.type === "VOICE");
  const categories = channels.filter((channel) => channel.type === "CATEGORY");
  const selected = list.find((channel) => channel.id === selectedId) ?? null;

  return (
    <div className="roles-layout">
      <div className="roles-list">
        <div className="roles-list-header">
          <span>Channels — {list.length}</span>
          {/* The Roles idiom: the header "+" creates a channel through the SAME dialog
              the sidebar's channel panel uses (user request). */}
          <button className="section-add" title="Create channel" onClick={() => setCreateOpen(true)}>+</button>
        </div>
        {list.map((channel) => (
          <div key={channel.id} className={"roles-row" + (channel.id === selected?.id ? " active" : "")}
            onClick={() => setSelectedId(channel.id)}>
            <ChannelGlyph voice={channel.type === "VOICE"} locked={channel.locked} />
            <span className="role-name">{channel.name}</span>
            {channel.afk === true ? <span className="afk-badge">AFK</span> : null}
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
      {createOpen ? (
        <CreateChannelModal
          session={session}
          request={{ kind: "TEXT", parentId: null, inCategory: false }}
          categories={categories}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
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
  const [tab, setTab] = useState<"permissions" | "access" | "afk">("permissions");
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
        {/* The AFK designation is a VOICE-channel concern (the idle-sweep target). */}
        {channel.type === "VOICE" ? (
          <button className={"settings-tab" + (tab === "afk" ? " active" : "")} onClick={() => setTab("afk")}>AFK</button>
        ) : null}
      </div>
      {/* key=channel.id — same remount contract as the role editor: local edit
          state must never survive a channel switch. The wrapper owns the tab's
          scroll (the head and the tab row stay pinned above it). */}
      <div className="role-tab-body">
        {tab === "permissions" ? (
          <ChannelPermissionsTab key={channel.id} session={session} channel={channel} />
        ) : tab === "access" ? (
          <ChannelAccessTab key={channel.id} session={session} channel={channel} />
        ) : (
          <ChannelAfkTab key={channel.id} session={session} channel={channel} />
        )}
      </div>
    </div>
  );
}

/** The VOICE channel's AFK tab: designate THIS room as the server's AFK channel (at
 *  most one exists — another channel's designation is shown read-only here) and edit
 *  the idle timeout. Staged draft (the ServerStorageSection idiom). */
function ChannelAfkTab({ session, channel }: {
  session: ConnectionSession;
  channel: Channel;
}): React.JSX.Element {
  const channels = useStore(session.channelStore, (allChannels) => allChannels);
  const [loaded, setLoaded] = useState(false);
  const [isAfkDraft, setIsAfkDraft] = useState(false);
  const [timeoutDraft, setTimeoutDraft] = useState(30);
  const [initialIsAfk, setInitialIsAfk] = useState(false);
  const [initialTimeout, setInitialTimeout] = useState(30);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    session.rest.getAfkSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        const timeout = settings.afkTimeoutMinutes ?? 30;
        const isAfk = settings.afkChannelId === channel.id;
        setInitialIsAfk(isAfk);
        setInitialTimeout(timeout);
        setIsAfkDraft(isAfk);
        setTimeoutDraft(timeout);
        setLoaded(true);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session.rest, channel.id]);

  // Another channel already holds the designation — this tab is read-only for it
  // (user decision: an AFK channel may only be set where none exists yet).
  const afkHolder = channels.find((entry) => entry.afk === true && entry.id !== channel.id) ?? null;

  const dirty = loaded && (isAfkDraft !== initialIsAfk || timeoutDraft !== initialTimeout);
  const save = async (): Promise<void> => {
    if (busy || !dirty) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const stored = await session.rest.updateAfkSettings(isAfkDraft ? channel.id : null, timeoutDraft);
      const timeout = stored.afkTimeoutMinutes ?? timeoutDraft;
      setInitialIsAfk(stored.afkChannelId === channel.id);
      setInitialTimeout(timeout);
      setIsAfkDraft(stored.afkChannelId === channel.id);
      setTimeoutDraft(timeout);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  if (afkHolder !== null && !initialIsAfk) {
    return (
      <div>
        <div className="overview-heading">AFK channel</div>
        <div className="settings-hint">
          {`"${afkHolder.name}" is already this server's AFK channel — remove the designation there first.`}
        </div>
      </div>
    );
  }

  return (
    <div className="afk-settings fill-tab">
      <div className="overview-heading">AFK channel</div>
      <div className="settings-hint">
        Idle voice members are moved here automatically. Members in this channel are
        server-muted and cannot share their screen.
      </div>
      <div className="settings-check">
        <input
          type="checkbox"
          id="afk-designation"
          checked={isAfkDraft}
          onChange={(event) => setIsAfkDraft(event.target.checked)}
        />
        <label htmlFor="afk-designation">This channel is the AFK channel</label>
      </div>
      {isAfkDraft ? (
        <label className="settings-field">
          <span>AFK timeout</span>
          <select value={timeoutDraft} onChange={(event) => setTimeoutDraft(Number(event.target.value))}>
            {AFK_TIMEOUT_PRESETS.map((preset) => (
              <option key={preset.minutes} value={preset.minutes}>{preset.label}</option>
            ))}
          </select>
        </label>
      ) : null}
      {/* The shared footer idiom (user decision 2026-10-06): the same divider +
          Save row pinned to the panel bottom as in Roles — the status rides INSIDE
          the row like every other tab's, not on a separate error line below. */}
      <div className="modal-actions left role-editor-save">
        <SaveButton label="Save changes" saved={saved} dirty={dirty} busy={busy} onClick={() => void save()} />
        {error !== null ? <span className="settings-status">{error}</span> : null}
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
    void session.rest.getPermissionCatalog().then(setCatalog).catch((catalogError: unknown) => {
      // the picker shows bare enum names without descriptions — the reason belongs on disk
      log.warn("settings", `permission catalog fetch failed: ${catalogError instanceof Error ? catalogError.message : String(catalogError)}`);
    });
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
    <div className="fill-tab">
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
          {/* The permission LIST fills the tab body and scrolls INSIDE it (user
              decision 2026-10-05): the hint, the role picker and the Save row stay
              pinned, the list runs down to the Save row — no fixed 340px cap.
              Grouped and laid out EXACTLY like the role-permissions list (same
              sections, same row geometry, same fonts) — only the box cycles. */}
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
          <div className="modal-actions left role-editor-save">
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
    <div className="fill-tab">
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
      <div className="modal-actions left role-editor-save">
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

/** One catalog cell of the Emoji section: the image, the ":name:" label and the
 *  delete cross (a ConfirmModal follows). */
function EmojiCatalogCell({ session, emoji, onDelete }: {
  session: ConnectionSession;
  emoji: CustomEmoji;
  onDelete(emoji: CustomEmoji): void;
}): React.JSX.Element {
  const imageUrl = useAttachmentImage(
    session,
    emoji.url !== null ? { key: emoji.key, url: emoji.url } : null,
  );
  return (
    <div className="emoji-cell">
      {imageUrl !== null
        ? <img src={imageUrl} alt={emoji.name} draggable={false} />
        : <span className="emoji-cell-fallback">{emoji.name.slice(0, 2)}</span>}
      <span className="emoji-cell-name" title={`:${emoji.name}:`}>:{emoji.name}:</span>
      <button className="icon-button emoji-cell-remove" title="Delete emoji" onClick={() => onDelete(emoji)}>
        <span className="icon mdi-close" />
      </button>
    </div>
  );
}

/** Shared Export/Import state of the two expression sections: the busy flag
 *  (disables the section's own upload/create buttons), a muted progress line
 *  ("Exporting 12 / 45…"), and the green final report. Terminal failures land
 *  in the section's own error line through {@code onError}. Import goes
 *  through the PREVIEW modal: pick → readPackArchive → previewArchive state →
 *  the modal's Confirm feeds the user-filtered archive back here. No cancel
 *  once confirmed: the run is bounded by the catalog caps and survives the
 *  pane closing. */
function useExpressionExchange(
  session: ConnectionSession,
  onError: (message: string) => void,
): {
  exchangeBusy: boolean;
  exchangeStatus: string | null;
  exchangeReport: string | null;
  previewArchive: ParsedPackArchive | null;
  runExport: (scope: ExportScope) => Promise<void>;
  openImportPreview: (file: File | null) => Promise<void>;
  confirmImport: (filtered: ParsedPackArchive) => Promise<void>;
  closePreview: () => void;
} {
  const serverName = connectionDirectory.get(session.recordId)?.cachedServerName ?? "";
  const [exchangeBusy, setExchangeBusy] = useState(false);
  const [exchangeStatus, setExchangeStatus] = useState<string | null>(null);
  const [exchangeReport, setExchangeReport] = useState<string | null>(null);
  const [previewArchive, setPreviewArchive] = useState<ParsedPackArchive | null>(null);

  const progressLine = (label: string, done: number, total: number): string =>
    total > 0 ? `${label} ${done} / ${total}…` : `${label}…`;

  const runExport = async (scope: ExportScope): Promise<void> => {
    if (exchangeBusy) {
      return;
    }
    setExchangeBusy(true);
    setExchangeStatus("Exporting…");
    setExchangeReport(null);
    onError(""); // clear a stale error the run supersedes
    const result = await exportExpressionPack(session, scope, serverName, (progress) =>
      setExchangeStatus(progressLine("Exporting", progress.done, progress.total)),
    );
    setExchangeBusy(false);
    if (result.status === "failed") {
      setExchangeStatus(null);
      onError(result.error ?? "Export failed.");
      return;
    }
    setExchangeStatus(null);
    setExchangeReport(
      formatExportReport({
        emojis: result.emojis,
        stickers: result.stickers,
        packs: result.packs,
        unavailable: result.unavailable,
        fileName: result.fileName,
      }),
    );
  };

  const openImportPreview = async (file: File | null): Promise<void> => {
    if (file === null || exchangeBusy) {
      return;
    }
    setExchangeReport(null);
    onError("");
    const read = await readPackArchive(file);
    if (!read.ok) {
      onError(read.error);
      return;
    }
    setPreviewArchive(read.archive);
  };

  const confirmImport = async (filtered: ParsedPackArchive): Promise<void> => {
    if (exchangeBusy) {
      return;
    }
    setPreviewArchive(null);
    setExchangeBusy(true);
    setExchangeStatus("Importing…");
    const result = await importPackArchive(session, filtered, (progress) =>
      setExchangeStatus(progressLine("Importing", progress.done, progress.total)),
    );
    setExchangeBusy(false);
    setExchangeStatus(null);
    setExchangeReport(formatImportReport(result.counts, result.packsCreated));
  };

  const closePreview = (): void => {
    setPreviewArchive(null);
  };

  return { exchangeBusy, exchangeStatus, exchangeReport, previewArchive, runExport, openImportPreview, confirmImport, closePreview };
}

/** One tile row of the import preview (the catalog-cell look, state-driven):
 *  selected = blurple tint+border (it WILL land), off = the user deselected
 *  it (a click brings it back), blocked = the planner refused it (dim, reason
 *  under the name, clicks ignored). */
interface ImportPreviewItem {
  key: string;
  name: string;
  file: string;
  /** The planner would import it — only these tiles are clickable. */
  planned: boolean;
  /** Human-readable skip reason for blocked tiles. */
  reason: string | null;
}

function previewItemKey(kind: "emoji" | "sticker", packName: string, name: string): string {
  return `${kind}:${packName}:${name}`;
}

function skipReasonOf(decision: ImportDecision): string | null {
  if (decision.kind === "skip-name-exists") {
    return "name exists";
  }
  if (decision.kind === "skip-limit") {
    return "limit reached";
  }
  if (decision.kind === "skip-invalid") {
    return decision.reason;
  }
  return null;
}

/** The import preview modal: the planner's verdict per item on the CURRENT
 *  catalogs, blurple-highlighted tiles for what will land, a click excludes
 *  or re-includes an item, Confirm/Cancel under the grid. The filtered
 *  manifest (empty packs dropped — no empty-pack litter) goes back through
 *  onConfirm. Planner decisions are a PREVIEW: names taken between the
 *  preview and the confirm surface as runtime conflicts in the report. */
function ImportPreviewModal({ session, archive, onConfirm, onClose }: {
  session: ConnectionSession;
  archive: ParsedPackArchive;
  onConfirm: (filtered: ParsedPackArchive) => void;
  onClose: () => void;
}): React.JSX.Element {
  const plan = useMemo(
    () => planPackImport(archive.manifest, archive.files, catalogSnapshotOf(session)),
    [archive, session],
  );

  const emojiItems = useMemo<ImportPreviewItem[]>(
    () =>
      plan.emojiDecisions.map((decision, decisionIndex) => ({
        key: previewItemKey("emoji", "", decision.name),
        name: decision.name,
        file: archive.manifest.emojis[decisionIndex]?.file ?? "",
        planned: decision.kind === "import",
        reason: skipReasonOf(decision),
      })),
    [plan, archive],
  );
  const packSections = useMemo(
    () =>
      archive.manifest.packs.map((manifestPack) => {
        const trimmedName = manifestPack.name.trim();
        const packPlan = plan.packPlans.find((candidate) => candidate.manifestPack.name === trimmedName) ?? null;
        const packSkip = plan.skippedPacks.find((candidate) => candidate.name.trim() === trimmedName) ?? null;
        const items: ImportPreviewItem[] = manifestPack.stickers.map((stickerEntry) => {
          // decision lookup by name — same-named manifest packs merged into one
          // plan share it, a duplicated name in the second chunk shows the first
          // chunk's verdict (cosmetic; the runtime reports the duplicate).
          const decision = packPlan?.decisions.find((candidate) => candidate.name === stickerEntry.name) ?? null;
          const packBlockedReason =
            packSkip !== null ? (packSkip.reason === "pack-limit" ? "pack limit reached" : "invalid pack name") : null;
          return {
            key: previewItemKey("sticker", trimmedName, stickerEntry.name),
            name: stickerEntry.name,
            file: stickerEntry.file,
            planned: decision !== null && decision.kind === "import" && packBlockedReason === null,
            reason: packBlockedReason ?? (decision !== null ? skipReasonOf(decision) : "duplicate name in the pack"),
          };
        });
        return { name: manifestPack.name, items };
      }),
    [plan, archive],
  );

  const allItems = useMemo(() => [...emojiItems, ...packSections.flatMap((section) => section.items)], [emojiItems, packSections]);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set(allItems.filter((item) => item.planned).map((item) => item.key)));
  useEffect(() => {
    setSelectedKeys(new Set(allItems.filter((item) => item.planned).map((item) => item.key)));
  }, [allItems]);

  // Thumbnails come straight from the archive bytes (blob URLs, no network);
  // revoked wholesale when the archive leaves the modal.
  const thumbnails = useMemo(() => {
    const urls = new Map<string, string>();
    for (const [path, bytes] of archive.files) {
      urls.set(path, URL.createObjectURL(new Blob([bytes.slice()])));
    }
    return urls;
  }, [archive]);
  useEffect(() => {
    return () => {
      for (const url of thumbnails.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [thumbnails]);

  const toggleItem = (item: ImportPreviewItem): void => {
    if (!item.planned) {
      return;
    }
    setSelectedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(item.key)) {
        next.delete(item.key);
      } else {
        next.add(item.key);
      }
      return next;
    });
  };

  const confirm = (): void => {
    onConfirm({
      manifest: {
        ...archive.manifest,
        emojis: archive.manifest.emojis.filter((emojiEntry) => selectedKeys.has(previewItemKey("emoji", "", emojiEntry.name))),
        packs: archive.manifest.packs
          .map((manifestPack) => ({
            ...manifestPack,
            stickers: manifestPack.stickers.filter((stickerEntry) =>
              selectedKeys.has(previewItemKey("sticker", manifestPack.name.trim(), stickerEntry.name)),
            ),
          }))
          .filter((manifestPack) => manifestPack.stickers.length > 0),
      },
      files: archive.files,
    });
  };

  const renderCell = (item: ImportPreviewItem): React.JSX.Element => {
    const isSelected = selectedKeys.has(item.key);
    const cellState = !item.planned ? "blocked" : isSelected ? "selected" : "off";
    const thumbnailUrl = thumbnails.get(item.file);
    return (
      <button
        key={item.key}
        className={`import-preview-cell ${cellState}`}
        disabled={!item.planned}
        onClick={() => toggleItem(item)}
        title={item.reason ?? item.name}
      >
        {thumbnailUrl !== undefined ? <img src={thumbnailUrl} alt={item.name} /> : <span className="import-preview-thumb" />}
        <span className="import-preview-name">{item.name}</span>
        {item.reason !== null ? <span className="import-preview-reason">{item.reason}</span> : null}
      </button>
    );
  };

  const plannedCount = allItems.filter((item) => item.planned).length;
  return (
    <div className="modal-overlay">
      <div className="modal-card wide">
        <div className="modal-titlebar">
          <span className="modal-title">Import expressions</span>
          <button className="modal-close" onClick={onClose}><span className="icon mdi-close" /></button>
        </div>
        <div className="modal-note">
          From &quot;{archive.manifest.serverName}&quot; — highlighted tiles will be imported, click one to exclude it.
        </div>
        <div className="import-preview-body">
          {emojiItems.length > 0 ? (
            <div className="import-preview-section">
              <span className="import-preview-title">Emojis</span>
              <div className="import-preview-grid">{emojiItems.map(renderCell)}</div>
            </div>
          ) : null}
          {packSections.map((section) => (
            <div key={section.name} className="import-preview-section">
              <span className="import-preview-title">{section.name}</span>
              <div className="import-preview-grid">{section.items.map(renderCell)}</div>
            </div>
          ))}
          {allItems.length === 0 ? <div className="modal-note">The archive contains no emojis or stickers.</div> : null}
        </div>
        <div className="modal-note">{selectedKeys.size} of {allItems.length} items will be imported ({plannedCount} available).</div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={selectedKeys.size === 0} onClick={confirm}>Import {selectedKeys.size}</button>
        </div>
      </div>
    </div>
  );
}

function ServerEmojiSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const emojiState = useStore(session.emojiStore, (state) => state);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomEmoji | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const { exchangeBusy, exchangeStatus, exchangeReport, previewArchive, runExport, openImportPreview, confirmImport, closePreview } =
    useExpressionExchange(session, setError);

  const resetPending = (): void => {
    setPendingFile(null);
    setPendingKey(null);
    setNameDraft("");
    setError(null);
  };

  // The client-side validation ladder BEFORE any network work: extension → size →
  // dimensions (warn-only) → the name (prefilled from the file name, regex + local
  // uniqueness). The server re-validates everything (400/409 surface here verbatim).
  const pickFile = (file: File | null): void => {
    if (file === null) {
      return;
    }
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".png") && !lower.endsWith(".gif") && !lower.endsWith(".webp")) {
      setError("Pick a PNG, GIF or WebP image.");
      return;
    }
    if (file.size > 1024 * 1024) {
      setError("The file is larger than 1 MB.");
      return;
    }
    void measureImageSize(file).then((size) => {
      if (size !== null && (size.width > 256 || size.height > 256)) {
        log.warn("settings", `emoji ${file.name} is ${size.width}x${size.height} — larger than 256px, it will render downscaled`);
      }
    });
    const suggested = emojiNameFromFileName(file.name);
    if (emojiState.names.has(suggested)) {
      setError(`The name ":${suggested}:" is already taken — pick another.`);
    }
    setPendingFile(file);
    setNameDraft(suggested);
    setPendingKey(null);
  };

  const uploadPending = async (): Promise<void> => {
    if (pendingFile === null) {
      return;
    }
    const name = nameDraft.trim();
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
      setError("The name must be 1-32 chars of a-z, 0-9, _ and -.");
      return;
    }
    if (emojiState.names.has(name)) {
      setError(`The name ":${name}:" is already taken.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let key = pendingKey;
      if (key === null) {
        const slot = await session.rest.requestEmojiUploadSlot(sanitizeSlotFileName(pendingFile.name));
        await session.rest.uploadBytes(slot.uploadUrl, await pendingFile.arrayBuffer(), pendingFile.type || "image/png");
        key = slot.key;
        setPendingKey(key); // a name conflict retries ONLY the create step
      }
      await session.rest.createEmoji({ name, fileKey: key });
      session.refreshEmojis();
      resetPending();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="roles-list-header overview-heading"><span>Emoji</span></div>
      <div className="emoji-upload-row">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/gif,image/webp"
          hidden
          onChange={(event) => {
            pickFile(event.target.files?.[0] ?? null);
            event.target.value = ""; // let the same file be re-picked after a fix
          }}
        />
        <input
          ref={zipInputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            void openImportPreview(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
        <button className="primary" disabled={busy || exchangeBusy || !emojiState.supported} onClick={() => fileInputRef.current?.click()}>
          Upload emoji
        </button>
        <button
          disabled={busy || exchangeBusy || !emojiState.supported || emojiState.emojis.length === 0}
          onClick={() => void runExport({ kind: "emojis" })}
        >Export all</button>
        <button
          disabled={busy || exchangeBusy || !emojiState.supported}
          onClick={() => zipInputRef.current?.click()}
        >Import</button>
        <span className="emoji-count">{emojiState.emojis.length} / 200</span>
      </div>
      <div className="settings-hint">PNG, GIF or WebP · up to 1 MB · larger than 256×256 renders downscaled</div>
      <div className="exchange-status">{exchangeStatus ?? ""}</div>
      {exchangeReport !== null ? <div className="exchange-report">{exchangeReport}</div> : null}
      {pendingFile !== null ? (
        <div className="emoji-upload-form">
          <span className="emoji-upload-file" title={pendingFile.name}>{pendingFile.name}</span>
          <div className="emoji-upload-form-row">
            <input
              type="text"
              value={nameDraft}
              maxLength={32}
              placeholder="name"
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) {
                  event.preventDefault();
                  void uploadPending();
                }
              }}
            />
            <button className="primary" disabled={busy} onClick={() => void uploadPending()}>Save</button>
            <button className="ghost" disabled={busy} onClick={resetPending}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div className="error-line">{error ?? ""}</div>
      {emojiState.emojis.length === 0 ? (
        <div className="emoji-empty">No custom emojis yet — upload a PNG, GIF or WebP up to 1 MB.</div>
      ) : (
        <div className="emoji-grid">
          {emojiState.emojis.map((emoji) => (
            <EmojiCatalogCell key={emoji.id} session={session} emoji={emoji} onDelete={setDeleteTarget} />
          ))}
        </div>
      )}
      {deleteTarget !== null ? (
        <ConfirmModal
          title="Delete emoji"
          note={`Delete :${deleteTarget.name}:? Messages using it will fall back to plain text.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await session.rest.deleteEmoji(deleteTarget.id);
            session.refreshEmojis();
          }}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
      {previewArchive !== null ? (
        <ImportPreviewModal
          session={session}
          archive={previewArchive}
          onConfirm={(filtered) => void confirmImport(filtered)}
          onClose={closePreview}
        />
      ) : null}
    </div>
  );
}

/** One catalog cell of the Sticker section (the EmojiCatalogCell idiom, bigger preview). */
function StickerCatalogCell({ session, sticker, onDelete }: {
  session: ConnectionSession;
  sticker: Sticker;
  onDelete(sticker: Sticker): void;
}): React.JSX.Element {
  const imageUrl = useAttachmentImage(
    session,
    sticker.url !== null ? { key: sticker.key, url: sticker.url } : null,
  );
  return (
    <div className="sticker-catalog-cell">
      {imageUrl !== null
        ? <img src={imageUrl} alt={sticker.name} draggable={false} />
        : <span className="sticker-catalog-fallback">{sticker.name.slice(0, 2)}</span>}
      <span className="sticker-catalog-name" title={`:${sticker.name}:`}>:{sticker.name}:</span>
      <button className="icon-button sticker-catalog-remove" title="Delete sticker" onClick={() => onDelete(sticker)}>
        <span className="icon mdi-close" />
      </button>
    </div>
  );
}

/** The Stickers section (phase 2): a "New pack" form on top, then one block per
 *  pack — header (name, count, Upload sticker, delete) and the sticker grid. One
 *  upload flow lives at a time (the active pack owns it). Management rides
 *  MANAGE_EMOJIS — one gate for the whole expressions catalog (user decision). */
function ServerStickerSection({ session }: { session: ConnectionSession }): React.JSX.Element {
  const stickerState = useStore(session.stickerStore, (state) => state);
  const [packNameDraft, setPackNameDraft] = useState("");
  const [packBusy, setPackBusy] = useState(false);
  const [uploadPackId, setUploadPackId] = useState<number | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteStickerTarget, setDeleteStickerTarget] = useState<Sticker | null>(null);
  const [deletePackTarget, setDeletePackTarget] = useState<StickerPack | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const { exchangeBusy, exchangeStatus, exchangeReport, previewArchive, runExport, openImportPreview, confirmImport, closePreview } =
    useExpressionExchange(session, setError);

  const uploadPack = stickerState.packs.find((pack) => pack.id === uploadPackId) ?? null;

  const resetPending = (): void => {
    setUploadPackId(null);
    setPendingFile(null);
    setPendingKey(null);
    setNameDraft("");
    setError(null);
  };

  const nameTakenInPack = (name: string): boolean =>
    uploadPack !== null && uploadPack.stickers.some((sticker) => sticker.name === name);

  // The client-side validation ladder BEFORE any network work (the emoji section's
  // ladder; the dimension warn threshold is 512 — stickers render at 160px).
  const pickFile = (file: File | null): void => {
    if (file === null || uploadPack === null) {
      return;
    }
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".png") && !lower.endsWith(".gif") && !lower.endsWith(".webp")) {
      setError("Pick a PNG, GIF or WebP image.");
      return;
    }
    if (file.size > 1024 * 1024) {
      setError("The file is larger than 1 MB.");
      return;
    }
    void measureImageSize(file).then((size) => {
      if (size !== null && (size.width > 512 || size.height > 512)) {
        log.warn("settings", `sticker ${file.name} is ${size.width}x${size.height} — larger than 512px, it will render downscaled`);
      }
    });
    const suggested = emojiNameFromFileName(file.name);
    if (nameTakenInPack(suggested)) {
      setError(`The name ":${suggested}:" is already taken in this pack — pick another.`);
    }
    setPendingFile(file);
    setNameDraft(suggested);
    setPendingKey(null);
  };

  const uploadPending = async (): Promise<void> => {
    if (pendingFile === null || uploadPack === null) {
      return;
    }
    const name = nameDraft.trim();
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
      setError("The name must be 1-32 chars of a-z, 0-9, _ and -.");
      return;
    }
    if (nameTakenInPack(name)) {
      setError(`The name ":${name}:" is already taken in this pack.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let key = pendingKey;
      if (key === null) {
        const slot = await session.rest.requestStickerUploadSlot(sanitizeSlotFileName(pendingFile.name));
        await session.rest.uploadBytes(slot.uploadUrl, await pendingFile.arrayBuffer(), pendingFile.type || "image/png");
        key = slot.key;
        setPendingKey(key); // a name conflict retries ONLY the create step
      }
      await session.rest.createSticker({ name, packId: uploadPack.id, fileKey: key });
      session.refreshStickers();
      resetPending();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setBusy(false);
    }
  };

  const createPack = async (): Promise<void> => {
    const name = packNameDraft.trim();
    if (name.length === 0 || packBusy) {
      return;
    }
    setPackBusy(true);
    setError(null);
    try {
      await session.rest.createStickerPack(name);
      setPackNameDraft("");
      session.refreshStickers();
    } catch (packError) {
      setError(packError instanceof Error ? packError.message : String(packError));
    } finally {
      setPackBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="roles-list-header overview-heading"><span>Stickers</span></div>
      <div className="sticker-pack-form">
        <input
          type="text"
          value={packNameDraft}
          maxLength={32}
          placeholder="New pack name"
          disabled={!stickerState.supported}
          onChange={(event) => setPackNameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !packBusy) {
              event.preventDefault();
              void createPack();
            }
          }}
        />
        <button className="primary" disabled={packBusy || exchangeBusy || !stickerState.supported || packNameDraft.trim().length === 0}
          onClick={() => void createPack()}>Create pack</button>
        <button
          disabled={packBusy || exchangeBusy || !stickerState.supported || stickerState.packs.length === 0}
          onClick={() => void runExport({ kind: "stickers" })}
        >Export all</button>
        <button
          disabled={packBusy || exchangeBusy || !stickerState.supported}
          onClick={() => zipInputRef.current?.click()}
        >Import</button>
        <span className="emoji-count">{stickerState.totalStickers} / 200 stickers · {stickerState.packs.length} / 20 packs</span>
      </div>
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          void openImportPreview(event.target.files?.[0] ?? null);
          event.target.value = "";
        }}
      />
      <div className="settings-hint">PNG, GIF or WebP · up to 1 MB · larger than 512×512 renders downscaled</div>
      <div className="exchange-status">{exchangeStatus ?? ""}</div>
      {exchangeReport !== null ? <div className="exchange-report">{exchangeReport}</div> : null}
      <div className="error-line">{error ?? ""}</div>
      {stickerState.packs.length === 0 ? (
        <div className="sticker-empty">No sticker packs yet — create one to start uploading stickers.</div>
      ) : (
        stickerState.packs.map((pack) => (
          <div key={pack.id} className="sticker-pack-block">
            <div className="sticker-pack-header">
              <span className="sticker-pack-header-name" title={pack.name}>{pack.name}</span>
              <span className="sticker-pack-header-count">{pack.stickers.length} sticker{pack.stickers.length === 1 ? "" : "s"}</span>
              <button
                disabled={busy || exchangeBusy || !stickerState.supported}
                onClick={() => {
                  resetPending();
                  setUploadPackId(pack.id);
                  window.requestAnimationFrame(() => fileInputRef.current?.click());
                }}
              >Upload sticker</button>
              <button
                disabled={exchangeBusy || busy || !stickerState.supported || pack.stickers.length === 0}
                onClick={() => void runExport({ kind: "pack", pack })}
              >Export</button>
              <button
                className="ghost"
                disabled={packBusy}
                title="Delete pack"
                onClick={() => setDeletePackTarget(pack)}
              ><span className="icon mdi-trash-can" /></button>
            </div>
            {uploadPackId === pack.id && pendingFile !== null ? (
              <div className="emoji-upload-form">
                <span className="emoji-upload-file" title={pendingFile.name}>{pendingFile.name}</span>
                <div className="emoji-upload-form-row">
                  <input
                    type="text"
                    value={nameDraft}
                    maxLength={32}
                    placeholder="name"
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !busy) {
                        event.preventDefault();
                        void uploadPending();
                      }
                    }}
                  />
                  <button className="primary" disabled={busy} onClick={() => void uploadPending()}>Save</button>
                  <button className="ghost" disabled={busy} onClick={resetPending}>Cancel</button>
                </div>
              </div>
            ) : null}
            {pack.stickers.length === 0 ? (
              <div className="sticker-empty">No stickers in this pack yet.</div>
            ) : (
              <div className="sticker-grid">
                {pack.stickers.map((sticker) => (
                  <StickerCatalogCell key={sticker.id} session={session} sticker={sticker} onDelete={setDeleteStickerTarget} />
                ))}
              </div>
            )}
          </div>
        ))
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/gif,image/webp"
        hidden
        onChange={(event) => {
          pickFile(event.target.files?.[0] ?? null);
          event.target.value = ""; // let the same file be re-picked after a fix
        }}
      />
      {deleteStickerTarget !== null ? (
        <ConfirmModal
          title="Delete sticker"
          note={`Delete :${deleteStickerTarget.name}:? Messages using this sticker will show a placeholder.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await session.rest.deleteSticker(deleteStickerTarget.id);
            session.refreshStickers();
          }}
          onClose={() => setDeleteStickerTarget(null)}
        />
      ) : null}
      {deletePackTarget !== null ? (
        <ConfirmModal
          title="Delete sticker pack"
          note={`Delete pack "${deletePackTarget.name}"? All ${deletePackTarget.stickers.length} sticker${deletePackTarget.stickers.length === 1 ? "" : "s"} in it are removed and messages using them will show a placeholder.`}
          confirmLabel="Delete pack"
          onConfirm={async () => {
            await session.rest.deleteStickerPack(deletePackTarget.id);
            session.refreshStickers();
          }}
          onClose={() => setDeletePackTarget(null)}
        />
      ) : null}
      {previewArchive !== null ? (
        <ImportPreviewModal
          session={session}
          archive={previewArchive}
          onConfirm={(filtered) => void confirmImport(filtered)}
          onClose={closePreview}
        />
      ) : null}
    </div>
  );
}

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

/** The health block's auto-refresh cadence while the Server tab is open. */
const HEALTH_REFRESH_MILLIS = 30_000;

/** One backing-service row: a presence dot (green/red/grey) + name + one detail
 *  line combining both facets, e.g. "up · 3 ms · running · healthy". */
function HealthRow({ entry }: { entry: ServerHealthEntry }): React.JSX.Element {
  const dotClass = entry.service.status === "UP" ? " online"
    : entry.service.status === "DISABLED" ? ""
    : " down";
  return (
    <div className="health-row">
      <span className={"presence-dot" + dotClass} />
      <span className="health-row-name">{entry.name}</span>
      <span className="health-row-detail" title={describeHealthEntry(entry)}>{describeHealthEntry(entry)}</span>
    </div>
  );
}

function describeHealthEntry(entry: ServerHealthEntry): string {
  const parts: string[] = [];
  if (entry.service.status === "UP") {
    parts.push("up" + (entry.service.latencyMillis != null ? ` · ${entry.service.latencyMillis} ms` : ""));
  } else if (entry.service.status === "DISABLED") {
    parts.push("disabled by configuration");
  } else {
    // DOWN / TIMEOUT — the detail carries the reason (red dot row)
    parts.push(entry.service.status.toLowerCase() + (entry.service.detail != null ? ` — ${entry.service.detail}` : ""));
  }
  // The container facet is null on deployments that cannot answer it (provisioned
  // servers run oak inside a container, without the host's docker socket) — the
  // row then shows the service probe alone, no placeholder text.
  const container = entry.container;
  if (container != null) {
    if (container.status === "UNKNOWN" || container.status === "ABSENT") {
      parts.push(container.detail ?? container.status.toLowerCase());
    } else {
      parts.push(container.status.toLowerCase()
        + (container.health != null && container.health !== "NONE" ? ` · ${container.health.toLowerCase()}` : ""));
    }
  }
  return parts.join(" · ");
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
  // The logs download pair (logging round, 2026-10-06) — its OWN busy/status so a
  // logs failure never reads as a storage-policy failure.
  const [logsBusy, setLogsBusy] = useState(false);
  const [logsStatus, setLogsStatus] = useState<string | null>(null);
  // Service health (healthcheck round, 2026-10-07) — its own states too: a dead
  // janus must not look like a storage-policy error, and vice versa.
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  /** 404 from a pre-healthcheck server build: report once, stop polling. */
  const [healthUnsupported, setHealthUnsupported] = useState(false);

  const refreshHealth = (): void => {
    void session.rest.fetchServerHealth()
      .then((next) => {
        setHealth(next);
        setHealthError(null);
      })
      .catch((healthFailure: unknown) => {
        if (healthFailure instanceof ApiError && healthFailure.status === 404) {
          setHealthUnsupported(true);
        } else {
          setHealthError(healthFailure instanceof Error ? healthFailure.message : String(healthFailure));
        }
      });
  };

  useEffect(refreshHealth, [session]);

  // Live while the tab is open: one refresh every 30 s (a stopped janus must
  // flip the row red — and back — without the admin pressing anything).
  useEffect(() => {
    if (healthUnsupported) {
      return;
    }
    const timer = window.setInterval(refreshHealth, HEALTH_REFRESH_MILLIS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshHealth is a stable shape over setHealth/session only
  }, [healthUnsupported, session]);

  const downloadServerArchive = async (): Promise<void> => {
    if (logsBusy) {
      return;
    }
    setLogsBusy(true);
    setLogsStatus("Downloading…");
    try {
      const archive = await session.rest.downloadServerLogs();
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      // A dismissed dialog is not an error (the expression-export contract).
      const savedPath = await window.spaceMedia?.saveFile(`server-logs-${stamp}.zip`, archive);
      setLogsStatus(savedPath == null ? null : "Saved.");
    } catch (downloadError: unknown) {
      setLogsStatus(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally {
      setLogsBusy(false);
    }
  };

  const downloadClientArchive = async (): Promise<void> => {
    if (logsBusy) {
      return;
    }
    setLogsBusy(true);
    setLogsStatus("Preparing…");
    const outcome = await downloadClientLogs();
    setLogsStatus(outcome === "saved" ? "Saved." : "Export failed — see the log.");
    setLogsBusy(false);
  };

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
      {/* The nav tab is "Server" — the pane heading must repeat it (user report
          2026-10-07): "Storage" named only the first of the tab's blocks. */}
      <div className="roles-list-header overview-heading"><span>Server</span></div>

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

      {/* Service health (healthcheck round): the server probes its own integrations
          (is postgres/minio/janus/turn actually usable from there) and reports the
          docker container state — "running but janus does not answer" is the case
          this block exists for. */}
      <h3 style={{ marginTop: 20 }}>Service health</h3>
      <div className="settings-hint">
        The backing services this server depends on: the probe says whether the server can
        actually use the service, the second part is its docker container state. Refreshes
        every {HEALTH_REFRESH_MILLIS / 1000} seconds.
      </div>
      {health !== null ? (
        <>
          {health.services.map((entry) => <HealthRow key={entry.name} entry={entry} />)}
          <div className="settings-hint">Checked at {new Date(health.checkedAt).toLocaleTimeString()}</div>
        </>
      ) : null}
      {healthUnsupported ? (
        <div className="settings-hint">This server build does not report service health.</div>
      ) : null}
      {healthError !== null ? (
        <div className="settings-warning">{healthError} — retrying every {HEALTH_REFRESH_MILLIS / 1000} seconds.</div>
      ) : null}

      {/* Breathing room from the cleanup row above (user report 2026-10-07: too
          close, then 28px was too far — settled in between). */}
      <h3 style={{ marginTop: 20 }}>Logs</h3>
      <div className="settings-hint">
        The server log of the last 24 hours in one zip — the container logs of postgres, minio,
        janus and coturn are included when Docker is available. "Download client logs" saves this
        client's own log file; both help investigate a problem report.
      </div>
      <div className="modal-actions left">
        <button disabled={logsBusy} onClick={() => void downloadServerArchive()}>Download server logs</button>
        <button disabled={logsBusy} onClick={() => void downloadClientArchive()}>Download client logs</button>
        <span className="settings-status">{logsStatus ?? ""}</span>
      </div>
    </div>
  );
}
