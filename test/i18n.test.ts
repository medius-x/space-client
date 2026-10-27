import { describe, expect, it } from "vitest";
import { EN, type MessageKey } from "../src/domain/i18n/en";
import { RU } from "../src/domain/i18n/ru";
import { resolveUiLanguage, setLanguage, t, tf } from "../src/domain/i18n/i18n";
import { KNOWN_PERMISSION_BITS, permissionDescription, permissionLabel } from "../src/domain/i18n/permissions";

describe("i18n dictionaries", () => {
  it("RU covers the EN key set exactly", () => {
    expect(Object.keys(RU).sort()).toEqual(Object.keys(EN).sort());
  });

  it("EN carries no Cyrillic (a RU string pasted into the wrong dictionary)", () => {
    for (const [key, value] of Object.entries(EN)) {
      const text = typeof value === "string" ? value : Object.values(value).join(" ");
      expect(/[Ѐ-ӿ]/.test(text), `EN entry "${key}" carries Cyrillic`).toBe(false);
    }
  });

  it("every RU plural entry fills one/few/many/other", () => {
    for (const [key, value] of Object.entries(EN)) {
      if (typeof value === "string") {
        continue;
      }
      const ruForms = RU[key as MessageKey] as Record<string, string | undefined>;
      for (const category of ["one", "few", "many", "other"]) {
        expect(ruForms[category], `RU plural "${key}" misses "${category}"`).toBeDefined();
      }
    }
  });
});

describe("permission catalog", () => {
  it("every known bit has label and description in EN (RU via the parity gate)", () => {
    for (const bit of KNOWN_PERMISSION_BITS) {
      expect((`permissions.${bit}.label` as MessageKey) in EN, `bit ${bit} misses its label key`).toBe(true);
      expect((`permissions.${bit}.description` as MessageKey) in EN, `bit ${bit} misses its description key`).toBe(true);
    }
  });

  it("the dictionaries hold no permission keys beyond the known bits", () => {
    const known = new Set(KNOWN_PERMISSION_BITS);
    for (const key of Object.keys(EN)) {
      if (!key.startsWith("permissions.")) {
        continue;
      }
      const bit = key.slice("permissions.".length).replace(/\.(label|description)$/, "");
      expect(known.has(bit), `dictionary carries permission "${bit}" missing from KNOWN_PERMISSION_BITS`).toBe(true);
    }
  });

  it("an unknown wire bit falls back to its raw name and an empty description", () => {
    setLanguage("en");
    expect(permissionLabel(t, "SOME_FUTURE_BIT")).toBe("SOME_FUTURE_BIT");
    expect(permissionDescription(t, "SOME_FUTURE_BIT")).toBe("");
    setLanguage("ru");
    expect(permissionLabel(t, "SOME_FUTURE_BIT")).toBe("SOME_FUTURE_BIT");
    expect(permissionLabel(t, "MANAGE_SERVER")).toBe("Управление сервером");
    setLanguage("en");
  });
});

describe("resolveUiLanguage", () => {
  it("explicit settings win over the navigator", () => {
    expect(resolveUiLanguage("ru", "en-US")).toBe("ru");
    expect(resolveUiLanguage("en", "ru-RU")).toBe("en");
  });

  it("system resolves via the navigator language", () => {
    expect(resolveUiLanguage("system", "ru-RU")).toBe("ru");
    expect(resolveUiLanguage("system", "RU")).toBe("ru");
    expect(resolveUiLanguage("system", "en-US")).toBe("en");
    expect(resolveUiLanguage("system", "de-DE")).toBe("en");
  });

  it("a null navigator falls back to English", () => {
    expect(resolveUiLanguage("system", null)).toBe("en");
  });
});

describe("tf", () => {
  it("pluralizes EN one/other", () => {
    expect(tf("en", "search.resultsCount", { count: 1 })).toBe("1 result");
    expect(tf("en", "search.resultsCount", { count: 5 })).toBe("5 results");
  });

  it("pluralizes RU one/few/many across the number ladder", () => {
    expect(tf("ru", "search.resultsCount", { count: 1 })).toBe("1 результат");
    expect(tf("ru", "search.resultsCount", { count: 2 })).toBe("2 результата");
    expect(tf("ru", "search.resultsCount", { count: 5 })).toBe("5 результатов");
    expect(tf("ru", "search.resultsCount", { count: 21 })).toBe("21 результат");
    expect(tf("ru", "search.resultsCount", { count: 22 })).toBe("22 результата");
    expect(tf("ru", "search.resultsCount", { count: 25 })).toBe("25 результатов");
    expect(tf("ru", "search.resultsCount", { count: 100 })).toBe("100 результатов");
    expect(tf("ru", "search.resultsCount", { count: 101 })).toBe("101 результат");
  });

  it("translates plain keys per language", () => {
    expect(tf("en", "tray.quit")).toBe("Quit");
    expect(tf("ru", "tray.quit")).toBe("Выход");
  });

  it("an unknown key ladders down to the key itself", () => {
    expect(tf("en", "bogus.key" as MessageKey)).toBe("bogus.key");
  });

  it("a plural entry without a count falls back to other", () => {
    expect(tf("en", "search.resultsCount")).toBe("{count} results");
  });
});

describe("t (module state)", () => {
  it("setLanguage switches the current translator", () => {
    setLanguage("ru");
    expect(t("tray.open")).toBe("Открыть");
    setLanguage("en");
    expect(t("tray.open")).toBe("Open");
  });

  it("setLanguage with the same value is a no-op", () => {
    setLanguage("en");
    setLanguage("en");
    expect(t("tray.open")).toBe("Open");
  });
});
