import { useState } from "react";
import { useStore } from "../hooks/useStore";
import type { ConnectionSession } from "../../domain/session/connection-session";
import { isOutgoingPending, transferCandidates } from "../../domain/logic/ownership-transfer";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";

/** The dialog's stage machine (user decision, smoke round): cancelling a live offer
 *  and transferring are FIRST-CLASS separate steps — re-offering to someone else
 *  walks through the cancel confirmation, then lands on the transfer confirmation
 *  for the new member. */
type Stage =
  | { kind: "cancel"; thenTransferTo: number | null }
  | { kind: "confirm"; targetUserId: number }
  | { kind: "picker" };

/**
 * The owner's ownership-transfer flow (Server Settings → Members → the member's
 * "Transfer ownership" button). Opened with a preselected member, it lands straight
 * on that member's confirmation — or, when a live outgoing offer exists, on the
 * CANCEL confirmation first (a plain re-offer to the same member cancels nothing new;
 * an offer to a DIFFERENT member cancels the old one and continues to the new
 * member's confirmation — the two-dialog cascade the user asked for).
 */
export function TransferOwnershipModal({ session, preselectedUserId, onClose }: {
  session: ConnectionSession;
  /** The member row the flow was opened from — jump straight to the confirm step. */
  preselectedUserId?: number | null;
  onClose: () => void;
}): React.JSX.Element {
  const members = useStore(session.memberStore, (state) => state.members);
  const pending = useStore(session.ownershipStore, (state) => state.pending);
  const selfUserId = session.selfUserId();
  const outgoing = isOutgoingPending(pending, selfUserId ?? -1) ? pending : null;
  const [stage, setStage] = useState<Stage>(() => {
    if (preselectedUserId !== undefined && preselectedUserId !== null) {
      if (outgoing !== null) {
        return { kind: "cancel", thenTransferTo: outgoing.toUserId === preselectedUserId ? null : preselectedUserId };
      }
      return { kind: "confirm", targetUserId: preselectedUserId };
    }
    return { kind: "picker" };
  });
  const [picked, setPicked] = useState<number | null>(preselectedUserId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offer = async (targetUserId: number): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.offerOwnershipTransfer(targetUserId);
      onClose();
    } catch (offerError) {
      setError(offerError instanceof Error ? offerError.message : String(offerError));
      setBusy(false);
    }
  };

  const cancelThenContinue = async (): Promise<void> => {
    if (busy || outgoing === null || stage.kind !== "cancel") {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.cancelOwnershipTransfer(outgoing.id);
      if (stage.thenTransferTo !== null) {
        setPicked(stage.thenTransferTo);
        setStage({ kind: "confirm", targetUserId: stage.thenTransferTo });
        setBusy(false); // the second dialog of the cascade stays interactive
      } else {
        onClose();
      }
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
      setBusy(false);
    }
  };

  const nameOf = (userId: number): string =>
    members.find((member) => member.userId === userId)?.nickname ?? "#unknown";

  return (
    <Modal title="Transfer ownership" onClose={onClose} elevated>
      {stage.kind === "cancel" && outgoing !== null ? (
        <>
          <div className="modal-note">
            {stage.thenTransferTo !== null
              ? `You already have a pending transfer to ${nameOf(outgoing.toUserId)}. Cancel it first?`
              : `Cancel the pending ownership transfer to ${nameOf(outgoing.toUserId)}?`}
          </div>
          <div className="error-line">{error ?? ""}</div>
          <div className="modal-actions left">
            {/* The refusal differs by context: mid-cascade it KEEPS the live offer
                (nothing is cancelled, nothing new goes out); on a plain cancel dialog
                it just closes. */}
            <button className="ghost" disabled={busy} onClick={onClose}>
              {stage.thenTransferTo !== null ? "Keep current transfer" : "Close"}
            </button>
            <button className="danger" disabled={busy} onClick={() => void cancelThenContinue()}>
              {stage.thenTransferTo !== null ? "Cancel & continue" : "Cancel transfer"}
            </button>
          </div>
        </>
      ) : stage.kind === "confirm" ? (
        <>
          <div className="modal-note">
            {`Transfer the ownership of this server to ${nameOf(stage.targetUserId)}?`}
          </div>
          <div className="modal-note ownership-warning">
            You will lose the owner role. Only the new owner can transfer it back.
          </div>
          <div className="error-line">{error ?? ""}</div>
          <div className="modal-actions left">
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => void offer(stage.targetUserId)}>Transfer</button>
          </div>
        </>
      ) : (
        <>
          <div className="modal-note">
            Pick the member who will receive the ownership offer.
          </div>
          <div className="friend-picker-list">
            {transferCandidates(members, selfUserId ?? -1).length === 0 ? (
              <div className="settings-empty">No other members.</div>
            ) : transferCandidates(members, selfUserId ?? -1).map((member) => (
              <div
                key={member.userId}
                className={"friend-picker-row" + (picked === member.userId ? " chosen" : "")}
                onClick={() => setPicked(member.userId)}
              >
                <Avatar session={session} username={member.username} size={24} />
                <span>{member.nickname}</span>
              </div>
            ))}
          </div>
          <div className="error-line">{error ?? ""}</div>
          <div className="modal-actions left">
            <button className="ghost" onClick={onClose}>Close</button>
            <button className="primary" disabled={picked === null} onClick={() => {
              if (picked !== null) {
                setStage({ kind: "confirm", targetUserId: picked });
              }
            }}>
              Continue
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
