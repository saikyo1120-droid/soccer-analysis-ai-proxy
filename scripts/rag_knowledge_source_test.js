/**
 * Unit tests for the pure formatting functions in server/rag/knowledgeSource.js
 * (summarizeRecentForm / summarizeInjuries / summarizeTransfers) — no network,
 * no server. These are the functions that turn raw API-Football shapes into the
 * structured facts the discuss endpoint's confidence scoring and prompt-building
 * rely on, so it's worth locking their behavior down directly.
 */
const path = require("path");
const { summarizeRecentForm, summarizeInjuries, summarizeTransfers } = require(path.join(__dirname, "..", "server", "rag", "knowledgeSource.js"));

let failures = 0;
const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

// ---- summarizeRecentForm ----
{
  const teamId = 541;
  const fixtures = [
    { fixture: { id: 1, date: "2026-07-01T00:00:00Z" }, league: { name: "La Liga" }, teams: { home: { id: 541, name: "Real Madrid" }, away: { id: 2, name: "Sevilla" } }, goals: { home: 2, away: 1 } },
    { fixture: { id: 2, date: "2026-07-10T00:00:00Z" }, league: { name: "La Liga" }, teams: { home: { id: 2, name: "Valencia" }, away: { id: 541, name: "Real Madrid" } }, goals: { home: 1, away: 1 } },
  ];
  const out = summarizeRecentForm(fixtures, teamId);
  ok(out.length === 2, "returns one entry per fixture");
  ok(out[0].date === "2026-07-10T00:00:00Z", "sorted newest-first, got " + out[0].date);
  ok(out[1].homeAway === "ホーム" && out[1].result === "勝ち" && out[1].opponent === "Sevilla", "home win correctly attributed, got " + JSON.stringify(out[1]));
  ok(out[0].homeAway === "アウェイ" && out[0].result === "分け" && out[0].opponent === "Valencia", "away draw correctly attributed, got " + JSON.stringify(out[0]));
}

// ---- summarizeInjuries ----
{
  const raw = [
    { player: { name: "A", type: "Injury", reason: "Knee" }, fixture: { date: "2026-07-01T00:00:00Z" } },
    { player: { name: "A", type: "Injury", reason: "Knee (recovering)" }, fixture: { date: "2026-07-15T00:00:00Z" } }, // newer record for same player
    { player: { name: "B", type: "Suspended", reason: "Red card" }, fixture: { date: "2026-07-05T00:00:00Z" } },
  ];
  const out = summarizeInjuries(raw, 8);
  ok(out.length === 2, "dedupes by player name, got " + out.length);
  ok(out[0].playerName === "A" && out[0].reason === "Knee (recovering)", "keeps the MOST RECENT record per player, got " + JSON.stringify(out[0]));
}

// ---- summarizeTransfers ----
{
  const teamId = 541;
  const since = new Date("2026-01-01T00:00:00Z");
  const raw = [
    { player: { name: "In Player" }, transfers: [{ date: "2026-06-01", type: "Free", teams: { in: { id: 541, name: "Real Madrid" }, out: { id: 2, name: "Old Club" } } }] },
    { player: { name: "Out Player" }, transfers: [{ date: "2026-05-01", type: "Loan", teams: { in: { id: 3, name: "New Club" }, out: { id: 541, name: "Real Madrid" } } }] },
    { player: { name: "Unrelated" }, transfers: [{ date: "2026-06-15", type: "Free", teams: { in: { id: 9, name: "X" }, out: { id: 8, name: "Y" } } }] },
    { player: { name: "TooOld" }, transfers: [{ date: "2025-01-01", type: "Free", teams: { in: { id: 541, name: "Real Madrid" }, out: { id: 2, name: "Old Club" } } }] },
  ];
  const out = summarizeTransfers(raw, teamId, 8, since);
  ok(out.length === 2, "filters to only this team's transfers within the date window, got " + out.length);
  ok(out[0].playerName === "In Player" && out[0].direction === "加入", "newest-first, correctly labels an incoming transfer, got " + JSON.stringify(out[0]));
  ok(out[1].playerName === "Out Player" && out[1].direction === "退団", "correctly labels an outgoing transfer, got " + JSON.stringify(out[1]));
}

console.log(failures === 0 ? "\nRAG knowledge source unit tests PASSED." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
