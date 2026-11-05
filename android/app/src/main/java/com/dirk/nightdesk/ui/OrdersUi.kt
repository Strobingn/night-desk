package com.dirk.nightdesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dirk.nightdesk.DeskOrder
import com.dirk.nightdesk.OrderTicket
import com.dirk.nightdesk.PriceText
import com.dirk.nightdesk.formatUsd
import java.util.Locale

/** v13.11 what the order UI needs from the desk. */
class OrderActions(
    val orders: List<DeskOrder>,
    val liveArmed: Boolean,
    val liveTradeUsd: Double,
    val tapUsd: Double,
    val stopLossPct: Double,
    val place: (side: String, mint: String, basis: String, value: Double, live: Boolean, percent: Int?, sizeUsd: Double?) -> Unit,
    val cancel: (id: String) -> Unit,
    /** Screenshots / previews: open this mint's ticket on this side. */
    val openFor: Pair<String, String>? = null
) {
    fun openOn(mint: String, live: Boolean? = null): List<DeskOrder> =
        orders.filter { it.mint == mint && it.isOpen && (live == null || it.live == live) }
}

private val LiveColor = Color(0xFFFF2E7E)

private fun sideColor(side: String): Color = when (side) {
    "take_profit" -> P.up
    "stop_sell" -> P.down
    else -> P.blue
}

private fun sideOn(side: String): Color = when (side) {
    "take_profit" -> P.onUp
    "stop_sell" -> P.onDown
    else -> Color(0xFF001427)
}

@Composable
private fun TicketChip(label: String, on: Boolean, tint: Color = P.accent, onTint: Color = P.onAccent, onClick: () -> Unit) {
    Text(
        label,
        color = if (on) onTint else tint,
        fontSize = 13.sp,
        fontWeight = FontWeight.ExtraBold,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (on) tint else P.surface)
            .border(1.dp, if (on) tint else tint.copy(alpha = 0.5f), RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp)
    )
}

/** Orders row on a position card: ▲ Take profit · ▼ Stop, this coin's open orders, and the ticket. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PositionOrders(actions: OrderActions, mint: String, symbol: String, live: Boolean, mark: Double?, entry: Double?, stopPrice: Double?, modifier: Modifier = Modifier) {
    val preset = actions.openFor?.takeIf { it.first == mint && it.second != "limit_buy" }?.second
    var ticket by remember(mint) { mutableStateOf(preset) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (live) "ORDERS · LIVE" else "ORDERS", color = P.muted, fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.6.sp)
            Spacer(Modifier.width(8.dp))
            TicketChip("▲ Take profit", ticket == "take_profit", P.up, P.onUp) { ticket = if (ticket == "take_profit") null else "take_profit" }
            Spacer(Modifier.width(6.dp))
            TicketChip("▼ Stop", ticket == "stop_sell", P.down, P.onDown) { ticket = if (ticket == "stop_sell") null else "stop_sell" }
        }
        OrderChips(actions, actions.openOn(mint, live))
        val side = ticket
        if (side != null) {
            OrderTicketCard(
                actions, mint, symbol,
                sides = if (side == "take_profit") listOf("take_profit", "stop_sell") else listOf("stop_sell", "take_profit"),
                fixedLive = live, mark = mark, entry = entry, stopPrice = stopPrice
            ) { ticket = null }
        }
    }
}

/** Limit buy on a Tape coin card. */
@Composable
fun LimitBuyTicket(actions: OrderActions, mint: String, symbol: String, mark: Double?, onClose: () -> Unit) {
    OrderTicketCard(actions, mint, symbol, sides = listOf("limit_buy"), fixedLive = null, mark = mark, entry = null, stopPrice = null, onClose = onClose)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OrderChips(actions: OrderActions, rows: List<DeskOrder>) {
    if (rows.isEmpty()) return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        rows.forEach { o ->
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(P.surface).border(1.dp, sideColor(o.side), RoundedCornerShape(50)).padding(start = 10.dp, end = 4.dp, top = 3.dp, bottom = 3.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (o.live) {
                    Text("LIVE", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Black, modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(LiveColor).padding(horizontal = 4.dp))
                    Spacer(Modifier.width(4.dp))
                }
                Text(
                    "${OrderTicket.SIDE_LABEL[o.side]} ${PriceText.px(o.triggerPrice)}${OrderTicket.amountText(o)}",
                    color = P.ink, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1
                )
                Spacer(Modifier.width(4.dp))
                Text(OrderTicket.statusText(o), color = P.muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(
                    "✕", color = P.ink, fontSize = 12.sp,
                    modifier = Modifier.padding(start = 4.dp).clip(RoundedCornerShape(50)).background(P.line).clickable { actions.cancel(o.id) }.padding(horizontal = 7.dp, vertical = 2.dp)
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OrderTicketCard(
    actions: OrderActions,
    mint: String,
    symbol: String,
    sides: List<String>,
    fixedLive: Boolean?,
    mark: Double?,
    entry: Double?,
    stopPrice: Double?,
    onClose: () -> Unit
) {
    var side by remember(mint) { mutableStateOf(sides.first()) }
    var basis by remember(mint) { mutableStateOf(OrderTicket.basesFor(sides.first()).first()) }
    var value by remember(mint) { mutableStateOf(OrderTicket.defaultValue(side, basis)) }
    var pct by remember(mint) { mutableStateOf(100) }
    var live by remember(mint) { mutableStateOf(fixedLive ?: actions.liveArmed) }
    var size by remember(mint) { mutableStateOf(sizeText(if (live) actions.liveTradeUsd else actions.tapUsd)) }
    val n = OrderTicket.parse(value)
    val preview = OrderTicket.preview(basis, n, mark, entry)
    val edge = if (live) LiveColor else P.accent
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(edge.copy(alpha = 0.07f)).border(1.dp, edge.copy(alpha = 0.55f), RoundedCornerShape(14.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            sides.forEach { s ->
                TicketChip(OrderTicket.SIDE_LABEL[s] ?: s, side == s, sideColor(s), sideOn(s)) {
                    side = s
                    if (basis !in OrderTicket.basesFor(s)) basis = OrderTicket.basesFor(s).first()
                    value = OrderTicket.defaultValue(s, basis)
                }
                Spacer(Modifier.width(6.dp))
            }
            Spacer(Modifier.weight(1f))
            if (fixedLive == null) {
                TicketChip("PAPER", !live, Color(0xFF9CC3FF), Color(0xFF0B1730)) { live = false; size = sizeText(actions.tapUsd) }
                Spacer(Modifier.width(4.dp))
                TicketChip("LIVE", live, LiveColor, Color.White) { live = true; size = sizeText(actions.liveTradeUsd) }
            } else {
                BookTag(live = live)
            }
            Text("✕", color = P.muted, fontSize = 16.sp, modifier = Modifier.clickable(onClick = onClose).padding(horizontal = 8.dp, vertical = 2.dp))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            OrderTicket.basesFor(side).forEach { b ->
                TicketChip(OrderTicket.BASIS_LABEL[b] ?: b, basis == b) {
                    basis = b
                    value = OrderTicket.defaultValue(side, b)
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            NumberBox(if (basis == "price") "$" else if (basis == "mcap") "MCap $" else "%", value, Modifier.weight(1f)) { value = it }
            if (side == "limit_buy") {
                NumberBox("$", size, Modifier.width(96.dp)) { size = it }
            } else if (live) {
                TicketChip("100%", true) {}
            } else {
                listOf(25, 50, 100).forEach { p -> TicketChip("$p%", pct == p) { pct = p } }
            }
        }
        Text(
            buildString {
                append(if (basis == "mcap") "Desk converts the market cap to a price." else preview?.let { "Trigger ${PriceText.px(it)}" } ?: "Enter a number.")
                mark?.takeIf { it > 0 }?.let { append(" · now ${PriceText.px(it)}") }
                if (side == "stop_sell" && stopPrice != null && stopPrice > 0) append(" · hard stop ${PriceText.px(stopPrice)} stays the floor; your stop can only be tighter.")
                if (live && !actions.liveArmed) append(" · waiting: live not armed (never fills on paper).")
            },
            color = P.dim, fontSize = 12.sp
        )
        val ready = n != null && value.isNotBlank()
        val sizeUsd = OrderTicket.parse(size)
        BigButton(
            "Place ${(OrderTicket.SIDE_LABEL[side] ?: side).lowercase(Locale.US)}" +
                (if (side == "limit_buy") " ${formatUsd(sizeUsd ?: 0.0)}" else " ${if (live) 100 else pct}%") + (if (live) " LIVE" else ""),
            sideColor(side), sideOn(side), Modifier.fillMaxWidth(), height = 46.dp, enabled = ready
        ) {
            val v = n ?: return@BigButton
            actions.place(side, mint, basis, v, live, if (side == "limit_buy") null else if (live) 100 else pct, if (side == "limit_buy") sizeUsd else null)
            onClose()
        }
    }
}

private fun sizeText(n: Double): String = if (n == Math.floor(n)) "%.0f".format(Locale.US, n) else "%.2f".format(Locale.US, n)

@Composable
private fun NumberBox(prefix: String, value: String, modifier: Modifier, onChange: (String) -> Unit) {
    Row(
        modifier.height(42.dp).clip(RoundedCornerShape(10.dp)).background(P.bg).border(1.dp, P.lineStrong, RoundedCornerShape(10.dp)).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(prefix, color = P.muted, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold)
        Spacer(Modifier.width(6.dp))
        BasicTextField(
            value, onChange,
            singleLine = true,
            textStyle = TextStyle(color = P.ink, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold),
            cursorBrush = SolidColor(P.accent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth()
        )
    }
}

/** Book screen: every open order with Cancel, then the last few finished ones. */
@Composable
fun OrdersCard(actions: OrderActions) {
    val open = actions.orders.filter { it.isOpen }
    val done = actions.orders.filter { !it.isOpen }.take(5)
    Column(Modifier.deskCard().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Orders", color = P.ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text("${open.size} open", color = P.muted, fontSize = 12.5.sp)
        }
        if (open.isEmpty()) Text("No open orders. Set a stop or take profit on a position, or a limit buy on a Tape coin.", color = P.muted, fontSize = 13.sp)
        open.forEach { o -> OrderRow(o, actions) }
        done.forEach { o -> OrderRow(o, null) }
        Text(
            "Orders fire on the same fresh price the hard stop uses and go through every buy/sell check. A refusal shows here, never a silent fill. Your −${"%.0f".format(Locale.US, actions.stopLossPct * 100)}% hard stop stays the floor.",
            color = P.muted, fontSize = 11.5.sp
        )
    }
}

@Composable
private fun OrderRow(o: DeskOrder, actions: OrderActions?) {
    val waiting = o.waiting != null
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(P.surface)
            .border(1.dp, if (waiting) P.amber.copy(alpha = 0.6f) else P.line, RoundedCornerShape(12.dp)).padding(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    (OrderTicket.SIDE_LABEL[o.side] ?: o.side).uppercase(Locale.US),
                    color = sideOn(o.side), fontSize = 10.sp, fontWeight = FontWeight.Black,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(if (o.isOpen) sideColor(o.side) else sideColor(o.side).copy(alpha = 0.5f)).padding(horizontal = 6.dp, vertical = 3.dp)
                )
                Spacer(Modifier.width(6.dp))
                BookTag(live = o.live)
                Spacer(Modifier.width(6.dp))
                Text(
                    o.symbol + (if (!o.isOpen) " · ${o.status}" else ""),
                    color = if (o.isOpen) P.ink else P.muted, fontSize = 13.5.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(Modifier.height(3.dp))
            Text(
                "@ ${PriceText.px(o.triggerPrice)}" + (o.markUsd?.let { "  ·  now ${PriceText.px(it)}" } ?: ""),
                color = if (o.isOpen) sideColor(o.side) else P.muted, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1
            )
            Text(
                OrderTicket.amountText(o).removePrefix(" · ").let { if (it.isBlank()) "" else "$it · " } + OrderTicket.statusText(o),
                color = if (waiting) P.amber else P.muted, fontSize = 11.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis
            )
        }
        if (actions != null && o.status == "open") {
            Spacer(Modifier.width(6.dp))
            Text(
                "Cancel", color = P.ink, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold,
                modifier = Modifier.clip(RoundedCornerShape(10.dp)).border(1.dp, P.lineStrong, RoundedCornerShape(10.dp)).clickable { actions.cancel(o.id) }.padding(horizontal = 10.dp, vertical = 8.dp)
            )
        }
    }
}
