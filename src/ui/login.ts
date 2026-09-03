import { el, clear } from "./dom";
import { DEFAULT_REST_BASE_URL } from "../config";

export interface LoginActions {
  login(baseUrl: string, username: string, password: string): void;
  register(baseUrl: string, username: string, password: string): void;
}

export interface LoginView {
  setBusy(busy: boolean): void;
  setError(message: string | null): void;
}

/**
 * The login screen: server base URL + credentials, Discord-"Add server" style.
 * The URL field is prefilled with the local dev fixture; everything else derives from it.
 */
export function renderLoginScreen(container: HTMLElement, actions: LoginActions): LoginView {
  clear(container);
  let busy = false;
  let errorMessage: string | null = null;

  const container_ = el("div", { class: "login-screen" });
  const card = el("div", { class: "login-card" });
  const urlInput = el("input", { type: "url", value: DEFAULT_REST_BASE_URL, placeholder: "http://localhost:8080" }) as HTMLInputElement;
  urlInput.value = DEFAULT_REST_BASE_URL;
  const userInput = el("input", { type: "text", placeholder: "Username", autocomplete: "username" }) as HTMLInputElement;
  const passwordInput = el("input", { type: "password", placeholder: "Password (8+ chars)", autocomplete: "current-password" }) as HTMLInputElement;
  const errorLine = el("div", { class: "error-line" });
  const loginButton = el("button", { class: "primary" }, "Log in");
  const registerButton = el("button", { class: "ghost" }, "Register");

  function submit(mode: "login" | "register"): void {
    if (busy) {
      return;
    }
    errorMessage = null;
    refresh();
    if (mode === "login") {
      actions.login(urlInput.value.trim().replace(/\/+$/, ""), userInput.value.trim(), passwordInput.value);
    } else {
      actions.register(urlInput.value.trim().replace(/\/+$/, ""), userInput.value.trim(), passwordInput.value);
    }
  }

  loginButton.addEventListener("click", () => submit("login"));
  registerButton.addEventListener("click", () => submit("register"));
  passwordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      submit("login");
    }
  });

  function refresh(): void {
    loginButton.disabled = busy;
    registerButton.disabled = busy;
    loginButton.textContent = busy ? "Connecting…" : "Log in";
    errorLine.textContent = errorMessage ?? "";
  }

  card.append(
    el("div", { class: "login-title" }, "space"),
    el("div", { class: "error-line" }, "Spike client — voice, stereo share, per-user volume"),
    urlInput,
    userInput,
    passwordInput,
    errorLine,
    loginButton,
    registerButton,
  );
  container_.append(card);
  container.append(container_);

  return {
    setBusy(next: boolean): void {
      busy = next;
      refresh();
    },
    setError(message: string | null): void {
      errorMessage = message;
      busy = false;
      refresh();
    },
  };
}
