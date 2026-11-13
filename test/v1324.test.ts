import { describe, expect, it } from "vitest";
import { APP_VERSION, crashOnHome } from "../src/desk/crash-card.js";
import { Desk } from "../src/desk/orchestrator.js";
import { testConfig } from "./helpers.js";

describe("v13.24 crash card", () => {
  it("shows a crash only when its version is the installed version", () => {
    expect(APP_VERSION).toBe("13.40");
    const old = { version: "13.24", dismissed: false };
    const current = { version: "13.40", dismissed: false };
    expect(crashOnHome(old, APP_VERSION)).toBe(false);
    expect(crashOnHome(current, APP_VERSION)).toBe(true);
    expect(crashOnHome({ ...current, dismissed: true }, APP_VERSION)).toBe(false);
    expect(crashOnHome(null, APP_VERSION)).toBe(false);
    expect(crashOnHome({ version: "13.24", dismissed: false }, "13.18")).toBe(false);
  });

  it("dismiss hides the card and keeps the crash record, and a new crash shows again", () => {
    const cfg = testConfig();
    const desk = new Desk(cfg);
    try {
      desk.recordClientCrash("13.18", "android.os.NetworkOnMainThreadException: PumpApi.watch");
      expect(crashOnHome(desk.snapshot().lastClientCrash, APP_VERSION)).toBe(false);
      const kept = desk.store.readJson("lastClientCrash") as { version?: string; brief?: string; text?: string; dismissed?: boolean };
      expect(kept.version).toBe("13.18");
      expect(kept.brief).toMatch(/NetworkOnMainThreadException/);
      expect(kept.text).toMatch(/NetworkOnMainThreadException/);
      expect(kept.dismissed).toBe(false);

      desk.recordClientCrash("13.40", "java.lang.IllegalStateException: fresh");
      expect(crashOnHome(desk.snapshot().lastClientCrash, APP_VERSION)).toBe(true);
      desk.dismissClientCrash();
      expect(crashOnHome(desk.snapshot().lastClientCrash, APP_VERSION)).toBe(false);
      const hidden = desk.store.readJson("lastClientCrash") as { brief?: string; text?: string; dismissed?: boolean };
      expect(hidden.dismissed).toBe(true);
      expect(hidden.brief).toMatch(/fresh/);
      expect(hidden.text).toMatch(/IllegalStateException/);
    } finally {
      desk.stop();
    }
    const again = new Desk({ ...cfg, resetPaper: false });
    try {
      const stored = again.store.readJson("lastClientCrash") as { brief?: string; dismissed?: boolean };
      expect(stored.dismissed).toBe(true);
      expect(stored.brief).toMatch(/fresh/);
      expect(crashOnHome(again.snapshot().lastClientCrash, APP_VERSION)).toBe(false);
      again.recordClientCrash("13.40", "java.lang.IllegalStateException: newer");
      expect(crashOnHome(again.snapshot().lastClientCrash, APP_VERSION)).toBe(true);
      expect((again.store.readJson("lastClientCrash") as { dismissed?: boolean }).dismissed).toBe(false);
    } finally {
      again.stop();
    }
  });
});
