import { describe, expect, it } from "vitest";
import { nextTheme, readThemePref, resolveTheme } from "../web/src/theme";
import { readFileSync } from "node:fs";

describe("v13 theme preference", () => {
  it("defaults to dark, reads saved values, and resolves System", () => {
    expect(readThemePref(null)).toBe("dark");
    expect(readThemePref({ getItem: () => "light" })).toBe("light");
    expect(readThemePref({ getItem: () => "bogus" })).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("system");
    expect(nextTheme("system")).toBe("dark");
  });
  it("both themes come from the one palette block and define the same tokens", () => {
    const css = readFileSync("web/src/styles.css", "utf8");
    const block = (sel: string) => {
      const start = css.indexOf(sel);
      return new Set([...css.slice(start, css.indexOf("}", start)).matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
    };
    const dark = block(":root {");
    const light = block(':root[data-theme="light"] {');
    for (const k of ["--bg", "--card", "--ink", "--accent", "--up", "--down", "--amber", "--blue"]) {
      expect(dark.has(k)).toBe(true);
      expect(light.has(k)).toBe(true);
    }
  });
});
