import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../hooks/useT";
import { currentLang } from "../../domain/i18n/i18n";
import { formatPollRemaining } from "../../domain/logic/poll-time";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Message, PollInfo, PollOptionResult, PollResults } from "../../types";
import { Avatar } from "./Avatar";

/**
 * The "end poll" glyph (2026-11-25): mdi-poll's bars cut by the deafen strike's
 * EXACT constants (measured off mdi-headphones-off's path): the strike
 * parallelogram verbatim (2.78,3.5 → 20.5,21.22 → 19.23,22.5 → 1.5,4.77, edges
 * y = x + 0.72 / y = x + 3.27, thickness 1.8), the bars ABOVE it trimmed to
 * y = x − 1.83 (the gap EQUALS the strike's thickness) and the bars BELOW it
 * butting the lower edge flush (zero gap) — the measured -off asymmetry.
 */
function PollOffGlyph(): React.JSX.Element {
  return (
    <svg className="poll-off-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3,8H4.73L7,10.27V22H3M10,2H14V12.17L10,8.17M10,13.27L14,17.27V22H10M17,14H21V19.17L17,15.17M17,20.27L18.73,22H17M2.78,3.5L20.5,21.22L19.23,22.5L1.5,4.77Z" />
    </svg>
  );
}

/**
 * The poll card (2026-11-25) — the reference layout: the bold question, the smaller
 * one-or-many subtitle, the option rows, and the footer with the voter count + time
 * left on the left and the action buttons on the right. Results stay hidden until a
 * button is pressed (the user's card design); viewing never closes the ability to
 * vote; a closed poll flips everyone to the final results on its own. The revealed
 * results live on the MESSAGE (client-only store field), so a channel switch keeps
 * the card in its results view, and the .poll live push refreshes them once revealed
 * (fix round 2: votes by OTHERS now repaint an open results view too).
 */
export function PollCard({ session, message, poll, canVote }: {
  session: ConnectionSession;
  message: Message;
  poll: PollInfo;
  canVote: boolean;
}): React.JSX.Element {
  const t = useT();
  const [view, setView] = useState<"vote" | "results">(
    message.pollResults !== undefined || message.myPollOptionIds?.length || poll.closedAt !== null
      ? "results"
      : "vote");
  // The my-votes snapshot arrives AFTER the cards have mounted (history loads
  // first, the seed effect's answer lands later) — a card stuck in the vote view
  // must flip to its results the moment it learns "I already voted (fix round 5).
  // EDGE-triggered on purpose: only the false→true transition flips, so the
  // user's explicit "back to voting" (votedKnown stays true) is not fought back
  // (fix round 6: the level-triggered flip made the card blink and snap shut).
  const votedKnown = (message.myPollOptionIds?.length ?? 0) > 0;
  const prevVotedKnownRef = useRef(votedKnown);
  useEffect(() => {
    if (votedKnown && !prevVotedKnownRef.current && view === "vote") {
      setView("results");
    }
    prevVotedKnownRef.current = votedKnown;
  }, [view, votedKnown]);
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [votersOpenFor, setVotersOpenFor] = useState<number | null>(null);

  const closed = message.poll?.closedAt !== null;
  const results = message.pollResults ?? null;
  const totalVoters = results?.totalVoters ?? message.pollTotalVoters ?? 0;
  const canClose = !closed
    && (message.authorUsername === session.username() || session.permissionStore.can("MANAGE_MESSAGES"));

  // Results are fetched when they are NEEDED for painting: a card whose results
  // were already revealed (its own vote / "show results") follows the LIVE
  // headline — every .poll push (someone voted, the poll closed) re-tallies it —
  // a CLOSED poll loads its final tallies for everyone, and a card that just
  // LEARNED "I already voted" (the late my-votes seed) fetches them too — the
  // restart case: client-side reveal state is gone, the numbers must still paint.
  // The headline KEY guard kills the refetch loop — the store write replaces the
  // message object, so raw deps alone would re-fire the effect on its own write.
  const lastHeadlineRef = useRef<string | null>(null);
  useEffect(() => {
    if (message.poll === null) {
      return;
    }
    const revealed = message.pollResults !== undefined;
    const closedNow = message.poll.closedAt !== null;
    if (!revealed && !closedNow && !votedKnown) {
      return;
    }
    const headline = `${message.poll.id}:${message.pollTotalVoters ?? 0}:${message.poll.closedAt ?? ""}`;
    if (lastHeadlineRef.current === headline) {
      return;
    }
    lastHeadlineRef.current = headline;
    session.getPollResults(message.poll.id)
      .then((fetched) => session.messageStore.applyPollResults(message.channelId, message.id, fetched))
      .catch(() => undefined); // a transport hiccup keeps the last known tallies
  }, [message, session, votedKnown]);

  const reveal = (fetched: PollResults): void => {
    session.messageStore.applyPollResults(message.channelId, message.id, fetched);
    setView("results");
  };

  const showResults = (): void => {
    if (results !== null) {
      setView("results");
      return;
    }
    setBusy(true);
    session.getPollResults(poll.id)
      .then(reveal)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const vote = (): void => {
    if (selection.size === 0) {
      return;
    }
    const chosen = [...selection];
    setBusy(true);
    session.votePoll(poll.id, chosen)
      .then((tallied) => {
        session.messageStore.applyMyPollVote(message.channelId, message.id, chosen);
        reveal(tallied);
      })
      .catch(() => {
        // A 409 means the vote was REJECTED (final vote, or the poll closed
        // between views) — the choice did NOT land, so nothing stamps it as
        // mine; the honest answer is the tallied state, fetched fresh.
        session.getPollResults(poll.id)
          .then(reveal)
          .catch(() => undefined);
      })
      .finally(() => setBusy(false));
  };

  const backToVote = (): void => {
    // Re-seed the selection with the CURRENT vote (when known): a re-vote
    // replaces the WHOLE set, so starting it from a blank slate invites an
    // accidental partial replacement.
    if (message.myPollOptionIds !== undefined && message.myPollOptionIds.length > 0) {
      setSelection(new Set(message.myPollOptionIds));
    }
    setView("vote");
  };

  const endPoll = (): void => {
    setBusy(true);
    session.closePoll(poll.id)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const toggleOption = (optionId: number): void => {
    setSelection((previous) => {
      const next = new Set(previous);
      if (poll.allowMultiple) {
        if (next.has(optionId)) {
          next.delete(optionId);
        } else {
          next.add(optionId);
        }
      } else {
        next.clear();
        next.add(optionId);
      }
      return next;
    });
  };

  const timeLeft = poll.endsAt !== null && !closed
    ? t("poll.timeLeft", { time: formatPollRemaining(poll.endsAt, Date.now(), currentLang()) })
    : "";

  // The "time left" label must TICK, not freeze: re-render every 30 s while a
  // deadline is live (the sweep's closed push ends the ticking).
  const [, setTimeTick] = useState(0);
  useEffect(() => {
    if (poll.endsAt === null || closed) {
      return;
    }
    const timer = window.setInterval(() => setTimeTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [poll.endsAt, closed]);

  const canGoBackToVote = canVote && !closed && (poll.allowVoteChange || !votedKnown);

  return (
    <div className="poll-card">
      {canClose ? (
        <button type="button" className="poll-end-button" title={t("poll.closePoll")}
          disabled={busy} onClick={endPoll}>
          <PollOffGlyph />
        </button>
      ) : null}
      <div className="poll-question">{poll.question}</div>
      <div className="poll-subtitle">
        {poll.allowMultiple ? t("poll.selectMany") : t("poll.selectOne")}
        {poll.anonymous ? <span> · {t("poll.anonymous")}</span> : null}
      </div>

      {view === "results" || closed ? (
        <PollResultsView poll={message.poll ?? poll} results={results} votersOpenFor={votersOpenFor}
          setVotersOpenFor={setVotersOpenFor} session={session} />
      ) : (
          <div className="poll-options">
            {poll.options.map((option) => {
              const selected = selection.has(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  className={"poll-option" + (selected ? " selected" : "")}
                  onClick={() => toggleOption(option.id)}
                >
                  <span className={"poll-option-mark " + (poll.allowMultiple ? "check" : "radio")}
                    aria-hidden="true" />
                  <span className="poll-option-text">{option.text}</span>
                </button>
              );
            })}
          </div>
        )}

      <div className="poll-footer">
        <span className="poll-meta">
          {t("poll.votes", { count: totalVoters })}
          {timeLeft.length > 0 ? <span className="poll-time-left"> {timeLeft}</span> : null}
          {closed ? <span className="poll-finished"> · {t("poll.finished")}</span> : null}
        </span>
        <span className="poll-actions">
          {!closed && view === "vote" ? (
            <>
              <button type="button" className="poll-footer-button ghost" disabled={busy} onClick={showResults}>
                {t("poll.showResults")}
              </button>
              {canVote ? (
                <button type="button" className="poll-footer-button primary" disabled={busy || selection.size === 0}
                  onClick={vote}>
                  {t("poll.vote")}
                </button>
              ) : null}
            </>
          ) : null}
          {canGoBackToVote && view === "results" ? (
            <button type="button" className="poll-footer-button ghost" disabled={busy}
              onClick={backToVote}>
              {t("poll.backToVote")}
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** The results view (fix round 2, user design): the option's flat line — name on
 *  the left, percent on the right — with a THIN blurple progress bar underneath
 *  (no more grey-on-grey plate fill). Under each line, for non-anonymous polls,
 *  the overlapping mini-avatar strip with its capped dropdown. */
function PollResultsView({ poll, results, votersOpenFor, setVotersOpenFor, session }: {
  poll: PollInfo;
  results: PollResults | null;
  votersOpenFor: number | null;
  setVotersOpenFor: (optionId: number | null) => void;
  session: ConnectionSession;
}): React.JSX.Element {
  const t = useT();
  const byOption = useMemo(() => {
    const map = new Map<number, PollOptionResult>();
    if (results !== null) {
      for (const row of results.options) {
        map.set(row.optionId, row);
      }
    }
    return map;
  }, [results]);
  const totalVotes = results === null
    ? 0
    : results.options.reduce((sum, row) => sum + row.votes, 0);

  return (
    <div className="poll-options poll-results">
      {poll.options.map((option) => {
        const row = byOption.get(option.id);
        const votes = row?.votes ?? 0;
        const percent = totalVotes === 0 ? 0 : Math.round((votes / totalVotes) * 100);
        const voters = row?.voters ?? [];
        return (
          <div key={option.id} className="poll-result-row">
            <div className="poll-result-line">
              <span className="poll-option-text">{option.text}</span>
              <span className="poll-option-percent">{t("poll.totalVotesPercent", { percent })}</span>
            </div>
            <div className="poll-result-bar" role="presentation">
              <div className="poll-result-bar-fill" style={{ width: `${percent}%` }} />
            </div>
            {!poll.anonymous && voters.length > 0 ? (
              <div className="poll-voters">
                <button type="button" className="poll-voters-strip" title=""
                  onClick={(event) => {
                    event.stopPropagation();
                    setVotersOpenFor(votersOpenFor === option.id ? null : option.id);
                  }}>
                  {voters.slice(0, 5).map((username) => (
                    <span key={username} className="poll-voters-chip">
                      <Avatar session={session} username={username} size={20} />
                    </span>
                  ))}
                  {voters.length > 5 ? <span className="poll-voters-more">+{voters.length - 5}</span> : null}
                </button>
                {votersOpenFor === option.id ? (
                  <div className="poll-voters-dropdown">
                    {voters.map((username) => (
                      <div key={username} className="poll-voters-dropdown-row">
                        <Avatar session={session} username={username} size={22} />
                        <span className="poll-voters-dropdown-name">{username}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
