import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatBuyNotice } from "../../src/desk/buy-notice";
import { countNewSince, initialTapeFollow, pausedLabel, stepTapeFollow, type TapeFollowState } from "../../src/desk/tape-follow";
import type { AdviceNote, DeskSnapshot, FeedEvent, LiveReadiness } from "./types";

const LOG_STAGES = ["all", "scout", "filter", "analyst", "executor", "risk", "system", "logger"] as const;
const RECAP_WINDOWS = ["12h", "24h", "7d", "reset"] as const;
const RECAP_LABELS: Record<(typeof RECAP_WINDOWS)[number], string> = {
  "12h": "12h",
  "24h": "24h",
  "7d": "7d",
  reset: "Since reset"
};

const STAGES = [
  ["01", "Scout", "scouted", "New pairs"],
  ["02", "Filter", "filteredKill", "Hard kills"],
  ["03", "Analyst", "analystTrade", "Scores ≥ line"],
  ["04", "Executor", "fills", "Paper fills"],
  ["05", "Risk", "riskExits", "Hard stops"],
  ["06", "Logger", "scouted", "Append-only"]
] as const;

const deskToken = rememberDeskToken();

/** Look-only feeds. These open the mint in a browser. They do not send a desk order. */
function chartLinks(mint: string): { label: string; href: string }[] {
  return [
    { label: "Chart", href: `https://dexscreener.com/solana/${mint}` },
    { label: "Birdeye", href: `https://birdeye.so/token/${mint}?chain=solana` },
    { label: "Jupiter", href: `https://jup.ag/tokens/${mint}` }
  ];
}

export function App() {
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [denied, setDenied] = useState(false);
  const [recap, setRecap] = useState<string | null>(null);
  const [recapWindow, setRecapWindow] = useState<(typeof RECAP_WINDOWS)[number]>("12h");
  const [recapError, setRecapError] = useState<string | null>(null);
  const [history, setHistory] = useState<FeedEvent[]>([]);
  const [stageFilter, setStageFilter] = useState<(typeof LOG_STAGES)[number]>("all");
  const [logError, setLogError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ mint: string; symbol: string } | null>(null);
  const [buySize, setBuySize] = useState("");
  const [buying, setBuying] = useState<string | null>(null);
  const [buyAsk, setBuyAsk] = useState<{
    mint: string;
    symbol: string;
    sizeUsd?: number;
    minutesLeft: number | null;
  } | null>(null);
  const [readyBusy, setReadyBusy] = useState(false);
  const [volumeText, setVolumeText] = useState("");
  const [scoreText, setScoreText] = useState("");
  const [top10Text, setTop10Text] = useState("");
  const [positionText, setPositionText] = useState("");
  const [defaultBuyText, setDefaultBuyText] = useState("");
  const [openText, setOpenText] = useState("");
  const [slipText, setSlipText] = useState("3");
  const [liqText, setLiqText] = useState("0");
  const [minAgeText, setMinAgeText] = useState("0");
  const [maxAgeText, setMaxAgeText] = useState("0");
  const [holdersText, setHoldersText] = useState("0");
  const [devText, setDevText] = useState("0");
  const [rateText, setRateText] = useState("0");
  const [lossText, setLossText] = useState("0");
  const [coolText, setCoolText] = useState("6");
  const [stopText, setStopText] = useState("6");
  const [armText, setArmText] = useState("12");
  const [gapText, setGapText] = useState("4");
  const [alertText, setAlertText] = useState("0");
  const [autoBuy, setAutoBuy] = useState(true);
  const [trailOn, setTrailOn] = useState(false);
  const [scoutDex, setScoutDex] = useState(true);
  const [scoutGecko, setScoutGecko] = useState(true);
  const [scoutJupiter, setScoutJupiter] = useState(true);
  const [scoutPaprika, setScoutPaprika] = useState(false);
  const [scoutBitquery, setScoutBitquery] = useState(true);
  const [notifyNear, setNotifyNear] = useState(true);
  const [notifyFills, setNotifyFills] = useState(true);
  const [notifyStops, setNotifyStops] = useState(true);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const [buyNotice, setBuyNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const rowsRef = useRef<HTMLDivElement>(null);
  const tapeRef = useRef<TapeFollowState>(initialTapeFollow);
  const [tape, setTape] = useState<TapeFollowState>(initialTapeFollow);
  const programmaticScroll = useRef(0);
  const viewAnchorRef = useRef<{ id: string; offset: number } | null>(null);
  const filterRef = useRef(stageFilter);
  const eventsRef = useRef<FeedEvent[]>([]);

  useEffect(() => {
    let stopped = false;
    const pull = async () => {
      try {
        const res = await fetch(withToken("/api/events?limit=800"), { headers: authHeaders() });
        if (!res.ok) throw new Error(`Log failed (${res.status})`);
        const body = (await res.json()) as { events?: FeedEvent[] };
        if (!stopped) {
          setHistory((prev) => mergeEvents(prev, body.events ?? []));
          setLogError(null);
        }
      } catch (err) {
        if (!stopped) setLogError(err instanceof Error ? err.message : "Log failed");
      }
    };
    void pull();
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (settingsDirty || !snap) return;
    setVolumeText(String(Math.round(snap.rules.minVolume1hUsd)));
    setScoreText(snap.rules.analystMinScore.toFixed(2));
    setTop10Text(String(Math.round(snap.rules.maxTop10Pct * 100)));
    setPositionText(String(Math.round(snap.rules.maxPositionPct * 1000) / 10));
    setDefaultBuyText(snap.prefs?.defaultBuyUsd == null ? "" : snap.prefs.defaultBuyUsd.toFixed(2));
    setOpenText(String(snap.prefs?.maxOpenPositions ?? 12));
    setSlipText(String(Math.round((snap.rules.maxEntrySlippage ?? 0.03) * 1000) / 10));
    const prefs = snap.prefs;
    setLiqText(String(prefs?.minLiquidityUsd ?? 0));
    setMinAgeText(String(prefs?.minTokenAgeMin ?? 0));
    setMaxAgeText(String(prefs?.maxTokenAgeMin ?? 0));
    setHoldersText(String(prefs?.minHolderCount ?? 0));
    setDevText(String(Math.round((prefs?.maxDevHoldingPct ?? 0) * 1000) / 10));
    setRateText(String(prefs?.maxTradesPerHour ?? 0));
    setLossText(String(prefs?.dailyMaxLossUsd ?? 0));
    setCoolText(String(prefs?.cooldownHours ?? Math.round(snap.rules.revengeCooldownMs / 3_600_000)));
    setStopText(String(Math.round(snap.rules.stopLossPct * 1000) / 10));
    setArmText(String(Math.round(snap.rules.trailArmPct * 1000) / 10));
    setGapText(String(Math.round(snap.rules.trailGapPct * 1000) / 10));
    setAlertText(String(prefs?.pnlAlertPct ?? 0));
    setAutoBuy(prefs?.autoBuy !== false);
    setTrailOn(prefs?.trailTakeProfit === true);
    setScoutDex(prefs?.scoutDexscreener !== false);
    setScoutGecko(prefs?.scoutGecko !== false);
    setScoutJupiter(prefs?.scoutJupiter !== false);
    setScoutPaprika(prefs?.scoutDexpaprika === true);
    setScoutBitquery(prefs?.scoutBitquery !== false);
    setNotifyNear(prefs?.notifyNearMiss !== false);
    setNotifyFills(prefs?.notifyFills !== false);
    setNotifyStops(prefs?.notifyStops !== false);
  }, [snap, settingsDirty, formEpoch]);

  const events = history.filter((event) => stageFilter === "all" || event.stage === stageFilter);
  eventsRef.current = events;
  const tapePaused = tape.held || tape.away;
  const tapeFresh = countNewSince(
    events.map((event) => event.id),
    tape.seenId,
    tapePaused
  );

  function applyTape(next: TapeFollowState) {
    const prev = tapeRef.current;
    tapeRef.current = next;
    if (prev.held !== next.held || prev.away !== next.away || prev.seenId !== next.seenId) setTape(next);
  }

  function captureViewAnchor(el: HTMLElement) {
    const top = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>("[data-event-id]");
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top + 1) {
        viewAnchorRef.current = { id: row.dataset.eventId || "", offset: box.top - top };
        return;
      }
    }
  }

  function restoreViewAnchor(el: HTMLElement) {
    const anchor = viewAnchorRef.current;
    if (!anchor?.id) return;
    const row = el.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(anchor.id)}"]`);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 1) assignScrollTop(el, el.scrollTop + delta);
  }

  function assignScrollTop(el: HTMLElement, top: number) {
    if (Math.abs(el.scrollTop - top) < 1) return;
    programmaticScroll.current += 1;
    el.scrollTop = top;
  }

  function noteUserScroll() {
    const el = rowsRef.current;
    if (!el) return;
    if (programmaticScroll.current > 0) {
      programmaticScroll.current -= 1;
      return;
    }
    const atLiveEdge = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    if (!atLiveEdge) captureViewAnchor(el);
    const ids = eventsRef.current.map((event) => event.id);
    const result = stepTapeFollow(tapeRef.current, {
      ids,
      userMoved: true,
      atLiveEdge,
      pause: false,
      goLive: false,
      filterChanged: false
    });
    applyTape(result.state);
    if (result.follow) {
      viewAnchorRef.current = null;
      assignScrollTop(el, el.scrollHeight);
    }
  }

  function pauseTape() {
    const el = rowsRef.current;
    if (el) captureViewAnchor(el);
    const result = stepTapeFollow(tapeRef.current, {
      ids: eventsRef.current.map((event) => event.id),
      userMoved: false,
      atLiveEdge: false,
      pause: true,
      goLive: false,
      filterChanged: false
    });
    applyTape(result.state);
  }

  function goLiveTape() {
    const el = rowsRef.current;
    const result = stepTapeFollow(tapeRef.current, {
      ids: eventsRef.current.map((event) => event.id),
      userMoved: false,
      atLiveEdge: true,
      pause: false,
      goLive: true,
      filterChanged: false
    });
    applyTape(result.state);
    viewAnchorRef.current = null;
    if (el) assignScrollTop(el, el.scrollHeight);
  }

  const eventKey = `${snap ? "1" : "0"}\0${stageFilter}\0${events.map((event) => event.id).join("\0")}`;
  useLayoutEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const ids = eventsRef.current.map((event) => event.id);
    const filterChanged = filterRef.current !== stageFilter;
    filterRef.current = stageFilter;
    const result = stepTapeFollow(tapeRef.current, {
      ids,
      userMoved: false,
      atLiveEdge: false,
      pause: false,
      goLive: false,
      filterChanged
    });
    applyTape(result.state);
    if (result.follow) {
      viewAnchorRef.current = null;
      assignScrollTop(el, el.scrollHeight);
    } else if (filterChanged) {
      viewAnchorRef.current = null;
    } else if (result.anchor) {
      restoreViewAnchor(el);
    }
  }, [eventKey, stageFilter]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    const apply = (data: DeskSnapshot) => {
      if (!stopped) {
        setSnap(data);
        setHistory((prev) => mergeEvents(prev, data.events));
        setOffline(false);
        setDenied(false);
      }
    };
    const pull = () => {
      fetch(withToken("/api/state"), { headers: authHeaders() })
        .then((res) => {
          if (res.status === 401) {
            setDenied(true);
            throw new Error("unauthorized");
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<DeskSnapshot>;
        })
        .then(apply)
        .catch(() => {
          if (!stopped) setOffline(true);
        });
    };
    pull();
    const poll = window.setInterval(pull, 2000);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${location.host}${withToken("/ws")}`;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as { type: string; data: DeskSnapshot };
        if (msg.type === "snapshot") apply(msg.data);
      };
      ws.onerror = () => setOffline(true);
    } catch {
      setOffline(true);
    }
    return () => {
      stopped = true;
      window.clearInterval(poll);
      ws?.close();
    };
  }, []);

  async function loadRecap(window: (typeof RECAP_WINDOWS)[number]) {
    setRecapError(null);
    try {
      const res = await fetch(withToken(`/api/recap?since=${window}`), { headers: authHeaders() });
      const raw = await res.text();
      let body: { text?: string; error?: string } | null = null;
      if (raw) {
        try {
          body = JSON.parse(raw) as { text?: string; error?: string };
        } catch {
          throw new Error(`Recap failed (HTTP ${res.status})`);
        }
      }
      if (!res.ok) {
        const detail = body?.error?.trim() || (res.status === 401 ? "Desk token missing or wrong." : "Recap failed");
        throw new Error(`${detail} (HTTP ${res.status})`);
      }
      setRecap(body?.text ?? "No recap text.");
    } catch (err) {
      setRecapError(err instanceof Error ? err.message : "Recap failed");
    }
  }

  async function saveUnlockedLp(allowUnlockedLp: boolean) {
    setLogError(null);
    try {
      const res = await fetch(withToken("/api/settings"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ allowUnlockedLp })
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `Settings update failed (${res.status})`);
      setBuyNotice({ ok: true, text: allowUnlockedLp ? "Unlocked LP is allowed. A lone miss still has to clear the trade line." : "Unlocked LP is a hard kill again." });
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Settings update failed");
    }
  }

  async function saveSettings() {
    setLogError(null);
    const payload = {
      minVolume1hUsd: Number(volumeText),
      analystMinScore: Number(scoreText),
      maxTop10Pct: Number(top10Text),
      maxPositionPct: Number(positionText),
      maxOpenPositions: Number(openText),
      maxEntrySlippage: Number(slipText),
      defaultBuyUsd: defaultBuyText.trim() === "" ? null : Number(defaultBuyText),
      minLiquidityUsd: Number(liqText),
      minTokenAgeMin: Number(minAgeText),
      maxTokenAgeMin: Number(maxAgeText),
      minHolderCount: Number(holdersText),
      maxDevHoldingPct: Number(devText),
      maxTradesPerHour: Number(rateText),
      dailyMaxLossUsd: Number(lossText),
      cooldownHours: Number(coolText),
      stopLossPct: Number(stopText),
      trailArmPct: Number(armText),
      trailGapPct: Number(gapText),
      pnlAlertPct: Number(alertText),
      trailTakeProfit: trailOn,
      autoBuy,
      scoutDexscreener: scoutDex,
      scoutGecko,
      scoutJupiter,
      scoutDexpaprika: scoutPaprika,
      scoutBitquery,
      notifyNearMiss: notifyNear,
      notifyFills,
      notifyStops
    };
    try {
      const res = await fetch(withToken("/api/settings"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; analystMinScore?: number };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `Settings update failed (${res.status})`);
      setSettingsDirty(false);
      const applied =
        typeof body.analystMinScore === "number" ? `Trade line set to ${body.analystMinScore.toFixed(2)}. ` : "";
      setBuyNotice({ ok: true, text: `${applied}Settings saved. The −6% hard stop is unchanged.` });
    } catch (err) {
      const text = err instanceof Error ? err.message : "Settings update failed";
      setLogError(text);
      setBuyNotice({ ok: false, text });
    }
  }

  async function resetBook() {
    if (snap?.mode !== "paper") return;
    const ok = window.confirm(
      "Reset the paper book to $100? Open positions are dropped and session PnL starts over. No order is sent. The log, advisor memory, and 1h volume floor stay. Live trading stays off."
    );
    if (!ok) return;
    setResetting(true);
    setLogError(null);
    try {
      const res = await fetch(withToken("/api/paper/reset"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ confirm: true })
      });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `Reset failed (${res.status})`);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  async function markReady(operatorReady: boolean) {
    setReadyBusy(true);
    setLogError(null);
    try {
      const res = await fetch(withToken("/api/live/ready"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ operatorReady })
      });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `Checklist update failed (${res.status})`);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Checklist update failed");
    } finally {
      setReadyBusy(false);
    }
  }

  function minutesLeftFor(mint: string): number | null {
    const row = snap?.cooldowns?.find((item) => item.mint === mint);
    if (!row || !(row.minutesLeft > 0)) return null;
    return row.minutesLeft;
  }

  async function postBuy(mint: string, symbol: string, sizeUsd: number | undefined, ignoreCooldown: boolean) {
    setBuying(mint);
    setLogError(null);
    try {
      const payload: { mint: string; sizeUsd?: number; ignoreCooldown?: boolean } = { mint };
      if (sizeUsd != null) payload.sizeUsd = sizeUsd;
      if (ignoreCooldown) payload.ignoreCooldown = true;
      const res = await fetch(withToken("/api/positions/buy"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        code?: string;
        symbol?: string;
        sizeUsd?: number;
        mode?: string;
        clampedFrom?: number;
      };
      if (body.code === "REVENGE_COOLDOWN" && !ignoreCooldown) {
        const parsed = /about (\d+) minute/.exec(body.error ?? "");
        setBuyAsk({
          mint,
          symbol: body.symbol || symbol,
          sizeUsd,
          minutesLeft: parsed ? Number(parsed[1]) : minutesLeftFor(mint)
        });
      }
      const text = formatBuyNotice(body.ok === false && !body.error ? { ...body, error: `Buy failed (${res.status})` } : body);
      setBuyNotice({ ok: body.ok === true && res.ok, text });
    } catch (err) {
      const text = err instanceof Error ? err.message : "Buy failed";
      setBuyNotice({ ok: false, text });
    } finally {
      setBuying(null);
    }
  }

  async function buyNearMiss(mint: string, symbol: string) {
    const open = snap?.positions.some((pos) => pos.mint === mint);
    if (open) {
      setBuyNotice({ ok: false, text: `${symbol} is already open. No add while that mint is open.` });
      return;
    }
    const minutesLeft = minutesLeftFor(mint);
    if (minutesLeft != null) {
      setBuyAsk({ mint, symbol, minutesLeft });
      return;
    }
    await postBuy(mint, symbol, undefined, false);
  }

  function buyMint() {
    if (!selected || !snap) return;
    const trimmed = buySize.trim();
    const sizeUsd = trimmed === "" ? undefined : Number(trimmed);
    if (sizeUsd !== undefined && (!(sizeUsd > 0) || !Number.isFinite(sizeUsd))) {
      const text = "Size must be a positive USD amount, or blank to use the position cap.";
      setBuyNotice({ ok: false, text });
      return;
    }
    const open = snap.positions.some((pos) => pos.mint === selected.mint);
    if (open) {
      const text = `${selected.symbol} is already open. No add while that mint is open.`;
      setBuyNotice({ ok: false, text });
      return;
    }
    setBuyAsk({
      mint: selected.mint,
      symbol: selected.symbol,
      sizeUsd,
      minutesLeft: minutesLeftFor(selected.mint)
    });
  }

  function confirmBuy() {
    if (!buyAsk) return;
    const ask = buyAsk;
    setBuyAsk(null);
    void postBuy(ask.mint, ask.symbol, ask.sizeUsd, ask.minutesLeft != null);
  }

  async function closeMint(mint: string, symbol: string) {
    if (!window.confirm(`Close ${symbol} at the mark? Winners leave only from this button. The hard stop still fires on its own.`)) return;
    setClosing(mint);
    try {
      const res = await fetch(withToken("/api/positions/close"), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ mint })
      });
      if (res.status === 401) throw new Error("Desk token missing or wrong.");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Close failed (${res.status})`);
      }
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Close failed");
    } finally {
      setClosing(null);
    }
  }

  async function loadEarlier() {
    const oldest = history[0]?.ts;
    if (!oldest) return;
    try {
      const res = await fetch(withToken(`/api/events?limit=800&before=${oldest}`), { headers: authHeaders() });
      if (!res.ok) throw new Error(`Log failed (${res.status})`);
      const body = (await res.json()) as { events?: FeedEvent[] };
      setHistory((prev) => mergeEvents(body.events ?? [], prev));
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Log failed");
    }
  }

  if (!snap) {
    return (
      <div className="loading">
        {denied
          ? "This desk is locked. Open it with ?token= and the DESK_TOKEN value."
          : offline
            ? "Night Desk is not answering on this port."
            : "Opening the book…"}
      </div>
    );
  }

  const maxKill = Math.max(1, ...Object.values(snap.killReasons));
  const capText = snap.positionCapUsd > 0 ? snap.positionCapUsd.toFixed(2) : "";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>
            NIGHT <span>DESK</span>
          </h1>
          <p>Solana memecoins · preservation before size · six hard handoffs</p>
        </div>
        {buyNotice ? (
          <div className={buyNotice.ok ? "buy-pin ok" : "buy-pin"} role="status">
            <span>{buyNotice.text}</span>
            <button className="ghost" type="button" onClick={() => setBuyNotice(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        <div className="metrics">
          <Metric
            label={snap.mode === "live" ? "Live cash" : "Paper cash"}
            value={usd(snap.cashUsd)}
            hint={`book ${usd(snap.startingBalanceUsd)}`}
          />
          <Metric label="Marked equity" value={usd(snap.equityUsd)} hint="cash + marks" />
          <Metric
            label="Session P&L"
            value={signedUsd(snap.sessionPnlUsd)}
            hint={signedPct(snap.sessionPnlPct)}
            tone={snap.sessionPnlUsd > 0 ? "up" : snap.sessionPnlUsd < 0 ? "down" : "flat"}
          />
          <Metric label="Open" value={String(snap.positions.length)} hint={`${snap.pipeline.filteredKill} filter kills`} />
        </div>
        <div className="mode">
          <div className={`lamp ${snap.mode}`} aria-label={`Trading mode ${snap.mode}`}>
            <i />
            {snap.mode === "live" ? "LIVE" : "PAPER"}
          </div>
          <div className="feed-note">
            {snap.feed.demo ? "Replay tape on" : "Replay off"}
            {" · "}
            {snap.feed.pumpConnected ? "Pump stream live" : "Pump stream quiet"}
            {snap.feed.dexLastPollAt ? " · DexScreener" : ""}
            {snap.feed.geckoLastPollAt ? " · Gecko pools" : ""}
            {snap.feed.jupiterLastPollAt ? " · Jupiter recent" : ""}
            {snap.feed.bitqueryLastPollAt ? " · Bitquery" : ""}
            {snap.feed.mode === "replay" ? " · feed locked to replay" : ""}
          </div>
        </div>
      </header>

      <aside className="rail">
        <p className="section-label">Pipeline</p>
        <div className="stages">
          {STAGES.map(([idx, name, key, hint]) => (
            <article className="stage" key={name}>
              <span className="idx">{idx}</span>
              <div>
                <b>{name}</b>
                <small>{hint}</small>
              </div>
              <span className="count">
                {name === "Logger" ? snap.events.length : snap.pipeline[key]}
              </span>
            </article>
          ))}
        </div>
        <div className="rules">
          <p>
            <strong>Hard lines.</strong> Mint revoked. LP locked once a pool exists; Pump curve mints skip that check. Top 10 ≤ {(snap.rules.maxTop10Pct * 100).toFixed(0)}% after curve and LP vaults are removed.
            Volume ≥ {usd(snap.rules.minVolume1hUsd, 0)} / hour. No known rug deployer. Analyst ≥ {snap.rules.analystMinScore.toFixed(2)}.
            Position ≤ {(snap.rules.maxPositionPct * 100).toFixed(0)}%. Hard stop −{(snap.rules.stopLossPct * 100).toFixed(0)}% from the fill.
            Winners are not auto-sold. Close them from the book. Peak is a hint.
            No adds. {Math.round(snap.rules.revengeCooldownMs / 3_600_000)}h ban after a hard stop.
          </p>
          <form
            className="volume-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSettings();
            }}
          >
            <label>
              Analyst trade line
              <input
                aria-label="Analyst trade line"
                inputMode="decimal"
                min={0.1}
                max={0.95}
                step={0.01}
                value={scoreText}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setScoreText(event.target.value);
                }}
              />
              <em>Score floor for a new buy (0.10–0.95)</em>
            </label>
            <label>
              Top 10 cap %
              <input
                aria-label="Top 10 holder cap percent"
                inputMode="decimal"
                min={5}
                max={35}
                step={1}
                value={top10Text}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setTop10Text(event.target.value);
                }}
              />
            </label>
            <label>
              1h volume floor
              <input
                aria-label="1h volume floor in dollars"
                inputMode="decimal"
                min={1000}
                max={500000}
                step={1000}
                value={volumeText}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setVolumeText(event.target.value);
                }}
              />
            </label>
            <label>
              Max entry slippage %
              <input
                aria-label="Max entry slippage percent"
                inputMode="decimal"
                min={0.5}
                max={3}
                step={0.1}
                value={slipText}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setSlipText(event.target.value);
                }}
              />
            </label>
            <label>
              Max position %
              <input
                aria-label="Max position percent"
                inputMode="decimal"
                min={1}
                max={8}
                step={0.5}
                value={positionText}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setPositionText(event.target.value);
                }}
              />
            </label>
            <label>
              Default buy USD
              <input
                aria-label="Default buy size in dollars"
                inputMode="decimal"
                placeholder="Cap"
                value={defaultBuyText}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setDefaultBuyText(event.target.value);
                }}
              />
            </label>
            <label>
              Max open
              <input
                aria-label="Max open positions"
                inputMode="numeric"
                min={1}
                max={24}
                step={1}
                value={openText}
                onChange={(event) => {
                  setSettingsDirty(true);
                  setOpenText(event.target.value);
                }}
              />
            </label>
            <label className="lp-toggle">
              <input
                type="checkbox"
                aria-label="Allow unlocked LP"
                checked={snap.prefs?.allowUnlockedLp !== false}
                onChange={(event) => {
                  void saveUnlockedLp(event.target.checked);
                }}
              />
              Allow unlocked LP
            </label>
            <label>
              Min liquidity $
              <input aria-label="Min liquidity in dollars" inputMode="decimal" min={0} max={500000} step={1000} value={liqText} onChange={(event) => { setSettingsDirty(true); setLiqText(event.target.value); }} />
            </label>
            <label>
              Min token age minutes
              <input aria-label="Min token age minutes" inputMode="numeric" min={0} max={10080} step={1} value={minAgeText} onChange={(event) => { setSettingsDirty(true); setMinAgeText(event.target.value); }} />
            </label>
            <label>
              Max token age minutes
              <input aria-label="Max token age minutes" inputMode="numeric" min={0} max={10080} step={1} value={maxAgeText} onChange={(event) => { setSettingsDirty(true); setMaxAgeText(event.target.value); }} />
            </label>
            <label>
              Min holder count
              <input aria-label="Min holder count" inputMode="numeric" min={0} max={10000} step={1} value={holdersText} onChange={(event) => { setSettingsDirty(true); setHoldersText(event.target.value); }} />
            </label>
            <label>
              Max dev holding %
              <input aria-label="Max dev holding percent" inputMode="decimal" min={0} max={100} step={1} value={devText} onChange={(event) => { setSettingsDirty(true); setDevText(event.target.value); }} />
            </label>
            <label>
              Max trades per hour
              <input aria-label="Max trades per hour" inputMode="numeric" min={0} max={60} step={1} value={rateText} onChange={(event) => { setSettingsDirty(true); setRateText(event.target.value); }} />
            </label>
            <label>
              Daily max loss $
              <input aria-label="Daily max loss in dollars" inputMode="decimal" min={0} max={100000} step={1} value={lossText} onChange={(event) => { setSettingsDirty(true); setLossText(event.target.value); }} />
            </label>
            <label>
              Per-mint cooldown hours
              <input aria-label="Per-mint cooldown hours" inputMode="numeric" min={6} max={72} step={1} value={coolText} onChange={(event) => { setSettingsDirty(true); setCoolText(event.target.value); }} />
            </label>
            <label>
              Hard stop %
              <input aria-label="Hard stop percent" inputMode="decimal" min={1} max={6} step={0.5} value={stopText} onChange={(event) => { setSettingsDirty(true); setStopText(event.target.value); }} />
            </label>
            <label>
              Trail arm %
              <input aria-label="Trail arm percent" inputMode="decimal" min={12} max={80} step={1} value={armText} onChange={(event) => { setSettingsDirty(true); setArmText(event.target.value); }} />
            </label>
            <label>
              Trail gap %
              <input aria-label="Trail gap percent" inputMode="decimal" min={0.5} max={4} step={0.5} value={gapText} onChange={(event) => { setSettingsDirty(true); setGapText(event.target.value); }} />
            </label>
            <label>
              PnL alert %
              <input aria-label="PnL alert percent" inputMode="decimal" min={0} max={50} step={1} value={alertText} onChange={(event) => { setSettingsDirty(true); setAlertText(event.target.value); }} />
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Auto-buy" checked={autoBuy} onChange={(event) => { setSettingsDirty(true); setAutoBuy(event.target.checked); }} />
              Auto-buy
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Trailing take profit" checked={trailOn} onChange={(event) => { setSettingsDirty(true); setTrailOn(event.target.checked); }} />
              Trailing take profit
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Scout Pump" checked disabled />
              Scout Pump (always on)
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Scout DexScreener" checked={scoutDex} onChange={(event) => { setSettingsDirty(true); setScoutDex(event.target.checked); }} />
              Scout DexScreener
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Scout Gecko" checked={scoutGecko} onChange={(event) => { setSettingsDirty(true); setScoutGecko(event.target.checked); }} />
              Scout Gecko
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Scout Jupiter" checked={scoutJupiter} onChange={(event) => { setSettingsDirty(true); setScoutJupiter(event.target.checked); }} />
              Scout Jupiter
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Scout DexPaprika" checked={scoutPaprika} onChange={(event) => { setSettingsDirty(true); setScoutPaprika(event.target.checked); }} />
              Scout DexPaprika / Meteora
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Scout Bitquery" checked={scoutBitquery} onChange={(event) => { setSettingsDirty(true); setScoutBitquery(event.target.checked); }} />
              Scout Bitquery
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Notify near misses" checked={notifyNear} onChange={(event) => { setSettingsDirty(true); setNotifyNear(event.target.checked); }} />
              Notify near misses
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Notify fills" checked={notifyFills} onChange={(event) => { setSettingsDirty(true); setNotifyFills(event.target.checked); }} />
              Notify fills
            </label>
            <label className="lp-toggle">
              <input type="checkbox" aria-label="Notify stops" checked={notifyStops} onChange={(event) => { setSettingsDirty(true); setNotifyStops(event.target.checked); }} />
              Notify stops
            </label>
            {settingsDirty ? <p className="hard-stop">Unsaved changes</p> : null}
            <p className="hard-stop">
              Hard stop −{(snap.rules.stopLossPct * 100).toFixed(0)}% from the fill. It stays fixed. Entry slippage cap{" "}
              {((snap.rules.maxEntrySlippage ?? 0.03) * 100).toFixed(2)}%. A quote above that cap is refused. Mint authority and dev rugs stay hard kills.
            </p>
            <button className="ghost" type="submit">
              Apply
            </button>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                setSettingsDirty(false);
                setFormEpoch((n) => n + 1);
              }}
            >
              Reset
            </button>
          </form>
        </div>
      </aside>

      <main className="tape">
        <section className="advice" aria-label="Advisor">
          <header>
            <h2>Advisor</h2>
            <span>Learns from the book · never places a trade</span>
          </header>
          {(snap.advice ?? []).length === 0 ? (
            <p className="empty">Watching kills, fills, and open marks. Hard stop still fires on its own. Take profit with Close.</p>
          ) : (
            (snap.advice ?? []).map((note) => (
              <AdviceRow key={note.id} note={note} onBuy={(mint, symbol) => void buyNearMiss(mint, symbol)} />
            ))
          )}
        </section>
        <div className="tape-head">
          <h2>Activity log</h2>
          <div className="tape-tools">
            <button className={`live-toggle${tapePaused ? " on" : ""}`} type="button" onClick={() => (tapePaused ? goLiveTape() : pauseTape())}>
              {tapePaused ? "Live" : "Pause"}
            </button>
            <div className="recap-windows" role="group" aria-label="Recap window">
            {RECAP_WINDOWS.map((window) => (
              <button
                key={window}
                type="button"
                className={recapWindow === window ? "on" : ""}
                onClick={() => {
                  setRecapWindow(window);
                  if (recap || recapError) void loadRecap(window);
                }}
              >
                {RECAP_LABELS[window]}
              </button>
            ))}
            <button className="ghost" type="button" onClick={() => void loadRecap(recapWindow)}>
              {recap ? "Refresh recap" : "Recap"}
            </button>
            </div>
          </div>
        </div>
        <div className="filters" role="tablist" aria-label="Log stage">
          {LOG_STAGES.map((stage) => (
            <button
              key={stage}
              type="button"
              className={stageFilter === stage ? "on" : ""}
              onClick={() => setStageFilter(stage)}
            >
              {stage}
            </button>
          ))}
        </div>
        <LiveReadyCard readiness={snap.readiness} busy={readyBusy} onReady={(ready) => void markReady(ready)} />
        {snap.armError ? <div className="banner">{snap.armError}</div> : null}
        {offline ? <div className="banner">Live socket dropped. Polling the book until it returns.</div> : null}
        {snap.feed.lastError ? <div className="banner">Feed: {snap.feed.lastError}</div> : null}
        {recapError ? <div className="banner">{recapError}</div> : null}
        {logError ? <div className="banner">{logError}</div> : null}
        {recap ? <pre className="recap">{recap}</pre> : null}
        <form
          className="buybar"
          onSubmit={(event) => {
            event.preventDefault();
            void buyMint();
          }}
        >
          {selected ? (
            <>
              <label>
                Buy {selected.symbol}
                <input
                  aria-label="Manual size in dollars"
                  inputMode="decimal"
                placeholder={capText ? `Cap ${capText}` : "USD cap"}
                value={buySize}
                  onChange={(event) => setBuySize(event.target.value)}
                />
              </label>
              <button className="ghost buy" type="submit" disabled={buying === selected.mint}>
                {buying === selected.mint ? "Buying" : "Buy"}
              </button>
              <button className="ghost" type="button" onClick={() => setSelected(null)}>
                Clear
              </button>
            </>
          ) : (
            <p className="empty">
              Select a mint on the tape to buy. The size starts at the current cap{capText ? ` ($${capText})` : ""}. A larger request is filled at the cap. No add while that mint is open.
            </p>
          )}
        </form>
        <div className="rows-wrap">
          <div
            className="rows"
            aria-live="polite"
            ref={rowsRef}
            onScroll={() => noteUserScroll()}
          >
            <button className="ghost earlier" type="button" onClick={() => void loadEarlier()}>
              Load earlier
            </button>
            {events.length === 0 ? (
              <p className="empty">No lines for this filter. The desk log on disk keeps every stage across restarts.</p>
            ) : (
              events.map((event) => (
                <Row
                  key={event.id}
                  event={event}
                  selected={selected?.mint === event.mint}
                  onSelect={
                    event.mint
                      ? () => {
                          setSelected({ mint: event.mint!, symbol: event.symbol ?? event.mint!.slice(0, 4) });
                          setBuySize(capText);
                        }
                      : undefined
                  }
                />
              ))
            )}
          </div>
          {tapePaused ? (
            <button className="jump" type="button" onClick={() => goLiveTape()}>
              {pausedLabel(tapeFresh)}
            </button>
          ) : null}
        </div>
      </main>

      <aside className="side">
        <section className="chart-card">
          <header>
            <h3>Equity</h3>
            <span className={snap.sessionPnlUsd >= 0 ? "up" : "down"}>{signedUsd(snap.sessionPnlUsd)}</span>
            {snap.mode === "paper" ? (
              <button className="ghost reset" type="button" disabled={resetting} onClick={() => void resetBook()}>
                {resetting ? "Resetting" : "Reset book"}
              </button>
            ) : null}
          </header>
          <EquityChart points={snap.equity} baseline={snap.startingBalanceUsd} />
        </section>

        <section className="card">
          <header>
            <h3>Open positions</h3>
            <span>{snap.positions.length ? `${snap.positions.length} live` : "flat"}</span>
          </header>
          {snap.positions.length === 0 ? (
            <p className="empty">Flat. A name has to clear every hard filter and score at least {snap.rules.analystMinScore.toFixed(2)}.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>uPnL</th>
                  <th>Stop</th>
                </tr>
              </thead>
              <tbody>
                {snap.positions.map((pos) => (
                  <tr key={pos.mint}>
                    <td>
                      <span className="sym">{pos.symbol}</span>
                      <span className="sub">
                        {pos.entry === "manual" ? "Manual buy" : pos.source} · score {pos.score.toFixed(2)}
                        {pos.lpUnlocked ? " · LP unlocked" : ""} · mark {markAge(pos.markAgeMs)} · peak {px(pos.peakPrice)}
                        {pos.trailHintPrice != null ? ` · hint ${px(pos.trailHintPrice)}` : ""}
                      </span>
                      <span className="pos-actions">
                        {chartLinks(pos.mint).map((link) => (
                          <a
                            key={link.label}
                            className="ghost"
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {link.label}
                          </a>
                        ))}
                      </span>
                    </td>
                    <td className={pos.pnlUsd >= 0 ? "up" : "down"}>
                      {signedUsd(pos.pnlUsd)}
                      <span className="sub">{signedPct(pos.pnlPct)}</span>
                    </td>
                    <td>
                      {px(pos.stopPrice)}
                      <span className="sub">hard stop · entry {px(pos.entryPrice)}</span>
                      <button
                        className="ghost close"
                        type="button"
                        disabled={closing === pos.mint}
                        onClick={() => void closeMint(pos.mint, pos.symbol)}
                      >
                        {closing === pos.mint ? "Closing" : "Close"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <header>
            <h3>Recent trades</h3>
            <span>{snap.closed.length}</span>
          </header>
          {snap.closed.length === 0 ? (
            <p className="empty">No realized trades yet. Hard stops and manual closes land here.</p>
          ) : (
            <table>
              <tbody>
                {[...snap.closed].reverse().slice(0, 20).map((trade) => (
                  <tr key={trade.id}>
                    <td>
                      <span className="sym">{trade.symbol}</span>
                      <span className="sub">
                        entry {px(trade.entryPrice ?? 0)} → exit {px(trade.exitPrice ?? 0)} · {trade.exitCode} · {clock(trade.closedAt)}
                      </span>
                    </td>
                    <td className={trade.pnlUsd >= 0 ? "up" : "down"}>
                      {signedUsd(trade.pnlUsd)}
                      <span className="sub">{signedPct(trade.pnlPct)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <KillList reasons={snap.killReasons} max={maxKill} />
      </aside>
      {buyAsk ? (
        <div className="modal-back" role="presentation">
          <div className="modal" role="dialog" aria-labelledby="buy-title">
            <h2 id="buy-title">{buyAsk.minutesLeft != null ? `Buy ${buyAsk.symbol} anyway?` : `Buy ${buyAsk.symbol}?`}</h2>
            <p>
              {buyAsk.sizeUsd == null
                ? snap.positionCapUsd > 0
                  ? `Size uses the position cap (${usd(snap.positionCapUsd)}).`
                  : "Size uses the position cap."
                : `Size ${usd(buyAsk.sizeUsd)}. A larger number is filled at the cap.`}{" "}
              {snap.mode === "live"
                ? "The desk is already live, so this sends a real swap."
                : "Paper fill only. This does not turn on live trading."}
            </p>
            {buyAsk.minutesLeft != null ? (
              <p className="ban">
                Mint is banned after a hard stop. Cooldown has about {buyAsk.minutesLeft} minute(s) left. Auto buys stay blocked.
              </p>
            ) : null}
            <div className="modal-actions">
              <button className="ghost" type="button" onClick={() => setBuyAsk(null)}>
                Cancel
              </button>
              <button className="ghost buy" type="button" onClick={confirmBuy}>
                {buyAsk.minutesLeft != null ? "Buy anyway" : "Buy"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, hint, tone = "flat" }: { label: string; value: string; hint: string; tone?: "up" | "down" | "flat" }) {
  return (
    <div className="metric">
      <label>{label}</label>
      <strong className={tone}>{value}</strong>
      <em>{hint}</em>
    </div>
  );
}

function AdviceRow({ note, onBuy }: { note: AdviceNote; onBuy: (mint: string, symbol: string) => void }) {
  return (
    <article className="advice-row">
      <span className={`stance ${note.stance}`}>{note.stance}</span>
      <div>
        <p>{note.text}</p>
        {note.stance === "near-miss" && note.mint ? (
          <button className="ghost" type="button" onClick={() => onBuy(note.mint!, note.symbol || "this mint")}>
            Buy
          </button>
        ) : null}
      </div>
    </article>
  );
}

function LiveReadyCard({
  readiness,
  busy,
  onReady
}: {
  readiness: LiveReadiness;
  busy: boolean;
  onReady: (ready: boolean) => void;
}) {
  return (
    <section className="ready" aria-label="Live ready">
      <header>
        <h2>Live ready</h2>
        <span>{readiness.mode === "live" ? "LIVE" : "STILL PAPER"}</span>
      </header>
      <ul>
        {readiness.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <label className="ready-check">
        <input
          type="checkbox"
          checked={readiness.operatorReady}
          disabled={busy}
          onChange={(event) => onReady(event.target.checked)}
        />
        Mark checklist ready
      </label>
      <p>
        This note does not enable live trading and does not save a Phantom seed or private key. The trading keypair stays in WALLET_KEYPAIR_PATH on the Austin desk host. Night Desk has no wallet vault.
      </p>
    </section>
  );
}

function Row({ event, selected, onSelect }: { event: FeedEvent; selected: boolean; onSelect?: () => void }) {
  return (
    <article className={`row ${event.kind}${selected ? " selected" : ""}`} data-event-id={event.id}>
      <time className="when">{clock(event.ts)}</time>
      <span className={`tag ${event.stage}`}>{event.stage}</span>
      <div className="msg">
        {event.code ? <code>{event.code}</code> : null} {event.code ? "· " : null}
        {event.message}
        {event.detail ? <span className="detail"> · {event.detail}</span> : null}
        {onSelect ? (
          <button className="ghost select" type="button" onClick={onSelect}>
            {selected ? "Selected" : "Select"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function EquityChart({ points, baseline }: { points: { t: number; equity: number }[]; baseline: number }) {
  const path = useMemo(() => {
    const series = points.length ? points : [{ t: 0, equity: baseline }];
    const values = series.map((p) => p.equity);
    const min = Math.min(baseline, ...values);
    const max = Math.max(baseline, ...values);
    const span = max - min || 1;
    const w = 320;
    const h = 112;
    const coords = series.map((point, index) => {
      const x = series.length === 1 ? w / 2 : (index / (series.length - 1)) * w;
      const y = h - ((point.equity - min) / span) * (h - 16) - 8;
      return [x, y] as const;
    });
    const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
    const area = `${line} L${w},${h} L0,${h} Z`;
    const last = coords[coords.length - 1] ?? [0, h / 2];
    return { line, area, last, up: (series[series.length - 1]?.equity ?? baseline) >= baseline };
  }, [points, baseline]);

  return (
    <svg viewBox="0 0 320 112" role="img" aria-label="Equity curve">
      <defs>
        <linearGradient id="eq" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={path.up ? "#8dface" : "#ff6a45"} stopOpacity="0.35" />
          <stop offset="100%" stopColor={path.up ? "#8dface" : "#ff6a45"} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={path.area} fill="url(#eq)" />
      <path d={path.line} fill="none" stroke={path.up ? "#dff25a" : "#ff6a45"} strokeWidth="2" />
      <circle cx={path.last[0]} cy={path.last[1]} r="3.5" fill="#e7f0d8" />
    </svg>
  );
}

function KillList({ reasons, max }: { reasons: Record<string, number>; max: number }) {
  const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  return (
    <section className="card">
      <header>
        <h3>Filter kills</h3>
        <span>{entries.reduce((sum, [, n]) => sum + n, 0)}</span>
      </header>
      {entries.length === 0 ? (
        <p className="empty">No kills yet.</p>
      ) : (
        <div className="kills">
          {entries.map(([code, count]) => (
            <div key={code}>
              <div className="kill">
                <span>{code}</span>
                <span>{count}</span>
              </div>
              <div className="bar">
                <span style={{ width: `${(count / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function usd(n: number, digits = 2): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function signedUsd(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${usd(Math.abs(n))}`;
}

function signedPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n * 100).toFixed(2)}%`;
}

function px(n: number): string {
  if (!(n > 0)) return "—";
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function mergeEvents(current: FeedEvent[], incoming: FeedEvent[]): FeedEvent[] {
  const map = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) map.set(event.id, event);
  return [...map.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

function markAge(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function rememberDeskToken(): string {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    sessionStorage.setItem("night-desk-token", fromUrl);
    params.delete("token");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
    return fromUrl;
  }
  return sessionStorage.getItem("night-desk-token") ?? "";
}

function withToken(path: string): string {
  const url = new URL(path, location.origin);
  if (deskToken && !url.searchParams.has("token")) url.searchParams.set("token", deskToken);
  return `${url.pathname}${url.search}`;
}

function authHeaders(): HeadersInit {
  return deskToken ? { "X-Desk-Token": deskToken } : {};
}
