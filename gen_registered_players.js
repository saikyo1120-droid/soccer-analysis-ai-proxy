/**
 * server/learning/registeredPlayers.js を index.html の PLAYERS から再生成する
 * スクリプト(2026年8月・優先順位⑦)。
 *
 * index.html 側の選手データベースに選手を追加/削除したときは、
 *   node scripts/gen_registered_players.js
 * を実行すれば、日次更新の対象一覧も追従します(手で二重管理しないため)。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function extractPlayersObject(html) {
  const start = html.indexOf("const PLAYERS = {");
  if (start === -1) throw new Error("index.html に `const PLAYERS = {` が見つかりません");
  const objStart = html.indexOf("{", start);
  let depth = 0;
  let inStr = null;
  for (let i = objStart; i < html.length; i++) {
    const c = html[i];
    const prev = html[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        // eslint-disable-next-line no-eval
        return eval("(" + html.slice(objStart, i + 1) + ")");
      }
    }
  }
  throw new Error("PLAYERS オブジェクトの終端を特定できませんでした");
}

const CONTRACT_TYPE_JA = { free: "フリー移籍", transfer: "完全移籍", loan: "レンタル" };

function main() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const PLAYERS = extractPlayersObject(html);
  const rows = Object.keys(PLAYERS).map((key) => {
    const p = PLAYERS[key];
    const c = p.contract || {};
    const contractNote = [
      c.type ? (CONTRACT_TYPE_JA[c.type] || c.type) : null,
      c.fromClub ? `前所属:${c.fromClub}` : null,
      c.date || null,
    ].filter(Boolean).join("・");
    return {
      key,
      nameJa: p.nameJa,
      nameEn: p.name,
      clubJa: p.club,
      staticFoot: p.foot || null,
      staticContractNote: contractNote || null,
    };
  });

  const header = `/**
 * server/learning/registeredPlayers.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑦「選手情報を毎日更新」で使う、日次更新の対象選手一覧。
 *
 * 新しく発明したリストではなく、index.html の PLAYERS(アプリが元々持っている
 * 手動キュレーション済みの選手データベース、${rows.length}名)から
 * key / 日本語名 / 英語名 / 所属クラブ を機械的に写したものです
 * (scripts/gen_registered_players.js で再生成できます)。
 *
 * staticFoot / staticContractNote について:
 *   利き足と契約情報は API-Football の /players レスポンスに存在しません
 *   (player オブジェクトは id/name/age/birth/nationality/height/weight/
 *   injured/photo のみ。server/learning/playerFeatures.js の冒頭に既に
 *   確認済みとして記録されています)。つまり「毎日APIから更新する」ことが
 *   構造的に不可能な項目です。ただしアプリ内には手動登録された値が存在するため、
 *   「APIからは更新できないが、アプリが持っている手動データではこうなっている」
 *   と正直に併記できるよう、ここに写しています(手動データのため最新性は
 *   保証されません)。
 */
const REGISTERED_PLAYERS = [
`;
  const body = rows.map((r) => "  " + JSON.stringify(r)).join(",\n");
  const footer = `
];

module.exports = { REGISTERED_PLAYERS };
`;
  const outPath = path.join(ROOT, "server", "learning", "registeredPlayers.js");
  fs.writeFileSync(outPath, header + body + footer);
  console.log(`registeredPlayers.js を再生成しました(${rows.length}名)`);
}

main();
