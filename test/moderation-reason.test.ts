import { describe, expect, it } from "vitest";
import { memberKickReasonText, memberKickTitle } from "../src/domain/logic/moderation-reason";

describe("memberKickTitle", () => {
  it("separates the three outcomes", () => {
    expect(memberKickTitle({ by: "admin", banned: false, removed: true })).toBe("Removed from server");
    expect(memberKickTitle({ by: "admin", banned: true })).toBe("Banned");
    expect(memberKickTitle({ by: "admin", banned: false })).toBe("Disconnected");
  });
});

describe("memberKickReasonText", () => {
  it("a removal offers NO reconnect hint — there is nothing to reconnect to", () => {
    const text = memberKickReasonText({ by: "admin", banned: false, removed: true });
    expect(text).toContain("removed from the server by admin");
    expect(text).toContain("can no longer join this server");
    expect(text).not.toContain("reconnect");
  });

  it("a ban points at the moderator unban", () => {
    expect(memberKickReasonText({ by: "admin", banned: true }))
      .toBe("You were banned by admin. A moderator must unban you before reconnecting.");
  });

  it("a plain disconnect keeps the one-click reconnect hint", () => {
    expect(memberKickReasonText({ by: "admin", banned: false }))
      .toBe("You were disconnected by admin. Click the server again to reconnect.");
  });

  it("renders the RU titles and reasons", () => {
    expect(memberKickTitle({ by: "admin", banned: false, removed: true }, "ru")).toBe("Удалены с сервера");
    expect(memberKickTitle({ by: "admin", banned: true }, "ru")).toBe("Забанены");
    expect(memberKickTitle({ by: "admin", banned: false }, "ru")).toBe("Отключены");
    expect(memberKickReasonText({ by: "admin", banned: true }, "ru"))
      .toBe("Вас забанил admin. Модератор должен разбанить вас для переподключения.");
  });
});
