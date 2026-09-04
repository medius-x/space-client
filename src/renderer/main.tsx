import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PopoutScreen } from "./components/PopoutScreen";
import { bootstrapApp } from "./runtime";
import "./styles/global.css";

const container = document.querySelector<HTMLElement>("#root");
if (!container) {
  throw new Error("#root not found");
}

if (window.location.hash === "#popout") {
  // The share pop-out window: a frame viewer only — no sessions, no bootstrap.
  createRoot(container).render(<PopoutScreen />);
} else {
  // Auto-resume the most recent connection (or land on the login screen).
  void bootstrapApp();

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
