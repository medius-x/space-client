import { useEffect, useMemo, useState } from "react";
import { useT } from "../hooks/useT";
import { currentLang } from "../../domain/i18n/i18n";
import { formatPollRemaining } from "../../domain/logic/poll-time";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { Message, PollInfo, PollOptionResult, PollResults } from "../../types";
import { Avatar } from "./Avatar";

/** The poll card's voter-list dropdown cap (user decision 2026-11-25): five rows
 *  visible, the rest behind the list's own scroll. */
const VOTERS_DROPDOWN_CAP = 5;

/**
 * The poll card (2026-11-25) — the reference layout: the bold question, the smaller
 * one-or-many subtitle, the option rows, and the footer with the voter count + time
 * left on the left and the action buttons on the right. Results stay hidden until a
 * button is pressed (the user's card design); viewing never closes the ability to
 * vote; a closed poll flips everyone to the final results on its own.
 */
export function PollCard({ session, message, poll, canVote }: {
  session: ConnectionSession;
  message: Message;
  poll: PollInfo;
  canVote: boolean;
}): React.JSX.Element {
  const t = useT();
  const [results, setResults] = useState<PollResults | null>(null);
  const [view, setView] = useState<"vote" | "results">(poll.closedAt !== null ? "results" : "vote");
  const [selection, setSelection] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [votersOpenFor, setVotersOpenFor] = useState<number | null>(null);

  const closed = (results?.poll.closedAt ?? poll.closedAt) !== null;
  const totalVoters = results?.totalVoters ?? message.pollTotalVoters ?? 0;
  const canClose = !closed
    && (message.authorUsername === session.username() || session.permissionStore.can("MANAGE_MESSAGES"));

  // A finished poll shows its final results to everyone (the closed push flips
  // the card; the tallies arrive by this fetch, never by the live topic).
  useEffect(() => {
    if (poll.closedAt !== null && results === null) {
      session.getPollResults(poll.id)
        .then((fetched) => setResults(fetched))
        .catch(() => undefined); // the card stays on its last known state
    }
  }, [poll.closedAt, poll.id, results, session]);

  const showResults = (): void => {
    if (results !== null) {
      setView("results");
      return;
    }
    setBusy(true);
    session.getPollResults(poll.id)
      .then((fetched) => {
        setResults(fetched);
        setView("results");
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const vote = (): void => {
    if (selection.size === 0) {
      return;
    }
    setBusy(true);
    session.votePoll(poll.id, [...selection])
      .then((tallied) => {
        setResults(tallied);
        setView("results");
      })
      .catch(() => {
        // A 409 means the vote is final (or the poll closed between views) —
        // the honest answer is the tallied state, same as Discord's flow.
        session.getPollResults(poll.id)
          .then((fetched) => {
            setResults(fetched);
            setView("results");
          })
          .catch(() => undefined);
      })
      .finally(() => setBusy(false));
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

  return (
    <div className="poll-card">
      <div className="poll-question">{poll.question}</div>
      <div className="poll-subtitle">
        {poll.allowMultiple ? t("poll.selectMany") : t("poll.selectOne")}
      </div>

      {view === "results" || closed
        ? <PollResultsView poll={poll} results={results} votersOpenFor={votersOpenFor}
            setVotersOpenFor={setVotersOpenFor} session={session} />
        : (
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
              <button type="button" className="poll-link-button" disabled={busy} onClick={showResults}>
                {t("poll.showResults")}
              </button>
              {canVote ? (
                <button type="button" className="poll-primary-button" disabled={busy || selection.size === 0}
                  onClick={vote}>
                  {t("poll.vote")}
                </button>
              ) : null}
            </>
          ) : null}
          {!closed && view === "results" && canVote && poll.allowVoteChange ? (
            <button type="button" className="poll-link-button" disabled={busy} onClick={() => setView("vote")}>
              {t("poll.backToVote")}
            </button>
          ) : null}
          {canClose ? (
            <button type="button" className="poll-link-button" disabled={busy} onClick={endPoll}>
              {t("poll.closePoll")}
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** The results view: option rows with the percentage fill, and for non-anonymous
 *  polls the overlapping mini-avatar strip under each option — a click opens the
 *  capped voter dropdown (user design 2026-11-25). */
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
            <div className={"poll-option" + (votes > 0 && totalVotes > 0 && votes === totalVotes ? " leading" : "")}>
              <div className="poll-option-fill" style={{ width: `${percent}%` }} aria-hidden="true" />
              <span className="poll-option-text">{option.text}</span>
              <span className="poll-option-percent">{t("poll.totalVotesPercent", { percent })}</span>
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
