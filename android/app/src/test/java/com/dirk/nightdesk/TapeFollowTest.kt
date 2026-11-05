package com.dirk.nightdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TapeFollowTest {
    private val ids = listOf("a", "b", "c")

    private fun step(prev: TapeFollowState, input: TapeFollowInput = TapeFollowInput(ids)): TapeFollowResult =
        stepTapeFollow(prev, input)

    @Test
    fun followsTheLiveEdge() {
        val first = step(TapeFollowState())
        assertTrue(first.follow)
        assertEquals(0, first.newCount)
        assertEquals("c", first.state.seenId)
        val next = step(first.state, TapeFollowInput(listOf("a", "b", "c", "d")))
        assertTrue(next.follow)
        assertEquals(0, next.newCount)
        assertEquals("d", next.state.seenId)
        assertFalse(next.anchor)
    }

    @Test
    fun pauseWhenTheUserLeavesAndCountArrivals() {
        val live = step(TapeFollowState()).state
        val away = step(live, TapeFollowInput(ids, userMoved = true, atLiveEdge = false))
        assertFalse(away.follow)
        assertTrue(away.anchor)
        assertEquals("c", away.state.seenId)
        val grown = step(away.state, TapeFollowInput(listOf("a", "b", "c", "d", "e")))
        assertFalse(grown.follow)
        assertEquals(2, grown.newCount)
        assertEquals("Paused · 2 new", pausedLabel(grown.newCount))
    }

    @Test
    fun prependDoesNotCountAsNew() {
        val away = step(step(TapeFollowState()).state, TapeFollowInput(ids, userMoved = true, atLiveEdge = false)).state
        val older = step(away, TapeFollowInput(listOf("z", "a", "b", "c")))
        assertEquals(0, older.newCount)
        assertFalse(older.follow)
    }

    @Test
    fun resumeOnlyByScrollingBack() {
        val away = step(step(TapeFollowState()).state, TapeFollowInput(ids, userMoved = true, atLiveEdge = false)).state
        val still = step(away, TapeFollowInput(listOf("a", "b", "c", "d"), atLiveEdge = true))
        assertFalse(still.follow)
        assertEquals(1, still.newCount)
        val back = step(still.state, TapeFollowInput(listOf("a", "b", "c", "d"), userMoved = true, atLiveEdge = true))
        assertTrue(back.follow)
        assertEquals("d", back.state.seenId)
    }

    @Test
    fun chipJumpsLive() {
        val away = step(
            step(TapeFollowState()).state,
            TapeFollowInput(listOf("a", "b", "c", "d"), userMoved = true, atLiveEdge = false)
        ).state
        val jumped = step(away, TapeFollowInput(listOf("a", "b", "c", "d"), goLive = true))
        assertTrue(jumped.follow)
        assertEquals(0, jumped.newCount)
        assertFalse(jumped.state.held)
        assertFalse(jumped.state.away)
    }

    @Test
    fun headerPauseHoldsUntilLiveOrATripBack() {
        val held = step(step(TapeFollowState()).state, TapeFollowInput(ids, pause = true))
        assertFalse(held.follow)
        assertTrue(held.state.held)
        val grown = step(held.state, TapeFollowInput(listOf("a", "b", "c", "d")))
        assertEquals(1, grown.newCount)
        val jiggle = step(grown.state, TapeFollowInput(listOf("a", "b", "c", "d"), userMoved = true, atLiveEdge = true))
        assertFalse(jiggle.follow)
        assertTrue(jiggle.state.held)
        val left = step(jiggle.state, TapeFollowInput(listOf("a", "b", "c", "d"), userMoved = true, atLiveEdge = false))
        val returned = step(left.state, TapeFollowInput(listOf("a", "b", "c", "d", "e"), userMoved = true, atLiveEdge = true))
        assertTrue(returned.follow)
        assertFalse(returned.state.held)
        assertEquals("e", returned.state.seenId)
    }

    @Test
    fun emptyPauseCountsEveryArrival() {
        val held = step(TapeFollowState(), TapeFollowInput(emptyList(), pause = true))
        val arrived = step(held.state, TapeFollowInput(listOf("a", "b")))
        assertEquals(2, arrived.newCount)
    }
}
