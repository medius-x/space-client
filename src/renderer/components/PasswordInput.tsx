import { useState } from "react";

/**
 * A password field with a visibility toggle (the eye button inside the right
 * edge — user request 2026-10-12): every password input in the app renders
 * through this one component. Local, per-field state — toggling one field
 * never reveals another.
 */
export function PasswordInput({ value, onChange, placeholder, autoComplete, onEnter, autoFocus }: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  autoComplete?: string;
  onEnter?(): void;
  autoFocus?: boolean;
}): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onEnter !== undefined) {
            onEnter();
          }
        }}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        className="password-toggle"
        title={visible ? "Hide password" : "Show password"}
        aria-label={visible ? "Hide password" : "Show password"}
        onClick={() => setVisible((previous) => !previous)}
      >
        <span className={"icon " + (visible ? "mdi-eye-off" : "mdi-eye")} />
      </button>
    </div>
  );
}
