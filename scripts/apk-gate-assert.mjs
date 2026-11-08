import { readFileSync } from "node:fs";

const httpLog = process.argv[2] ?? "/tmp/nd-gate/http.jsonl";
const swapLog = process.argv[3] ?? "/tmp/nd-gate/swaps.jsonl";
const http = readFileSync(httpLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const swaps = readFileSync(swapLog, "utf8").trim() === "" ? [] : readFileSync(swapLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));

function bodyOf(row) {
  if (!row.body) return null;
  try {
    return JSON.parse(row.body);
  } catch {
    return null;
  }
}

const buys = http.filter((row) => row.method === "POST" && row.url === "/api/positions/buy").map(bodyOf).filter(Boolean);
const sells = http.filter((row) => row.method === "POST" && row.url === "/api/positions/sell").map(bodyOf).filter(Boolean);
const paperTaps = buys.filter((b) => b.book === "paper" && b.oneTap === true);
const paperDialogs = buys.filter((b) => b.book === "paper" && b.oneTap !== true);
const live = buys.filter((b) => b.book === "live");
const problems = [];
if (paperTaps.length < 1) problems.push("no one-tap paper buy body");
if (paperDialogs.length < 1) problems.push("no Buy… paper body");
if (buys.some((b) => b.book !== "paper" && b.book !== "live")) problems.push("buy missing an explicit book");
if (sells.length < 2) problems.push(`expected two paper sells, saw ${sells.length}`);
if (sells.some((s) => s.book === "live")) problems.push("a sell was marked live");
if (live.length < 3) problems.push(`expected 3 live buy bodies, saw ${live.length}`);
if (swaps.length !== 1) problems.push(`expected 1 hung mock swap, saw ${swaps.length}`);
if (live.length >= 3) {
  const [first, second, third] = live;
  if (!first.idemKey || first.idemKey === second.idemKey) problems.push("the not-ready live tap reused the later idempotency key");
  if (!second.idemKey || second.idemKey !== third.idemKey) problems.push("the timed-out live tap did not reuse its idempotency key");
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(JSON.stringify({ buys, sells, swaps }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  paperTaps: paperTaps.length,
  paperDialogs: paperDialogs.length,
  sells: sells.length,
  liveIdem: live.map((b) => b.idemKey),
  swaps: swaps.length
}));
