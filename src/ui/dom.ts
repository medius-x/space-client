/**
 * Tiny DOM builder — the spike's entire view layer. `el("div", {class: "x"}, ...children)`
 * mirrors document.createElement with attribute binding; text children are appended as
 * text nodes so nothing is ever innerHTML'd (XSS-safe by construction).
 */
export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((event: Event) => void) | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === "function") {
      node.addEventListener(name.startsWith("on") ? name.slice(2) : name, value as EventListener);
    } else if (typeof value === "boolean") {
      if (value) {
        node.setAttribute(name, "");
      }
    } else {
      node.setAttribute(name, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(target: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    target.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function clear(target: Node): void {
  while (target.firstChild) {
    target.removeChild(target.firstChild);
  }
}

export function $(selector: string): HTMLElement {
  const node = document.querySelector(selector);
  if (!node) {
    throw new Error(`selector not found: ${selector}`);
  }
  return node as HTMLElement;
}
