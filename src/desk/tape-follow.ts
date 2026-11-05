/** Tape follow/pause. The Android port in TapeFollow.kt matches these rules. */

export interface TapeFollowState {
  /** Header Pause is on. A gesture back to the live edge clears it. */
  held: boolean;
  /** The user dragged or wheeled away from the live edge. */
  away: boolean;
  /** Newest id already acknowledged. Ids after this one are "new" while paused. */
  seenId: string | null;
}

export interface TapeFollowInput {
  /** Filtered tape ids, oldest first. The last id is the live edge. */
  ids: readonly string[];
  /** A real scroll, drag, or fling. Programmatic jumps leave this false. */
  userMoved: boolean;
  /** After that gesture, the viewport is on the live edge. */
  atLiveEdge: boolean;
  /** Header Pause. */
  pause: boolean;
  /** Header Live, or the Paused chip. Jumps to the edge and follows. */
  goLive: boolean;
  /** Stage filter changed. Stay paused, but recount inside the new list. */
  filterChanged: boolean;
}

export interface TapeFollowResult {
  state: TapeFollowState;
  /** Keep auto-scrolling to the newest row. */
  follow: boolean;
  /** Rows that arrived after the pause anchor. */
  newCount: number;
  /** Hold the viewed row still. False when following or the list was replaced. */
  anchor: boolean;
}

export const initialTapeFollow: TapeFollowState = { held: false, away: false, seenId: null };

export function pausedLabel(count: number): string {
  return `Paused · ${count} new`;
}

/** Ids strictly after seenId. A missing anchor counts the whole list. */
export function countNewSince(ids: readonly string[], seenId: string | null, paused: boolean): number {
  if (!paused || ids.length === 0) return 0;
  if (seenId == null) return ids.length;
  const idx = ids.lastIndexOf(seenId);
  if (idx < 0) return ids.length;
  return ids.length - 1 - idx;
}

function live(newest: string | null): TapeFollowResult {
  return {
    state: { held: false, away: false, seenId: newest },
    follow: true,
    newCount: 0,
    anchor: false
  };
}

function hold(
  held: boolean,
  away: boolean,
  seenId: string | null,
  ids: readonly string[],
  anchor: boolean
): TapeFollowResult {
  const paused = held || away;
  return {
    state: { held, away, seenId },
    follow: false,
    newCount: countNewSince(ids, seenId, paused),
    anchor
  };
}

export function stepTapeFollow(prev: TapeFollowState, input: TapeFollowInput): TapeFollowResult {
  const newest = input.ids.length > 0 ? input.ids[input.ids.length - 1]! : null;

  if (input.goLive) return live(newest);

  if (input.filterChanged) {
    if (prev.held || prev.away) return hold(prev.held, prev.away, newest, input.ids, false);
    return live(newest);
  }

  if (input.userMoved && !input.atLiveEdge) {
    const seen = prev.away ? prev.seenId : (prev.seenId ?? newest);
    return hold(prev.held, true, seen, input.ids, true);
  }

  if (input.userMoved && input.atLiveEdge && prev.away) return live(newest);

  if (input.userMoved && input.atLiveEdge && prev.held) {
    return hold(true, false, prev.seenId, input.ids, true);
  }

  if (input.userMoved && input.atLiveEdge) return live(newest);

  if (input.pause) {
    const seenId = prev.away ? prev.seenId : newest;
    return hold(true, prev.away, seenId, input.ids, true);
  }

  if (prev.held || prev.away) return hold(prev.held, prev.away, prev.seenId, input.ids, true);

  return live(newest);
}
