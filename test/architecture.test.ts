import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture boundary: React may ONLY be imported under src/renderer/. Everything
 * else (core, domain, media) must stay framework-agnostic so the layers survive any
 * future UI pivot and stay unit-testable in plain node.
 */
function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(name)) {
      entries.push(full);
    }
  }
  return entries;
}

describe("architecture boundaries", () => {
  it("no react imports outside src/renderer", () => {
    const offenders: string[] = [];
    for (const file of walk(join(__dirname, "..", "src"))) {
      const normalized = file.replace(/\\/g, "/");
      if (normalized.includes("/renderer/")) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (/from ["']react(\/|-dom|-jsx-runtime)?["']/.test(text)) {
        offenders.push(normalized);
      }
    }
    expect(offenders).toEqual([]);
  });
});
