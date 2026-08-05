/**
 * server/knowledge/knowledgeStore.js
 * ------------------------------------------------
 * Knowledge Engine ― 「事実」「分析」「意見」を分離して保存し、重複を防ぎ、
 * 古くなった情報を失効させる知識ベース。
 *
 * 正直な設計範囲(重要): このモジュールは「クラブ公式サイト・ニュース記事・
 * 監督の生の発言」をスクレイピングして取り込む機能ではありません。任意の外部
 * サイトを無断でスクレイピングすることは利用規約・著作権上のリスクがあるため、
 * 今回はあえて実装していません。知識の取得元は、このアプリが既に契約している
 * API-Football(実データAPI)からの情報(直近成績・怪我・移籍・フォーメーション・
 * 監督名など)、および server/learning/dailyJob.js や server/reasoning/ が
 * そのデータから導き出した「分析」(fact→analysisへの格上げ。下記参照)に限定
 * しています。「監督の生の発言」は引き続き取得できません(既存の
 * MANAGER_QUOTE_UNAVAILABLE_REASON と同じ理由)。将来、正規のニュースAPIや
 * クラブの公式RSSフィードなど、利用規約上問題のない情報源を具体的に決めて
 * いただければ、その情報源専用のfetcherを追加する形で拡張できます。
 *
 * 4層構造(2026年8月・知識拡張フェーズで導入): 「単なるデータベース」ではなく、
 * 更新頻度と性質が異なる知識を明示的に分離することで、後から「今日は何が
 * 新しく増えたか/何が更新されたか/何が古くなったか」を追跡できるようにする。
 *
 *   Layer1 "fact"      ― 毎日更新される客観的な数値(例: 得失点差の変化)。
 *                         取得元: API-Footballの実データ。既定14日で失効。
 *   Layer2 "profile"   ― クラブ・監督・選手の「固定的な」知識(戦術傾向・
 *                         プレースタイル・フォーメーション傾向・長所短所)。
 *                         API-Footballには存在しない定性的な情報のため、
 *                         Layer1の実データを根拠としてLLMに生成させ、必ず
 *                         「AIによる推定」と明示する(捏造した事実として
 *                         紛れ込ませない)。毎日は再生成せず、既定60日で
 *                         失効(その頃に自動で作り直す=知識の鮮度を保つ)。
 *   Layer3 "opinion"   ― AI自身が「今どう考えているか」という主観的な見解
 *                         (議論モードの考察、および毎日学習エンジンが生成する
 *                         「AIの現在の見立て」)。前日と見解が変わった場合の
 *                         変化理由は Memory Engine(server/memory/memoryStore.js)
 *                         側で管理する(このopinionはその内容をKnowledge Engine
 *                         からも検索できるようミラーしたもの)。既定7日で失効
 *                         (毎日更新される想定のため短め)。
 *   Layer4 "reflection"― 試合終了後の振り返り(予想は当たったか/外れたか・
 *                         なぜか・次回への改善点)。当たった場合もハズレた
 *                         場合も両方保存する(以前はハズレた仮説を記録して
 *                         いなかった)。長期の学習履歴として既定90日保持。
 *
 * 重複排除: 同じクラブ・カテゴリ・内容の知識は、内容のハッシュ値で判定して
 * 二重登録しない(全く同じ「事実」を毎日再登録して知識ベースが際限なく
 * 膨らむのを防ぐ)。
 *
 * 失効管理: 各アイテムは type ごとに既定の有効日数を持ち、その日数を過ぎたら
 * 「アクティブな知識」の一覧からは除外される(削除はしない。履歴としては
 * 残るが、RAG・推論には使われなくなる)。
 */
const crypto = require("crypto");

const DEFAULT_EXPIRY_DAYS = { fact: 14, analysis: 30, opinion: 7, profile: 60, reflection: 90 };
const MAX_ITEMS_PER_TEAM = 80;

// ============================================================================
// 2026年8月・最終方針「Knowledge Engineは使用回数まで管理」対応。
// 知識が実際に読まれた(RAG・推論の根拠候補になった)回数を記録する。
// ■ 設計(質問時の追加負荷ゼロ): 利用者の質問処理中はメモリ上のMapを
//   増やすだけでRedisへは書かない(最終方針「質問した瞬間に重い処理を行う
//   設計は禁止」)。毎日の学習ジョブが1日1回だけ knowledge:usage(1キー)へ
//   まとめて加算保存する。プロセス再起動でその日の未保存分は失われうるが、
//   「傾向を知る」という目的には十分で、正確性より応答速度を優先する
//   (この近似であることはREADMEに明記)。
// モジュール全体で共有(同一プロセス内のserver用/学習用インスタンス共通)。
const knowledgeUsageBuffer = new Map(); // hash -> count
const USAGE_KEY = "knowledge:usage";
const USAGE_MAX_TRACKED = 500; // 保存する件数の上限(使用回数の多い順。無限成長させない)

// ---- 2026年8月・成長可視化ラウンド①②: 「今日なにを覚えたか」のカテゴリ別集計 ----
// saveKnowledgeItemの結果(採用/重複)をカテゴリごとにメモリで数え、日次学習が
// 1日1回 learn:knowledge:categories:<date> へ加算保存する(usageBufferと同じ設計)。
const categoryCountsBuffer = new Map(); // category -> { saved, duplicate }
function bumpCategoryCount(category, outcome) {
  const key = category || "(カテゴリなし)";
  const c = categoryCountsBuffer.get(key) || { saved: 0, duplicate: 0 };
  if (outcome === "saved") c.saved++;
  else if (outcome === "duplicate") c.duplicate++;
  categoryCountsBuffer.set(key, c);
}


function stableHash(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}

// 2026年8月・優先順位⑥(主要リーグのKnowledge Engine日次蓄積): これまで
// Knowledge Engineは「クラブ単位(teamEn)」の知識しか扱えなかった。リーグ単位の
// 知識(順位表・得点/アシストランキング)を蓄積するため、item.teamEnが無い場合は
// item.leagueEnを主体として扱えるよう一般化する。既存のクラブ単位の挙動
// (item.teamEnがある場合)は完全に維持し、リーグ単位は"league:"接頭辞を付けた
// 別名前空間のキーにすることで、クラブ名とリーグ名が万一衝突しても安全にする。
function entityKeyFor(item) {
  if (item && item.teamEn) return item.teamEn;
  if (item && item.leagueEn) return `league:${item.leagueEn}`;
  return null;
}

function computeItemHash(item) {
  const entity = entityKeyFor(item);
  const normalized = `${entity}|${item.category}|${item.type}|${(item.statement || "").trim()}`;
  return stableHash(normalized);
}

function isExpired(item, nowMs) {
  const days = item.expiresRelevanceDays || DEFAULT_EXPIRY_DAYS[item.type] || 14;
  const computedAtMs = new Date(item.computedAt).getTime();
  // 第6次監査で発見した欠陥の修正:
  //   日時が壊れている(パースできない)レコードを「失効していない」として
  //   扱っていたため、**いつ観測したか分からない知識が永久に有効なまま
  //   根拠として使われ続ける**状態だった。いつのものか分からない情報は
  //   根拠にできないので、失効扱いにする(誤って古い情報を根拠にするより、
  //   正直に「根拠が無い」と言う方がこのプロジェクトの方針に合う)。
  if (!Number.isFinite(computedAtMs)) return true;
  return nowMs - computedAtMs > days * 24 * 60 * 60 * 1000;
}

function createKnowledgeStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON }) {
  /**
   * @param {object} item - { teamEn, category, type: "fact"|"analysis"|"opinion",
   *   statement, computedAt(ISO), expiresRelevanceDays?, source }
   *   teamEnの代わりにleagueEnを渡すと、クラブ単位ではなくリーグ単位の知識として
   *   保存できる(2026年8月・優先順位⑥。いずれか一方は必須)。
   * @returns {{ saved: boolean, reason?: string, hash: string }}
   */
  async function saveKnowledgeItem(item) {
    if (!upstashEnabled) return { saved: false, reason: "NO_UPSTASH", hash: null };
    const entity = item && entityKeyFor(item);
    if (!item || !entity || !item.type || !item.statement) return { saved: false, reason: "INVALID_ITEM", hash: null };
    if (!["fact", "analysis", "opinion", "profile", "reflection"].includes(item.type)) return { saved: false, reason: "INVALID_TYPE", hash: null };

    const hash = computeItemHash(item);
    // ---- 第6次監査で発見した最重要欠陥の修正(成長の偽装) ----
    //   ここは upstashGetJSON を使っていたが、この関数は**失敗を握りつぶして
    //   null を返す**(タイムアウト・5xx・認証エラーのいずれも「まだ無い」と
    //   区別がつかない)。その結果、Upstashが一瞬でも不調だと:
    //     ・何ヶ月も前からある知識の firstSeenAt が今日に書き換わり、
    //       「今日新しく覚えた知識」として数えられる
    //     ・同じハッシュが一覧へ二重登録され、有効件数が水増しされる
    //     ・累計カウンターが二重に増える
    //     ・その日の成長レポートが「昨日より賢くなりました」と表示する
    //   何も学んでいないのに学んだと報告する状態で、本プロジェクトの
    //   「でっち上げない」原則に真っ向から反する。読み取りに失敗したときは
    //   新規保存へ進まず、正直に「判定できなかった」と返す。
    let existing = null;
    try {
      const raw = await upstashCmd(["GET", `knowledge:item:${hash}`]);
      existing = (raw === null || raw === undefined) ? null : JSON.parse(raw);
    } catch (e) {
      return { saved: false, reason: "LOOKUP_FAILED", hash };
    }
    if (existing) {
      // 既に全く同じ内容が登録済み。重複登録はしないが、鮮度だけ更新する
      // (「今日も変わらず観測されている」という事実は意味があるため)。
      existing.lastSeenAt = item.computedAt;
      // 第6次監査での追加: この判定を導入する前に保存されたレコードには
      // isAiGenerated が付いていない。放置すると、AIが推定で書いた文章が
      // 失効するまで「実データ」として扱われ続けるため、この機会に補う。
      if (item.isAiGenerated && !existing.isAiGenerated) existing.isAiGenerated = true;
      await upstashSetJSON(`knowledge:item:${hash}`, existing);
      // 第6次監査での追加: 一覧(byTeam)の上限から溢れて消えていた場合、
      // 本体だけが残って**二度と読み出せない幽霊知識**になっていた
      // (重複判定でヒットするため、一覧へ戻る機会が永久に来ない)。
      // 一覧に載っているか確認し、無ければ載せ直す。
      try {
        const list = (await upstashCmd(["LRANGE", `knowledge:byTeam:${entity}`, "0", "-1"])) || [];
        if (!list.includes(hash)) {
          const relinkLen = await upstashCmd(["RPUSH", `knowledge:byTeam:${entity}`, hash]).catch(() => null);
          // 第8次監査: 載せ直しで上限から溢れる場合も、溢れた本体を孤児にしない
          if (Number(relinkLen) > MAX_ITEMS_PER_TEAM) {
            try {
              const evicted = (await upstashCmd(["LRANGE", `knowledge:byTeam:${entity}`, "0", String(Number(relinkLen) - MAX_ITEMS_PER_TEAM - 1)])) || [];
              for (const h of evicted) await upstashCmd(["DEL", `knowledge:item:${h}`]).catch(() => {});
            } catch (e) { /* ベストエフォート */ }
          }
          await upstashCmd(["LTRIM", `knowledge:byTeam:${entity}`, String(-MAX_ITEMS_PER_TEAM), "-1"]).catch(() => {});
          bumpCategoryCount(item.category, "duplicate");
          return { saved: false, reason: "DUPLICATE_RELINKED", hash };
        }
      } catch (e) { /* 一覧を確認できなくても本処理は続行する */ }
      bumpCategoryCount(item.category, "duplicate");
      return { saved: false, reason: "DUPLICATE", hash };
    }

    const record = { ...item, hash, firstSeenAt: item.computedAt, lastSeenAt: item.computedAt };
    await upstashSetJSON(`knowledge:item:${hash}`, record);
    // 第8次監査(High)の修正: LTRIMで一覧から溢れた古い知識のhashは、本体
    // (knowledge:item:*)が**どこからも参照されない孤児キー**として永久に残り、
    // Redisが無限成長していた。溢れる分を先に読み取り、本体ごと削除する。
    // 溢れ判定はRPUSHの戻り値(新しい長さ)を使い、負の範囲指定に頼らない
    // (実装により端の解釈が異なり、誤って現役の知識を消す事故を防ぐため)。
    const newLen = await upstashCmd(["RPUSH", `knowledge:byTeam:${entity}`, hash]).catch(() => null);
    if (Number(newLen) > MAX_ITEMS_PER_TEAM) {
      try {
        const evicted = (await upstashCmd(["LRANGE", `knowledge:byTeam:${entity}`, "0", String(Number(newLen) - MAX_ITEMS_PER_TEAM - 1)])) || [];
        for (const h of evicted) await upstashCmd(["DEL", `knowledge:item:${h}`]).catch(() => {});
      } catch (e) { /* 掃除に失敗しても保存自体は成功している */ }
    }
    await upstashCmd(["LTRIM", `knowledge:byTeam:${entity}`, String(-MAX_ITEMS_PER_TEAM), "-1"]).catch(() => {});
    // 2026年8月・「AIの成長レポート」ウィジェット(ご要望⑦)対応: 登録クラブ
    // 全件をループして数えるgetActiveKnowledge()はホーム画面が読み込まれる
    // たびに呼ぶには重すぎる(Upstash読み取りが多すぎる)ため、軽量な累計
    // カウンター(knowledge:trackedPlayerProfilesと同じ既存パターン)を別途持つ。
    // 失効しても減らない「累計保存件数」であることは呼び出し側で正直に明示する。
    await upstashCmd(["INCR", "knowledge:totalItemsSavedCounter"]).catch(() => {});
    bumpCategoryCount(item.category, "saved"); // 成長可視化ラウンド: カテゴリ別の採用数
    return { saved: true, hash };
  }

  // teamEn/leagueEnどちらの名前空間でも共通で使う内部ヘルパー(重複を避けるため
  // getActiveKnowledge/getActiveKnowledgeForLeagueの両方から呼ばれる)。
  async function getActiveKnowledgeByEntity(entity, nowMs) {
    const empty = { facts: [], analyses: [], opinions: [], profiles: [], reflections: [], totalStored: 0, totalActive: 0 };
    if (!upstashEnabled || !entity) return empty;
    const now = nowMs || Date.now();
    const hashes = (await upstashCmd(["LRANGE", `knowledge:byTeam:${entity}`, "0", "-1"]).catch(() => [])) || [];
    const items = [];
    for (const h of hashes) {
      const record = await upstashGetJSON(`knowledge:item:${h}`);
      if (record) items.push(record);
    }
    const active = items.filter((i) => !isExpired(i, now));
    // 使用回数の記録(メモリ加算のみ=応答速度に影響しない。日次ジョブで保存)
    for (const i of active) {
      if (i.hash) knowledgeUsageBuffer.set(i.hash, (knowledgeUsageBuffer.get(i.hash) || 0) + 1);
    }
    return {
      facts: active.filter((i) => i.type === "fact"),
      analyses: active.filter((i) => i.type === "analysis"),
      opinions: active.filter((i) => i.type === "opinion"),
      profiles: active.filter((i) => i.type === "profile"),
      reflections: active.filter((i) => i.type === "reflection"),
      totalStored: items.length,
      totalActive: active.length,
    };
  }

  /**
   * このクラブについて現在「有効」な知識(失効していないもの)を、事実/分析/意見に
   * 分けて返す。失効した知識は除外される(=削除はされないが、以後のRAG・推論には
   * もう使われない、という設計)。
   */
  async function getActiveKnowledge(teamEn, nowMs) {
    return getActiveKnowledgeByEntity(teamEn || null, nowMs);
  }

  // 2026年8月・優先順位⑥: getActiveKnowledgeのリーグ版(クラブ名の代わりに
  // リーグの英語名を渡す)。
  async function getActiveKnowledgeForLeague(leagueEn, nowMs) {
    return getActiveKnowledgeByEntity(leagueEn ? `league:${leagueEn}` : null, nowMs);
  }

  async function getKnowledgeDiffByEntity(entity, dateKey, nowMs) {
    const empty = { newItems: [], updatedItems: [], staleCount: 0 };
    if (!upstashEnabled || !entity || !dateKey) return empty;
    const now = nowMs || Date.now();
    const hashes = (await upstashCmd(["LRANGE", `knowledge:byTeam:${entity}`, "0", "-1"]).catch(() => [])) || [];
    const items = [];
    for (const h of hashes) {
      const record = await upstashGetJSON(`knowledge:item:${h}`);
      if (record) items.push(record);
    }
    // 第8次監査(Medium)の修正: dateKeyは日本時間基準(dailyJobのappDateKey)なのに、
    // firstSeenAt/lastSeenAt(UTCのISO文字列)をUTCのまま日付切り出しして比較していた。
    // 日次実行はUTC19時(=日本時間の朝4時)のため、その実行で保存した知識のUTC日付は
    // 「前日」となり必ず不一致 → 「今日の新規知識」が主要実行時間帯で常に0件だった。
    // ISO時刻を日本時間(既定UTC+9。dailyJobと同じAPP_TIMEZONE_OFFSET_HOURS)の日付に
    // 変換してから比較する。
    const tzOffsetHours = Number(process.env.APP_TIMEZONE_OFFSET_HOURS ?? 9);
    const appDateOf = (iso) => {
      const t = new Date(String(iso || "")).getTime();
      return Number.isFinite(t) ? new Date(t + tzOffsetHours * 3600000).toISOString().slice(0, 10) : "";
    };
    const newItems = items.filter((i) => appDateOf(i.firstSeenAt) === dateKey);
    const updatedItems = items.filter((i) => {
      const first = appDateOf(i.firstSeenAt);
      const last = appDateOf(i.lastSeenAt);
      return last === dateKey && first !== dateKey;
    });
    const staleCount = items.filter((i) => isExpired(i, now)).length;
    return { newItems, updatedItems, staleCount };
  }

  /**
   * 「昨日より知識が増えていることが分かるようにする」ためのヘルパー。
   * firstSeenAtが指定の日付(YYYY-MM-DD)と一致するアイテムを「新しく覚えた
   * 知識」、lastSeenAt(≠firstSeenAt)がその日付のアイテムを「更新された知識」
   * として分類する。isExpiredで除外された「古くなった知識」の件数も返す。
   */
  async function getKnowledgeDiffForTeam(teamEn, dateKey, nowMs) {
    return getKnowledgeDiffByEntity(teamEn || null, dateKey, nowMs);
  }

  // 2026年8月・優先順位⑥: getKnowledgeDiffForTeamのリーグ版。
  async function getKnowledgeDiffForLeague(leagueEn, dateKey, nowMs) {
    return getKnowledgeDiffByEntity(leagueEn ? `league:${leagueEn}` : null, dateKey, nowMs);
  }

  /**
   * メモリ上の使用回数を knowledge:usage(1キー)へまとめて加算保存する。
   * 毎日の学習ジョブから1日1回呼ばれる(質問時には呼ばない)。
   */
  async function flushUsageCounters() {
    if (!upstashEnabled || knowledgeUsageBuffer.size === 0) return { flushed: 0 };
    try {
      const stored = (await upstashGetJSON(USAGE_KEY).catch(() => null)) || {};
      let flushed = 0;
      for (const [hash, count] of knowledgeUsageBuffer) {
        stored[hash] = (stored[hash] || 0) + count;
        flushed += count;
      }
      // 上限を超えたら使用回数の少ないものから削る(無限成長させない)
      const entries = Object.entries(stored).sort((a, b) => b[1] - a[1]).slice(0, USAGE_MAX_TRACKED);
      await upstashSetJSON(USAGE_KEY, Object.fromEntries(entries));
      knowledgeUsageBuffer.clear();
      return { flushed, tracked: entries.length };
    } catch (e) {
      return { flushed: 0, error: e.message }; // 保存できなくても本処理は妨げない
    }
  }

  /** 使用回数の多い知識(上位N件)を、本文つきで返す(ダッシュボード表示用) */
  async function getTopUsedKnowledge(limit) {
    if (!upstashEnabled) return [];
    const stored = (await upstashGetJSON(USAGE_KEY).catch(() => null)) || {};
    const top = Object.entries(stored).sort((a, b) => b[1] - a[1]).slice(0, limit || 5);
    const out = [];
    for (const [hash, count] of top) {
      const item = await upstashGetJSON(`knowledge:item:${hash}`).catch(() => null);
      if (item) out.push({ usageCount: count, statement: item.statement, teamJa: item.teamJa || null, type: item.type });
    }
    return out;
  }

  /**
   * 成長可視化ラウンド①②: 「今日なにを覚えたか」のカテゴリ別集計を
   * learn:knowledge:categories:<date> へ加算保存する(日次学習から1日1回)。
   * 戻り値に今回フラッシュした内訳を含め、growthLogにも同梱できるようにする。
   */
  async function flushCategoryCounters(dateKey) {
    if (!upstashEnabled || !dateKey || categoryCountsBuffer.size === 0) return { flushed: 0, categories: {} };
    const snapshot = {};
    categoryCountsBuffer.forEach((v, k) => { snapshot[k] = { saved: v.saved, duplicate: v.duplicate }; });
    try {
      const key = `learn:knowledge:categories:${dateKey}`;
      const stored = (await upstashGetJSON(key).catch(() => null)) || {};
      for (const [cat, v] of Object.entries(snapshot)) {
        const cur = stored[cat] || { saved: 0, duplicate: 0 };
        stored[cat] = { saved: (cur.saved || 0) + v.saved, duplicate: (cur.duplicate || 0) + v.duplicate };
      }
      await upstashSetJSON(key, stored);
      categoryCountsBuffer.clear();
      return { flushed: Object.keys(snapshot).length, categories: stored };
    } catch (e) {
      return { flushed: 0, categories: snapshot, error: e.message }; // 保存失敗時はバッファ保持
    }
  }

  return {
    saveKnowledgeItem, getActiveKnowledge, getKnowledgeDiffForTeam,
    flushUsageCounters, getTopUsedKnowledge, flushCategoryCounters,
    getActiveKnowledgeForLeague, getKnowledgeDiffForLeague,
  };
}

module.exports = { createKnowledgeStore, computeItemHash, isExpired, DEFAULT_EXPIRY_DAYS };
