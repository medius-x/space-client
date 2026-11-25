import { useState } from "react";
import { Modal } from "./Modal";
import { useT } from "../hooks/useT";
import { currentLang } from "../../domain/i18n/i18n";
import { formatTtlWords } from "../../domain/logic/invite-link";
import type { ConnectionSession } from "../../domain/session/connection-session";
import type { UiLang } from "../../domain/i18n/i18n";

/** The dialog's input limits (user decision 2026-11-25 — the UI-stability rule):
 *  2..10 options, question ≤ 300 chars, option ≤ 100 chars. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const QUESTION_MAX = 300;
const OPTION_MAX = 100;
/** The custom duration's cap — a flat year, the invite-TTL ceiling. */
const DURATION_MAX_MINUTES = 525_600;

type PresetKey =
  | "poll.durationUnlimited"
  | "poll.durationPresetHour"
  | "poll.durationPreset6Hours"
  | "poll.durationPresetDay"
  | "poll.durationPreset3Days"
  | "poll.durationPresetWeek";

const DURATION_PRESETS: { key: PresetKey; minutes: number }[] = [
  { key: "poll.durationUnlimited", minutes: 0 },
  { key: "poll.durationPresetHour", minutes: 60 },
  { key: "poll.durationPreset6Hours", minutes: 360 },
  { key: "poll.durationPresetDay", minutes: 1440 },
  { key: "poll.durationPreset3Days", minutes: 4320 },
  { key: "poll.durationPresetWeek", minutes: 10_080 },
];

/**
 * The create-poll dialog (2026-11-25): the question, a growing option list
 * (2..10 with add/remove), the three toggles (anonymous / multiple choice /
 * changeable vote — the last one OFF by default, user decision), and the
 * duration — a preset dropdown OR the "custom" checkbox replacing it with a
 * minutes field rendered in days/hours/minutes (the invite-TTL pattern).
 */
export function PollDialog({ session, channelId, onClose }: {
  session: ConnectionSession;
  channelId: number;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [anonymous, setAnonymous] = useState(false);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [allowVoteChange, setAllowVoteChange] = useState(false);
  const [presetMinutes, setPresetMinutes] = useState(0);
  const [custom, setCustom] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("1440");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedOptions = options.map((option) => option.trim());
  const filledCount = trimmedOptions.filter((option) => option.length > 0).length;
  const customNumber = Number(customMinutes);
  const customValid = Number.isFinite(customNumber) && customNumber >= 1
    && customNumber <= DURATION_MAX_MINUTES;
  const canSubmit = question.trim().length > 0 && filledCount >= MIN_OPTIONS
    && (!custom || customValid) && !busy;

  const setOption = (index: number, value: string): void => {
    setOptions((previous) => previous.map((option, at) => (at === index ? value : option)));
  };
  const removeOption = (index: number): void => {
    setOptions((previous) => previous.filter((_, at) => at !== index));
  };
  const addOption = (): void => {
    setOptions((previous) => previous.length >= MAX_OPTIONS ? previous : [...previous, ""]);
  };

  const submit = (): void => {
    setBusy(true);
    setError(null);
    const durationMinutes = custom
      ? customNumber
      : presetMinutes === 0 ? null : presetMinutes;
    session.createPoll(channelId, {
      question: question.trim(),
      options: trimmedOptions.filter((option) => option.length > 0),
      allowMultiple,
      anonymous,
      allowVoteChange,
      durationMinutes,
    })
      .then(() => onClose())
      .catch((submitError: unknown) => {
        setError(submitError instanceof Error ? submitError.message : String(submitError));
        setBusy(false);
      });
  };

  return (
    <Modal title={t("poll.dialogTitle")} onClose={onClose} medium>
      <label className="settings-field">
        <input
          type="text"
          value={question}
          maxLength={QUESTION_MAX}
          autoFocus
          placeholder={t("poll.questionPlaceholder")}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </label>

      <div className="poll-dialog-options">
        {options.map((option, index) => (
          <div key={index} className="poll-dialog-option-row">
            <input
              type="text"
              value={option}
              maxLength={OPTION_MAX}
              placeholder={t("poll.optionPlaceholder")}
              onChange={(event) => setOption(index, event.target.value)}
            />
            {options.length > MIN_OPTIONS ? (
              <button type="button" className="poll-dialog-remove" title=""
                onClick={() => removeOption(index)}>
                <span className="icon mdi-close" />
              </button>
            ) : null}
          </div>
        ))}
        {options.length < MAX_OPTIONS ? (
          <button type="button" className="ghost poll-dialog-add" onClick={addOption}>
            <span className="icon mdi-plus" />
            {t("poll.addOption")}
          </button>
        ) : null}
      </div>

      <label className="settings-check">
        <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />
        <span>
          {t("poll.anonymous")}
          <small>{t("poll.anonymousHint")}</small>
        </span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={allowMultiple} onChange={(event) => setAllowMultiple(event.target.checked)} />
        <span>{t("poll.multiple")}</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={allowVoteChange} onChange={(event) => setAllowVoteChange(event.target.checked)} />
        <span>{t("poll.changeVote")}</span>
      </label>

      <div className="poll-dialog-duration">
        <span className="invite-ttl-label">{t("poll.durationLabel")}</span>
        <select
          value={presetMinutes}
          disabled={custom}
          onChange={(event) => setPresetMinutes(Number(event.target.value))}
        >
          {DURATION_PRESETS.map((preset) => (
            <option key={preset.key} value={preset.minutes}>{t(preset.key)}</option>
          ))}
        </select>
        <label className="settings-check poll-dialog-custom">
          <input type="checkbox" checked={custom} onChange={(event) => setCustom(event.target.checked)} />
          <span>{t("poll.durationCustom")}</span>
        </label>
        {custom ? (
          <span className="invite-ttl-input-wrap">
            <input
              type="number"
              min={1}
              max={DURATION_MAX_MINUTES}
              value={customMinutes}
              onChange={(event) => setCustomMinutes(event.target.value)}
            />
            <span className="invite-ttl-human">
              {customValid ? formatTtlWords(customNumber, currentLang() as UiLang) : ""}
            </span>
          </span>
        ) : null}
        {custom ? <span className="invite-ttl-unit">{t("poll.minutesUnit")}</span> : null}
      </div>

      {error !== null ? <div className="error-line">{error}</div> : null}
      <div className="modal-actions">
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button type="button" className="primary" disabled={!canSubmit} onClick={submit}>
          {t("poll.create")}
        </button>
      </div>
    </Modal>
  );
}
