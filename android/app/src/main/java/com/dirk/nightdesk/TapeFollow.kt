package com.dirk.nightdesk

/**
 * Tape follow/pause. Matches src/desk/tape-follow.ts.
 * The live edge is the newest row. Auto-scroll runs only while following.
 */
data class TapeFollowState(
    val held: Boolean = false,
    val away: Boolean = false,
    val seenId: String? = null
)

data class TapeFollowInput(
    val ids: List<String>,
    val userMoved: Boolean = false,
    val atLiveEdge: Boolean = false,
    val pause: Boolean = false,
    val goLive: Boolean = false,
    val filterChanged: Boolean = false
)

data class TapeFollowResult(
    val state: TapeFollowState,
    val follow: Boolean,
    val newCount: Int,
    val anchor: Boolean
)

fun pausedLabel(count: Int): String = "Paused · $count new"

fun countNewSince(ids: List<String>, seenId: String?, paused: Boolean): Int {
    if (!paused || ids.isEmpty()) return 0
    if (seenId == null) return ids.size
    val idx = ids.lastIndexOf(seenId)
    if (idx < 0) return ids.size
    return ids.size - 1 - idx
}

private fun live(newest: String?): TapeFollowResult = TapeFollowResult(
    state = TapeFollowState(held = false, away = false, seenId = newest),
    follow = true,
    newCount = 0,
    anchor = false
)

private fun hold(
    held: Boolean,
    away: Boolean,
    seenId: String?,
    ids: List<String>,
    anchor: Boolean
): TapeFollowResult {
    val paused = held || away
    return TapeFollowResult(
        state = TapeFollowState(held = held, away = away, seenId = seenId),
        follow = false,
        newCount = countNewSince(ids, seenId, paused),
        anchor = anchor
    )
}

fun stepTapeFollow(prev: TapeFollowState, input: TapeFollowInput): TapeFollowResult {
    val newest = input.ids.lastOrNull()
    if (input.goLive) return live(newest)
    if (input.filterChanged) {
        if (prev.held || prev.away) return hold(prev.held, prev.away, newest, input.ids, false)
        return live(newest)
    }
    if (input.userMoved && !input.atLiveEdge) {
        val seen = if (prev.away) prev.seenId else (prev.seenId ?: newest)
        return hold(prev.held, true, seen, input.ids, true)
    }
    if (input.userMoved && input.atLiveEdge && prev.away) return live(newest)
    if (input.userMoved && input.atLiveEdge && prev.held) {
        return hold(true, false, prev.seenId, input.ids, true)
    }
    if (input.userMoved && input.atLiveEdge) return live(newest)
    if (input.pause) {
        val seenId = if (prev.away) prev.seenId else newest
        return hold(true, prev.away, seenId, input.ids, true)
    }
    if (prev.held || prev.away) return hold(prev.held, prev.away, prev.seenId, input.ids, true)
    return live(newest)
}
