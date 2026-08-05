/**
 * scripts/audit7_regression_test.js
 * ------------------------------------------------
 * 2026年8月・第7次監査で発見した欠陥に対する回帰テスト。
 *
 * 第7次監査は、それまでの6回が見ていなかった領域
 * (LLMプロンプト層・同時実行・キャッシュ・時差・質問の振り分け・入力検証)を
 * 対象にしました。その結果、このプロジェクトで最も深刻な「でっち上げ」
 * ——登録していない別のクラブについて聞かれたのに、名前の一部が一致する
 * 登録クラブの実データで、★5の自信度をつけて答えていた——が見つかりました。
 *
 * 実行方法: node scripts/audit7_regression_test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const SERVER = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");

let failures = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// index.html の中の関数を、単体で評価できるように取り出すヘルパー
function extractFn(name) {
  const re = new RegExp("function " + name + "\\([\\s\\S]*?\\n}", "m");
  const m = HTML.match(re);
  if (!m) throw new Error("index.html に " + name + " が見つかりません");
  return m[0];
}
function extractConst(name) {
  const re = new RegExp("const " + name + "\\s*=[\\s\\S]*?\\n\\];", "m");
  const m = HTML.match(re);
  if (!m) throw new Error("index.html に " + name + " が見つかりません");
  return m[0];
}

// =====================================================================
// ① 最重要: 別のクラブについて答えてしまう
// =====================================================================

test("★欠陥58: 登録していないクラブの質問に、名前が似た登録クラブの実データで答えない", () => {
  // 【この欠陥が実際にしていたこと】
  //   クラブ名を「トークンが1つでも含まれていれば一致」で判定していたため、
  //     「マンチェスター・ユナイテッドはなぜ弱くなった?」→ マンチェスター・シティ
  //     「インテル・ミランは今季どう?」            → インテル・マイアミ
  //     「レアル・ベティスはどう思う?」            → レアル・マドリード
  //   と解決され、**まったく別のクラブの実データ**で回答していた。
  //   しかも取得自体は成功するので自信度は★4〜5、根拠も「実データ」として提示され、
  //   画面のどこにも「どのクラブとして答えたか」は出なかった。
  //   このプロジェクトで最悪の「でっち上げ」経路。
  const sandbox = {
    PLAYERS: {
      a: { club: "マンチェスター・シティ" }, b: { club: "マンチェスター・シティ" },
      c: { club: "インテル・マイアミ" }, d: { club: "レアル・マドリード" },
      e: { club: "レアル・マドリード" }, f: { club: "FCバルセロナ" },
    },
    clubBase: (p) => p.club,
  };
  const code = extractFn("normalizeName") + "\n" + extractFn("detectClubMention")
    + "\nmodule.exports = { detectClubMention };";
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "PLAYERS", "clubBase", code)(mod, sandbox.PLAYERS, sandbox.clubBase);
  const { detectClubMention } = mod.exports;

  assert.strictEqual(detectClubMention("マンチェスター・ユナイテッドはなぜ弱くなったと思う？"), null,
    "登録していないクラブを、登録クラブとして答えてはいけない");
  assert.strictEqual(detectClubMention("インテル・ミランは今季どう思う？"), null);
  assert.strictEqual(detectClubMention("レアル・ベティスはどう思う？"), null);
  // 正しく動く場合(既存機能を壊していない)
  assert.strictEqual(detectClubMention("マンチェスター・シティはどう？"), "マンチェスター・シティ");
  assert.strictEqual(detectClubMention("レアルはなぜ強い？"), "レアル・マドリード", "短縮形はこれまで通り通るべき");
  assert.strictEqual(detectClubMention("FCバルセロナの弱点は？"), "FCバルセロナ");
});

test("★欠陥59: 戦術用語やリーグ名を選手名として検索しない", () => {
  // 【この欠陥が実際にしていたこと】
  //   「カタカナが2文字以上あれば選手名」という判定のため、
  //     「ハイプレスは本当に有効だと思う?」→ 選手名「ハイプレス」
  //     「プレミアリーグとラ・リーガ、どっちがレベル高い?」→ 選手名「プレミアリーグ」
  //   となり、存在しない選手を探して1回あたり最大21〜42件のAPIを浪費し、
  //   本来の「一般的なサッカーの知識で考察する」経路がほぼ到達不能だった。
  const code = extractConst("NON_PLAYER_KATAKANA") + "\n"
    + extractFn("isLikelyPlayerName") + "\n"
    + 'const KNOWN_JP_SURNAMES = ["久保建英", "久保", "三笘薫", "三笘"];\n'
    + extractFn("guessUnregisteredPlayerName")
    + "\nmodule.exports = { guessUnregisteredPlayerName };";
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", code)(mod);
  const { guessUnregisteredPlayerName } = mod.exports;

  assert.strictEqual(guessUnregisteredPlayerName("ハイプレスは本当に有効だと思う？"), null);
  assert.strictEqual(guessUnregisteredPlayerName("プレミアリーグとラ・リーガ、どっちがレベル高いと思う？"), null);
  assert.strictEqual(guessUnregisteredPlayerName("ポゼッションサッカーって何？"), null);
  // 本物の選手名はこれまで通り拾えること
  assert.strictEqual(guessUnregisteredPlayerName("ムバッペはどんな選手？"), "ムバッペ");
  assert.strictEqual(guessUnregisteredPlayerName("久保建英はどう？"), "久保建英");
});

// =====================================================================
// ② 時差(日本の利用者にとっての「今日」)
// =====================================================================

test("★欠陥60: 学習の記録キーが、日本の利用者にとっての日付になっている", () => {
  // 【この欠陥が実際にしていたこと】
  //   日次学習は GitHub Actions の cron "0 19 * * *"(UTC19時=日本時間の翌朝4時)に走る。
  //   記録キーはUTC日付だったため、日本の利用者が「今朝動いた」と感じる実行が
  //   **前日の記録**として保存された。一方で健康診断は「今日(UTC)の記録があるか」を
  //   見るため、日本時間の朝9時から翌朝4時まで——つまり日本人が起きているあいだ中——
  //   「本日は実行記録がありません。GitHub Actionsが動いていない可能性があります」と
  //   表示していた。**毎日賢くなっていることを証明するはずの画面が、
  //   毎日ほぼ一日中「壊れています」と嘘をついていた**。
  assert.ok(/function appDateKey\(date\)/.test(SERVER), "地域の日付を作るヘルパーが無い");
  assert.ok(/APP_TIMEZONE_OFFSET_HOURS/.test(SERVER), "タイムゾーンの設定が無い");
  assert.ok(/const key = `learn:runlock:\$\{appDateKey\(\)\}`/.test(SERVER), "実行ロックのキーがUTCのまま");
  assert.ok(/const todayDateKey = appDateKey\(\);/.test(SERVER), "健康診断の「今日」がUTCのまま");
  assert.ok(/appDateKey,\n\};/.test(SERVER) || /  appDateKey,/.test(SERVER), "日次ジョブへ渡していない");

  // 実際に日本時間で日付が変わることを確認する
  process.env.PORT = "0";
  const srv = require(path.join(ROOT, "server/server.js"));
  const key = srv.learningDeps.appDateKey(new Date("2026-08-04T19:30:00Z"));
  assert.strictEqual(key, "2026-08-05", "UTC 8/4 19:30 は日本時間では 8/5 であるべき(実測: " + key + ")");
});

test("★欠陥61: 「本日の実際の試合」も日本の日付で取得する", () => {
  // UTC基準だったため、日本時間の0時〜9時のあいだは
  // 前日の試合が「📡 本日の実際の試合」として表示されていた。
  const fn = SERVER.slice(SERVER.indexOf("async function handleFixturesToday"), SERVER.indexOf("async function handleFixturesToday") + 3000);
  assert.ok(/const today = appDateKey\(\);/.test(fn), "本日の試合の日付がUTCのまま");
});

// =====================================================================
// ③ 外部から予算を焼かれない(入力検証・キャッシュ)
// =====================================================================

test("★欠陥62: ?leagues= に上限と数値検査があり、大量のAPI呼び出しを起こせない", () => {
  // `?leagues=1,2,3,...,500` という認証不要のGET1本で、500件のAPIリクエストを
  // 一度に発生させられた(無料プランの1日分の5倍)。
  assert.ok(/MAX_LEAGUES_PARAM/.test(SERVER), "件数の上限が無い");
  assert.ok(/\.filter\(\(v\) => \/\^\\d\{1,6\}\$\/\.test\(v\)\)/.test(SERVER), "数値かどうかを検査していない");
});

test("★欠陥63: ?season= に範囲検査がある", () => {
  assert.ok(/seasonRaw >= 2000 && seasonRaw <= nowYear \+ 1/.test(SERVER), "季節(シーズン)の範囲検査が無い");
});

test("★欠陥64: 1回23件のAPIを使うマッチ分析がキャッシュされる", () => {
  // キャッシュが一切無く、home/awayは任意の文字列だったため、
  // 認証不要のGETを5回投げるだけで無料プラン(1日100件)の枠を使い切れた。
  assert.ok(/const maCacheKey = cacheKeyOf\("match-analysis"/.test(SERVER), "マッチ分析にキャッシュが無い");
  assert.ok(/cacheSet\(maCacheKey, maResult\.body, 30 \* 60 \* 1000\);/.test(SERVER), "結果を保存していない");
  assert.ok(/const canSpendXg = /.test(SERVER), "xG取得に残量の確認が無い");
});

test("★欠陥65: キャッシュの鍵が利用者の入力で衝突しない", () => {
  // `resolve:${name}|${teamHint}|...` のように区切り文字で連結していたため、
  // name="A", team="B|C" と name="A|B", team="C" が同じ鍵になり、
  // **ある選手の成績が別の選手の質問に対して返る**ことが起こりえた。
  assert.ok(/function cacheKeyOf\(prefix, parts\)/.test(SERVER), "鍵を安全に組み立てる関数が無い");
  assert.ok(/encodeURIComponent\(String\(v \?\? ""\)\)/.test(SERVER), "各部品を符号化していない");
  assert.ok(!/const cacheKey = `resolve:\$\{name\}\|/.test(SERVER), "古い連結方式が残っている");
});

test("★欠陥66: キャッシュとレート制限の記録が無限に増えない", () => {
  assert.ok(/CACHE_MAX_ENTRIES/.test(SERVER), "キャッシュの上限が無い");
  assert.ok(/function sweepCache\(\)/.test(SERVER), "期限切れの掃除が無い");
  assert.ok(/RATE_BUCKETS_MAX/.test(SERVER), "レート制限の記録に上限が無い");
});

test("★欠陥67: ヘッダーを書き換えるだけでレート制限をすり抜けられない", () => {
  // `x-forwarded-for` は誰でも自由に書ける値なのに、それだけを鍵にしていた。
  // リクエストごとに違う値を送るだけで、1分30回の制限も
  // AI考察の1日10回の制限も完全に無効化できた。
  assert.ok(/function clientKeyFromRequest\(req\)/.test(SERVER), "利用者の識別を安全にする関数が無い");
  assert.ok(/const socketIp = \(req\.socket && req\.socket\.remoteAddress\)/.test(SERVER),
    "実際の接続元を鍵に含めていない");
  assert.ok(!/const ip = req\.headers\["x-forwarded-for"\] \|\|/.test(SERVER), "古い実装が残っている");
});

test("★欠陥68: ?force=1 でシークレット無しに学習ジョブを無制限起動できない", () => {
  // AUTO_COLLECT_SECRET 未設定(手順書での既定)のとき、
  // `GET /api/learning/run-daily?force=1&sync=1` を繰り返すだけで
  // ロックも実行中フラグも両方すり抜けて学習ジョブを無制限に同時起動でき、
  // 1回あたり数十〜100件のAPIを消費できた。
  // 第8次監査でconsumeUnprotectedForceRunはUpstash永続化のためasync化された
  // (保護は同一・むしろ強化: スリープ再起動でカウンタが消えなくなった)。
  assert.ok(/if \(forceRequested && !requiredSecret && !\(await consumeUnprotectedForceRun\(\)\)\)/.test(SERVER),
    "forceの回数制限が無い");
  assert.ok(/UNPROTECTED_FORCE_RUN_MAX/.test(SERVER), "1日あたりの上限が定義されていない");
  const idxRunning = SERVER.indexOf("if (dailyLearningRunning) {");
  const idxSync = SERVER.indexOf('if (parsed.searchParams.get("sync") === "1") {');
  assert.ok(idxRunning > 0 && idxSync > 0 && idxRunning < idxSync,
    "sync指定が、実行中フラグの確認より前にあるとすり抜けられる");
});

// =====================================================================
// ④ 正直さ(表示・プロンプト・乱数)
// =====================================================================

test("★欠陥69: AIが書いた文章と、実データから作った文章のラベルが逆になっていない", () => {
  // 【この欠陥が実際にしていたこと】
  //   LLMが自由に書いた文章には何の印も付かず、実データから機械的に組み立てた
  //   文章の方に「(簡易版)」と付けていた。利用者から見ると、AIの推測の方が
  //   本格的な分析に見えるという、真逆の印象になっていた。
  assert.ok(/const aiTag = \(block\) => \(block && block\.source === "ai_generated" \? "\(AIの見解\)" : ""\);/.test(HTML),
    "AI生成に印を付ける仕組みが無い");
  assert.ok(!/data\.narrative\.source === "ai_generated" \? "" : "\(簡易版\)"/.test(HTML),
    "逆のラベル付けが残っている");
});

test("★欠陥70: フォーメーション不明なのに戦術相性を書かせない", () => {
  // 両チームのフォーメーションを「不明」と渡しているのに、
  // 「戦術相性の見立てを80〜140文字で」と無条件に要求していた。
  // さらに dataNotes(取得できなかったものの一覧)はプロンプトに入っておらず、
  // モデルは欠落を知らないまま断定的な文章を書かされていた。
  assert.ok(/tacticalCompatibilityを必ず空文字/.test(SERVER), "不明時に空を返させていない");
  assert.ok(/今回取得できなかったデータ:/.test(SERVER), "欠落一覧をモデルへ伝えていない");
  assert.ok(!/断定的に1つだけ挙げてください。",\n      \]\.join/.test(SERVER), "断定を強制する指示が残っている");
});

test("★欠陥71: AIの推定を「取得できた事実」としてモデルへ渡さない", () => {
  // facts には【AIによる推定】で始まるプロフィールも混ざっているのに、
  // 一律「取得できた事実」として渡し、「この事実だけを根拠に」と指示していた。
  // 採点側は推定を軽く扱うようにしたのに、プロンプト側で台無しになっていた。
  assert.ok(/【AIによる推定】と書かれている項目は実データではなく/.test(SERVER),
    "AI推定と実データをプロンプト上で区別していない");
});

test("★欠陥72: 乱数で作った「◯分頃」を分析結果として提示しない", () => {
  // `8 + Math.floor(Math.random() * 82)` で作った分数を
  // 「後半67分前後、○○が試合の流れを引き寄せる場面を作ると予想されます」と、
  // 分析結果であるかのように提示していた。
  assert.ok(!/const minute = 8 \+ Math\.floor\(Math\.random\(\) \* 82\);/.test(SERVER), "サーバー側に残っている");
  assert.ok(!/const minute = 8 \+ Math\.floor\(Math\.random\(\) \* 82\);/.test(HTML), "フロントエンド側に残っている");
  assert.ok(/具体的な時間帯を予測できる根拠はありません/.test(SERVER), "根拠が無いことを伝えていない");
});

test("★欠陥73: 中身が空のLLM応答を知識として保存しない", () => {
  // `{}` や `{"error":"..."}` でもJSONとして解釈できてしまい、
  // 空文字だけのオブジェクトは真値なのでガードを素通りしていた。
  // 「戦術スタイル: 不明 / フォーメーション傾向: 不明」という中身の無い文章が
  // 知識として保存され、①成長件数に数えられ ②根拠として提示され
  // ③60日間は再生成もされない、という三重の害があった。
  const club = fs.readFileSync(path.join(ROOT, "server/knowledge/clubProfileEngine.js"), "utf8");
  const player = fs.readFileSync(path.join(ROOT, "server/knowledge/playerProfileEngine.js"), "utf8");
  assert.ok(/EMPTY_RESPONSE/.test(club), "クラブ側に空応答の検査が無い");
  assert.ok(/EMPTY_RESPONSE/.test(player), "選手側に空応答の検査が無い");
});

test("★欠陥74: 登録選手が0人でも固定値62で比較しない(フロントエンド側)", () => {
  // サーバー側は0人を弾くようにしたが、ローカル計算のフォールバックに
  // 同じ定数62が残っていたため、結局同じ嘘が利用者に見えてしまう状態だった。
  assert.ok(!/if \(!players\.length\) return 62;/.test(HTML), "固定値62が残っている");
  assert.ok(/if \(!homeP\.length \|\| !awayP\.length\) return null;/.test(HTML), "空ロースターを弾いていない");
  assert.ok(/架空の数値で比較することはしません/.test(HTML), "理由を利用者へ伝えていない");
});

// =====================================================================
// ⑤ 同時実行(唯一の「でっち上げていない数字」を守る)
// =====================================================================

test("★欠陥75: 同じ試合の検証が同時に走っても、正答率が二重計上されない", () => {
  // 【この欠陥が実際にしていたこと】
  //   「読む→未検証か確認する→カウンターを増やす」の間に await が挟まるため、
  //   3つの入口(今日の試合の一括検証・試合分析・6時間ごとのcron)が同時に走ると
  //   両方がカウンターを増やしていた。ホーム画面の「AI予測の正答率」——
  //   このアプリで唯一の「でっち上げていない数字」——が水増しされていた。
  assert.ok(/pred:resolvelock:\$\{fixtureId\}/.test(SERVER), "検証の重複を防ぐロックが無い");
  assert.ok(/"NX", "EX", "86400"/.test(SERVER), "まだ無いときだけ書く指定(NX)になっていない");
  assert.ok(/if \(mayCount\) \{/.test(SERVER), "ロックを取れた場合だけ数える構造になっていない");
});

test("★欠陥76: 1件の失敗で予測自動収集を「失敗」と報告しない", () => {
  // 第6次で入れた `/error/i` は個々の試合の注記にも一致するため、
  // 8件中1件だけ失敗して残り7件は正常でも ok:false になり、
  // 呼び出し元のcronがエンドポイントを再度叩き(さらにAPIを消費し)、
  // 最後は失敗通知を出していた。
  assert.ok(/const hadFatalError = notes\.some\(\(n\) => \/\^\(resolve\|log\) phase error:\//.test(SERVER),
    "処理そのものの失敗だけを見る形になっていない");
});

test("★欠陥77: AI考察の全体上限に達した日に、利用者個人の枠を無駄に消費しない", () => {
  // 第8次監査でtryConsumeLlmBudgetはUpstash永続化のためasync化(await)された。
  // 「全体の枠→個人の枠」の確認順序は同一。
  assert.ok(/\(await tryConsumeLlmBudget\(\)\) && tryConsumeLlmBudgetForIp\(clientIp\)/.test(SERVER),
    "全体の枠を先に確認していない");
});

test("★欠陥78: 保存先の読み取り失敗を、黙って「変化なし」にしない", () => {
  // 第6次で「新しい知識」として数えるのはやめたが、そのまま黙って消えると
  // 「今日は変化が無かった」と区別がつかなくなっていた。
  const dj = fs.readFileSync(path.join(ROOT, "server/learning/dailyJob.js"), "utf8");
  assert.ok(/knowledge_lookup_failed/.test(dj), "読み取り失敗が記録に残らない");
});

test("★欠陥79: リーグの逆引きが毎回Upstashを叩かない(応答が遅くならない)", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "server/learning/leagueConfig.js"), "utf8");
  assert.ok(/_leagueEntityKeyMemo/.test(cfg), "結果を覚えていない(毎回4件の読み取りが走る)");
});

test("★欠陥80: 空のチーム名で無関係な同姓選手を選ばない", () => {
  const fn = SERVER.slice(SERVER.indexOf("async function resolvePlayerId"), SERVER.indexOf("async function handlePlayerSeasonStats"));
  assert.ok(/if \(!teamName \|\| !hintLower\) return false;/.test(fn), "空文字の照合を弾いていない");
});

test("★欠陥81: 契約プランの判定がプロセス再起動で失われない", () => {
  // 【本番の健康診断出力から発見】
  //   契約プランの自動判定はプロセス内のメモリにしか無かった。
  //   Renderの無料プランは15分アクセスが無いとスリープするため、
  //   **起動のたびに「プラン不明」に戻り、1日の予算が既定の100件から始まる**。
  //   日次学習は クラブ→監督/移籍→リーグ→選手 の順に処理するので、
  //   100件(うち20件は利用者用に確保=実質80件)ではクラブと監督/移籍で尽き、
  //   リーグと選手には一度も到達しない。
  //   実際、本番の記録は3日連続で「0リーグ・0選手」だった。
  assert.ok(/learn:apiplan/.test(SERVER), "判定したプランを保存していない");
  assert.ok(/async function restoreDetectedPlan\(\)/.test(SERVER), "保存済みプランの読み戻しが無い");
  assert.ok(/await restoreDetectedPlan\(\)/.test(SERVER), "予算を作る前に読み戻していない");
  assert.ok(/restoredFromStorage/.test(SERVER), "復元値か実測値かを区別していない");
});

// =====================================================================

(async () => {
  for (const t of queue) {
    try {
      await t.fn();
      console.log(`  [OK] ${t.name}`);
    } catch (e) {
      failures++;
      console.log(`  [FAIL] ${t.name}: ${e.message}`);
    }
  }
  console.log(failures === 0
    ? `\nAll audit-7 regression tests PASSED (${queue.length} tests).`
    : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
