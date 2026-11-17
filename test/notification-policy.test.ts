import { describe, expect, it } from "vitest";
import { notificationPolicy, notificationPolicyMode, type StatusOverride } from "../src/domain/logic/notification-policy";

/** The user-signed status/notification matrix (2026-11-17): everything derives
 *  from (override, autoAway) — see the module doc for the full table. */
describe("notificationPolicyMode", () => {
  it("dnd and invisible are quiet regardless of the idle verdict", () => {
    expect(notificationPolicyMode("dnd", false)).toBe("quiet");
    expect(notificationPolicyMode("dnd", true)).toBe("quiet");
    expect(notificationPolicyMode("invisible", false)).toBe("quiet");
    expect(notificationPolicyMode("invisible", true)).toBe("quiet");
  });

  it("a manual away pin is away-manual; auto away only while idle and unpinned", () => {
    expect(notificationPolicyMode("away", false)).toBe("away-manual");
    expect(notificationPolicyMode("away", true)).toBe("away-manual");
    expect(notificationPolicyMode("auto", true)).toBe("away-auto");
    expect(notificationPolicyMode("auto", false)).toBe("online");
    expect(notificationPolicyMode("online", true)).toBe("online"); // the pin wins over the idle verdict
  });
});

describe("notificationPolicy", () => {
  type Mode = ReturnType<typeof notificationPolicyMode>;
  const matrix: Record<Mode, { messageSound: boolean; messageToast: "shown" | "sticky" | "hidden"; callSound: boolean }> = {
    online: { messageSound: true, messageToast: "shown", callSound: true },
    "away-auto": { messageSound: false, messageToast: "sticky", callSound: true },
    "away-manual": { messageSound: false, messageToast: "hidden", callSound: true },
    quiet: { messageSound: false, messageToast: "hidden", callSound: false },
  };

  it("every mode matches the signed matrix", () => {
    for (const mode of Object.keys(matrix) as Mode[]) {
      expect(notificationPolicy(mode)).toEqual(matrix[mode]);
    }
  });

  it("the overrides walk every lane of the matrix", () => {
    const overrides: StatusOverride[] = ["auto", "online", "away", "dnd", "invisible"];
    const seen = new Set(Object.keys(matrix));
    for (const override of overrides) {
      seen.add(notificationPolicyMode(override, true));
      seen.add(notificationPolicyMode(override, false));
    }
    expect(seen.size).toBe(Object.keys(matrix).length);
  });
});
