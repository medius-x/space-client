import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrapApp } from "./runtime";
import "./styles/global.css";

const container = document.querySelector<HTMLElement>("#root");
if (!container) {
  throw new Error("#root not found");
}

// Auto-resume the most recent connection (or land on the login screen).
void bootstrapApp();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
