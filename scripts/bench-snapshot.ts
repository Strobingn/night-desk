/**
 * Measures what one desk snapshot costs after a long run: the equity table grows by one row
 * every 2 s, so a desk that has been up for a day has ~43k rows behind every push.
 *
 *   npx tsx scripts/bench-snapshot.ts [hoursUp=24] [events=5000]
 */
import { performance } from "node:perf_hooks";
import { Desk } from "../src/desk/orchestrator.js";
import { testConfig } from "../test/helpers.js";

const hours = Number(process.argv[2] ?? 24);
const eventCount = Number(process.argv[3] ?? 5_000);
const desk = new Desk(testConfig());
const startedAt = Date.now() - hours * 3_600_000;
(desk as unknown as { startedAt: number }).startedAt = startedAt;
const rows = Math.floor((hours * 3_600_000) / 2_000);
const insert = desk.store.db.prepare(`INSERT INTO equity (ts, equity_usd, cash_usd) VALUES (?, ?, ?)`);
desk.store.db.exec("BEGIN");
for (let i = 0; i < rows; i += 1) insert.run(startedAt + i * 2_000, 100 + Math.sin(i / 50), 60);
desk.store.db.exec("COMMIT");
for (let i = 0; i < eventCount; i += 1) {
  desk.store.appendEvent({ id: `e${i}`, ts: startedAt + i * 1_000, stage: "scout", kind: "info", message: `event ${i}` }, null);
}
// Let the desk see the rows the way a restarted desk would (13.32 loads the window once at start).
const win = (desk as unknown as { equityWindow?: { load(rows: unknown[]): void } }).equityWindow;
win?.load(desk.store.equitySince(startedAt));
const N = 50;
const t0 = performance.now();
let bytes = 0;
for (let i = 0; i < N; i += 1) bytes = JSON.stringify(desk.snapshot()).length;
const per = (performance.now() - t0) / N;
console.log(`${rows} equity rows, ${eventCount} events: snapshot+stringify ${per.toFixed(1)} ms each, ${(bytes / 1024).toFixed(0)} KB`);
desk.stop();
