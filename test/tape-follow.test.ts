import { describe, expect, it } from "vitest";
import {
  countNewSince,
  initialTapeFollow,
  pausedLabel,
  stepTapeFollow,
  type TapeFollowState
} from "../src/desk/tape-follow";

const ids = ["a", "b", "c"];

function step(prev: TapeFollowState, patch: Partial<Parameters<typeof stepTapeFollow>[1]> = {}) {
  return stepTapeFollow(prev, {
    ids,
    userMoved: false,
    atLiveEdge: false,
    pause: false,
    goLive: false,
    filterChanged: false,
    ...patch
  });
}

describe("tape follow", () => {
  it("follows the live edge and does not count arrivals", () => {
    const first = step(initialTapeFollow);
    expect(first.follow).toBe(true);
    expect(first.newCount).toBe(0);
    expect(first.state.seenId).toBe("c");
    const next = step(first.state, { ids: ["a", "b", "c", "d"] });
    expect(next.follow).toBe(true);
    expect(next.newCount).toBe(0);
    expect(next.state.seenId).toBe("d");
    expect(next.anchor).toBe(false);
  });

  it("pauses when the user leaves the live edge and holds the seen id", () => {
    const live = step(initialTapeFollow).state;
    const away = step(live, { userMoved: true, atLiveEdge: false });
    expect(away.follow).toBe(false);
    expect(away.anchor).toBe(true);
    expect(away.state.away).toBe(true);
    expect(away.state.seenId).toBe("c");
    expect(away.newCount).toBe(0);
    const grown = step(away.state, { ids: ["a", "b", "c", "d", "e"] });
    expect(grown.follow).toBe(false);
    expect(grown.newCount).toBe(2);
    expect(grown.state.seenId).toBe("c");
    expect(pausedLabel(grown.newCount)).toBe("Paused · 2 new");
  });

  it("does not count older rows prepended above the anchor", () => {
    const away = step(step(initialTapeFollow).state, { userMoved: true, atLiveEdge: false }).state;
    const older = step(away, { ids: ["z", "a", "b", "c"] });
    expect(older.newCount).toBe(0);
    expect(older.follow).toBe(false);
  });

  it("resumes only when the user scrolls back to the live edge", () => {
    const away = step(step(initialTapeFollow).state, { userMoved: true, atLiveEdge: false }).state;
    const still = step(away, { ids: ["a", "b", "c", "d"], userMoved: false, atLiveEdge: true });
    expect(still.follow).toBe(false);
    expect(still.newCount).toBe(1);
    const back = step(still.state, { ids: ["a", "b", "c", "d"], userMoved: true, atLiveEdge: true });
    expect(back.follow).toBe(true);
    expect(back.newCount).toBe(0);
    expect(back.state.seenId).toBe("d");
  });

  it("jumps live from the chip and from the header", () => {
    const away = step(step(initialTapeFollow).state, { userMoved: true, atLiveEdge: false, ids: ["a", "b", "c", "d"] }).state;
    const jumped = step(away, { ids: ["a", "b", "c", "d"], goLive: true });
    expect(jumped.follow).toBe(true);
    expect(jumped.newCount).toBe(0);
    expect(jumped.state.held).toBe(false);
    expect(jumped.state.away).toBe(false);
  });

  it("header Pause holds the edge until Live or a trip back to it", () => {
    const live = step(initialTapeFollow).state;
    const held = step(live, { pause: true });
    expect(held.follow).toBe(false);
    expect(held.state.held).toBe(true);
    expect(held.newCount).toBe(0);
    const grown = step(held.state, { ids: ["a", "b", "c", "d"] });
    expect(grown.follow).toBe(false);
    expect(grown.newCount).toBe(1);
    const jiggle = step(grown.state, { ids: ["a", "b", "c", "d"], userMoved: true, atLiveEdge: true });
    expect(jiggle.follow).toBe(false);
    expect(jiggle.state.held).toBe(true);
    const left = step(jiggle.state, { userMoved: true, atLiveEdge: false, ids: ["a", "b", "c", "d"] });
    const returned = step(left.state, { userMoved: true, atLiveEdge: true, ids: ["a", "b", "c", "d", "e"] });
    expect(returned.follow).toBe(true);
    expect(returned.state.held).toBe(false);
    expect(returned.state.seenId).toBe("e");
  });

  it("Pause while already away keeps the unseen count", () => {
    const away = step(step(initialTapeFollow).state, {
      userMoved: true,
      atLiveEdge: false,
      ids: ["a", "b", "c", "d"]
    });
    const held = step(away.state, { pause: true, ids: ["a", "b", "c", "d"] });
    expect(held.newCount).toBe(1);
    expect(held.state.seenId).toBe("c");
    expect(held.state.held).toBe(true);
  });

  it("a filter change stays paused and recounts from the new edge", () => {
    const away = step(step(initialTapeFollow).state, { userMoved: true, atLiveEdge: false }).state;
    const filtered = step(away, { ids: ["b", "c"], filterChanged: true });
    expect(filtered.follow).toBe(false);
    expect(filtered.newCount).toBe(0);
    expect(filtered.anchor).toBe(false);
    expect(filtered.state.seenId).toBe("c");
    const live = step(initialTapeFollow, { filterChanged: true, ids: ["b"] });
    expect(live.follow).toBe(true);
    expect(live.state.seenId).toBe("b");
  });

  it("counts every row when pause started on an empty tape", () => {
    const held = step(initialTapeFollow, { ids: [], pause: true });
    expect(held.follow).toBe(false);
    expect(held.state.seenId).toBeNull();
    const arrived = step(held.state, { ids: ["a", "b"] });
    expect(arrived.newCount).toBe(2);
    expect(countNewSince(["a", "b"], null, true)).toBe(2);
    expect(countNewSince(["a", "b"], "missing", true)).toBe(2);
  });
});
