/**
 * server/knowledge/clubDossier.js
 * ------------------------------------------------
 * 2026年8月・「知識量を大幅に増やす」フェーズ(ご指示①〜⑤)の中核。
 * クラブ1つにつき1冊の「調査ファイル(dossier)」を構造化して持つ。
 *
 * ■ なぜ Knowledge Engine(文章の知識)とは別に必要か
 *   knowledgeStore が持つのは「文章」の知識で、議論モードの根拠には向くが、
 *   Prediction Engine が必要とするのは**数値**(得失点差・負傷者数・順位…)。
 *   これまで予測は毎回APIを呼び直し、失敗すると「データ不足」になっていた。
 *   毎日の学習で取得した数値を構造化して保存しておけば、
 *     ・APIが一時的に失敗しても、直近の実測値で予測できる(取得時刻を明示)
 *     ・「データ不足で予測できません」を大幅に減らせる
 *     ・利用者がどのクラブを聞いても、蓄積済みの知識から即答できる
 *
 * ■ 設計方針(でっち上げ防止)
 *   ・各セクションに必ず computedAt(いつの実測か)を持つ。
 *     予測に使うときは鮮度を確認し、古いデータを使った場合は必ずその旨を表示する。
 *   ・取得できない項目は unavailableJa に「なぜ取得できないか」を明記する
 *     (市場価値・契約・利き足などはAPI-Footballに存在しない)。
 *   ・差分(昨日から何が変わったか)は、実測値の比較からのみ生成する。
 *
 * ■ 保存形式
 *   kb:club:<slug>        … クラブ1冊の調査ファイル(JSON)
 *   kb:club:index         … 保存済みクラブのslug一覧(リスト)
 *   kb:player:<id>        … 選手1人の記録(JSON)
 *   kb:player:count       … 保存済み選手数(カウンター)
 */

// API-Footballでは構造的に取得できない項目(ご指示②「取得できない項目は
// 推測で補完せず正直に管理」への対応)。
const UNAVAILABLE_FIELDS_JA = {
  marketValue: "市場価値はAPI-Footballでは提供されていません(TransfermarktのようなAPIが別途必要です)。",
  contractUntil: "契約期間はAPI-Footballでは提供されていません。",
  preferredFoot: "利き足はAPI-Footballの選手APIでは提供されていません。",
  salary: "年俸はAPI-Footballでは提供されていません。",
  uefaRankLive: "UEFAの最新係数ランキングはAPI-Footballでは提供されていません(静的スナップショットのみ保持)。",
  managerQuotes: "監督のコメント・会見内容はAPI-Footballでは提供されていません。",
};

const DIFF_LIST_CAP = 20; // 1クラブに保持する「最近の変化」の上限
const SCOUT_FEED_KEEP = 300; // スカウト用フィード(新規/移籍/若手/フォーム急変)の保持件数

/**
 * 選手名の検索用に正規化する。
 * アクセント付き文字(Mbappé / Müller / Özil / Håland)を素の英字へ落とし、
 * 記号・余分な空白を除く。利用者が「mbappe」と打っても引けるようにするため。
 */
function normalizeForSearch(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // 濁点・アクセントを除去
    .replace(/[øØ]/g, "o").replace(/[đĐ]/g, "d").replace(/[łŁ]/g, "l").replace(/[ßẞ]/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugOf(nameEn) {
  return String(nameEn || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function createClubDossier({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON }) {
  const keyFor = (nameEn) => `kb:club:${slugOf(nameEn)}`;

  async function getDossier(nameEn) {
    if (!upstashEnabled || !nameEn) return null;
    return (await upstashGetJSON(keyFor(nameEn)).catch(() => null)) || null;
  }

  /**
   * セクション単位で調査ファイルを更新する。
   * 前回の値と比較して「何が変わったか」を機械的に検出し、
   * 変化があった場合だけ lastChangesJa に追記する(ご指示③の「差分だけを保存」)。
   *
   * @param {string} nameEn
   * @param {string} section - "form" | "injuries" | "coach" | "standings" |
   *                           "transfers" | "xg" | "squad" | "basic" | "topScorer"
   * @param {object} data - セクションの中身(実測値のみ)
   * @param {object} meta - { nameJa, teamId, uefaRankSnapshot, tier, computedAt }
   * @returns {{ saved, changesJa: string[] }}
   */
  async function updateSection(nameEn, section, data, meta) {
    if (!upstashEnabled || !nameEn || !section) return { saved: false, changesJa: [] };
    const m = meta || {};
    const now = m.computedAt || new Date().toISOString();

    let dossier = await getDossier(nameEn);
    const isNew = !dossier;
    if (!dossier) {
      dossier = {
        nameEn, slug: slugOf(nameEn),
        nameJa: m.nameJa || nameEn,
        teamId: m.teamId ?? null,
        uefaRankSnapshot: m.uefaRankSnapshot ?? null,
        tier: m.tier || null,
        sections: {},
        lastChangesJa: [],
        unavailableJa: UNAVAILABLE_FIELDS_JA,
        createdAt: now,
      };
    }
    if (m.nameJa) dossier.nameJa = m.nameJa;
    if (m.teamId) dossier.teamId = m.teamId;
    if (m.uefaRankSnapshot) dossier.uefaRankSnapshot = m.uefaRankSnapshot;
    if (m.tier) dossier.tier = m.tier;

    const prev = dossier.sections[section] || null;
    const changes = diffSection(section, prev, data, dossier.nameJa);
    dossier.sections[section] = { ...data, computedAt: now };
    if (changes.length) {
      dossier.lastChangesJa = [
        ...changes.map((c) => ({ date: now.slice(0, 10), changeJa: c })),
        ...(dossier.lastChangesJa || []),
      ].slice(0, DIFF_LIST_CAP);
    }
    dossier.updatedAt = now;

    const ok = await upstashSetJSON(keyFor(nameEn), dossier);
    if (ok === false) return { saved: false, changesJa: changes };
    if (isNew) {
      // 一覧に載せる(重複しないよう確認してから)
      try {
        const list = (await upstashCmd(["LRANGE", "kb:club:index", "0", "-1"])) || [];
        if (!list.includes(dossier.slug)) await upstashCmd(["RPUSH", "kb:club:index", dossier.slug]);
      } catch (e) { /* 一覧に載らなくても本体は保存済み */ }
    }
    return { saved: true, changesJa: changes };
  }

  /**
   * 前回の実測値と今回の実測値を比べ、「何が変わったか」を日本語で返す。
   * 実測値の比較からしか文を作らない(推測で理由を足さない)。
   */
  function diffSection(section, prev, cur, nameJa) {
    const changes = [];
    if (!prev) return changes; // 初回は「変化」ではなく「初めて知った」なので差分は出さない
    const p = prev; const c = cur || {};
    const label = nameJa || "";
    if (section === "coach") {
      if (p.coachName && c.coachName && p.coachName !== c.coachName) {
        changes.push(`${label}の監督が交代しました: ${p.coachName} → ${c.coachName}`);
      }
      if (p.formation && c.formation && p.formation !== c.formation) {
        changes.push(`${label}の基本布陣が変わりました: ${p.formation} → ${c.formation}`);
      }
    }
    if (section === "injuries") {
      const pc = Number.isFinite(p.injuryCount) ? p.injuryCount : null;
      const cc = Number.isFinite(c.injuryCount) ? c.injuryCount : null;
      if (pc !== null && cc !== null && pc !== cc) {
        changes.push(`${label}の負傷・出場停止者が${pc}人から${cc}人に${cc > pc ? "増え" : "減り"}ました`);
      }
    }
    if (section === "standings") {
      const pp = Number.isFinite(p.position) ? p.position : null;
      const cp = Number.isFinite(c.position) ? c.position : null;
      if (pp !== null && cp !== null && pp !== cp) {
        changes.push(`${label}の国内リーグ順位が${pp}位から${cp}位に${cp < pp ? "上がり" : "下がり"}ました`);
      }
    }
    if (section === "form") {
      const pf = Number.isFinite(p.currentFormScore) ? p.currentFormScore : null;
      const cf = Number.isFinite(c.currentFormScore) ? c.currentFormScore : null;
      if (pf !== null && cf !== null && Math.abs(cf - pf) >= 0.3) {
        changes.push(`${label}の直近フォーム(1試合平均得失点差)が${pf}から${cf}へ${cf > pf ? "上向き" : "下向き"}ました`);
      }
    }
    // ---- 2026年8月・第三者監査が発見した「取得しているのに何も生まれない」の修正 ----
    //   毎日100クラブぶんの /transfers を呼んで保存していたのに、この差分関数に
    //   transfers の分岐が無かった。そのため changesJa は常に空で、知識も
    //   タイムラインも生まれず、保存先を読むコードも存在しなかった。
    //   = 1日100リクエストが完全に無駄になっていた。実測の差分から事実を作る。
    if (section === "transfers") {
      const prevList = Array.isArray(p.recent) ? p.recent : [];
      const curList = Array.isArray(c.recent) ? c.recent : [];
      const keyOf = (t) => `${t.playerName}|${t.direction}|${t.date || ""}`;
      const prevKeys = new Set(prevList.map(keyOf));
      const added = curList.filter((t) => t.playerName && !prevKeys.has(keyOf(t)));
      for (const t of added.slice(0, 5)) {
        // ---- 検証で発見した「事実と逆のことを書く」欠陥の修正 ----
        //   direction の実際の値は summarizeTransfers(rag/knowledgeSource.js:74)が
        //   入れる **「加入」/「退団」** であって "in"/"out" ではない。
        //   "in" と比較していたため、加入した選手について
        //   「移籍先: 元所属クラブ」と、**逆の意味の文**を毎日生成していた。
        //   両方の表記を受け付けたうえで、判別できない場合は
        //   相手クラブの役割を断定しない(でっち上げない)。
        const isIn = t.direction === "加入" || t.direction === "in";
        const isOut = t.direction === "退団" || t.direction === "out";
        const dir = isIn ? "加入" : isOut ? "退団" : "移籍";
        const cp = t.counterpart
          ? (isIn ? `(移籍元: ${t.counterpart})` : isOut ? `(移籍先: ${t.counterpart})` : `(相手クラブ: ${t.counterpart})`)
          : "";
        const when = t.date ? `${t.date}に` : "";
        changes.push(`${label}に${when}${t.playerName}選手の${dir}が記録されました${cp}`);
      }
      // 検証での指摘: countLast30Days は上限5件で切り詰めた件数なので、
      // 「実際の移籍件数」として書くと嘘になる。件数の断定はやめ、
      // 個別の移籍が検知できた場合だけ事実を作る。
    }
    if (section === "squad") {
      const pn = Array.isArray(p.players) ? p.players.length : null;
      const cn = Array.isArray(c.players) ? c.players.length : null;
      if (pn !== null && cn !== null && pn !== cn) {
        changes.push(`${label}の登録選手数が${pn}人から${cn}人に変わりました`);
      }
    }
    return changes;
  }

  /** 選手1人の記録を保存する(実測値のみ。取得できない項目は unavailable として明記) */
  async function savePlayer(player) {
    if (!upstashEnabled || !player || !player.id) return { saved: false };
    const key = `kb:player:${player.id}`;
    const existing = await upstashGetJSON(key).catch(() => null);
    const record = {
      ...player,
      unavailableJa: {
        marketValue: UNAVAILABLE_FIELDS_JA.marketValue,
        contractUntil: UNAVAILABLE_FIELDS_JA.contractUntil,
        preferredFoot: UNAVAILABLE_FIELDS_JA.preferredFoot,
      },
      firstSeenAt: (existing && existing.firstSeenAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // ---- 2026年8月・「選手スカウティングへの登録」調査での追加 ----
    // 新規加入・移籍・フォームの急変は、**保存の瞬間にしか分からない**
    // (前回の記録 existing と今回の値を比べるのが唯一の手段で、後から
    //  総当たりで求めるとRedisを数千回読むことになる)。ここで検知して
    //  スカウト用の小さなフィードに積む。実測値のみ・でっち上げは一切しない。
    const events = [];
    const nowIso = record.updatedAt;
    if (!existing) {
      events.push({ type: "new", labelJa: "新規登録", detailJa: `${record.teamJa || record.teamEn || "所属クラブ"}の選手として初めて記録しました` });
    } else if (player.teamEn && existing.teamEn && player.teamEn !== existing.teamEn) {
      events.push({
        type: "transfer", labelJa: "移籍",
        detailJa: `${existing.teamJa || existing.teamEn} → ${record.teamJa || record.teamEn}`,
        fromEn: existing.teamEn, toEn: player.teamEn,
      });
    }
    const prevRating = existing && existing.stats && Number(existing.stats.rating);
    const newRating = record.stats && Number(record.stats.rating);
    if (Number.isFinite(prevRating) && Number.isFinite(newRating) && prevRating > 0) {
      const delta = Math.round((newRating - prevRating) * 100) / 100;
      if (delta >= 0.15) events.push({ type: "formUp", labelJa: "フォーム急上昇", detailJa: `平均評価が ${prevRating} → ${newRating}(+${delta})`, delta });
      else if (delta <= -0.15) events.push({ type: "formDown", labelJa: "フォーム急下降", detailJa: `平均評価が ${prevRating} → ${newRating}(${delta})`, delta });
    }
    // 若手有望株: 21歳以下で、出場時間と評価がともに実測できている場合のみ
    const age = Number(record.age);
    const minutes = record.stats && Number(record.stats.minutes);
    if (Number.isFinite(age) && age <= 21 && Number.isFinite(minutes) && minutes >= 450 && Number.isFinite(newRating) && newRating >= 6.8) {
      const prevMinutes = existing && existing.stats && Number(existing.stats.minutes);
      // 毎日同じ選手を積まないよう、出場時間が実際に増えた日だけ記録する
      if (!Number.isFinite(prevMinutes) || minutes > prevMinutes) {
        events.push({ type: "prospect", labelJa: "若手有望株", detailJa: `${age}歳・出場${minutes}分・平均評価${newRating}`, age, minutes, rating: newRating });
      }
    }

    const ok = await upstashSetJSON(key, record);
    if (ok !== false && !existing) {
      await upstashCmd(["INCR", "kb:player:count"]).catch(() => {});
    }
    if (ok !== false && events.length) {
      for (const ev of events) {
        await upstashCmd(["LPUSH", "kb:player:scoutfeed", JSON.stringify({
          ...ev, playerId: record.id, name: record.name || null,
          teamEn: record.teamEn || null, teamJa: record.teamJa || null,
          position: record.position || null, at: nowIso,
        })]).catch(() => {});
      }
      await upstashCmd(["LTRIM", "kb:player:scoutfeed", "0", String(SCOUT_FEED_KEEP - 1)]).catch(() => {});
    }
    return { saved: ok !== false, isNew: !existing, events };
  }

  async function getPlayer(playerId) {
    if (!upstashEnabled || !playerId) return null;
    return (await upstashGetJSON(`kb:player:${playerId}`).catch(() => null)) || null;
  }

  // ---- 2026年8月・「選手スカウティングへの登録」調査で判明した断絶への対処 ----
  //   収集済みの選手記録(kb:player:<id>)は480件あったのに、
  //   `getPlayer()` の呼び出し元が**1箇所も存在せず**、
  //   `kb:player:*` を列挙する手段(SCAN/索引)も無かった。
  //   つまり「集めてはいるが、画面からは1件も引けない」状態。
  //   画面の選手検索は index.html に直書きされた107人だけが対象だった。
  //   名前→IDの小さな索引を1キーに持ち、検索1回=読み1回で引けるようにする。
  //   (statsIndexと同じ設計。数千人でも数百KBに収まる)
  async function getSearchIndex() {
    if (!upstashEnabled) return {};
    return (await upstashGetJSON("kb:player:searchIndex").catch(() => null)) || {};
  }
  async function saveSearchIndex(index) {
    if (!upstashEnabled || !index) return false;
    return (await upstashSetJSON("kb:player:searchIndex", index)) !== false;
  }

  /**
   * 名前で選手を探す。索引は "name|teamEn|teamJa|position" の圧縮形式。
   * 完全一致 → 前方一致 → 部分一致 の順に並べる(同点なら名前順で安定させる)。
   */
  async function searchPlayers(query, opts) {
    const limit = Math.max(1, Math.min(50, (opts && opts.limit) || 10));
    if (!upstashEnabled) return { available: false, reasonJa: "保存先(Upstash)が未設定のため、収集済み選手を検索できません。", results: [] };
    const index = await getSearchIndex();
    const ids = Object.keys(index || {});
    const q = normalizeForSearch(query);
    if (!q) return { available: true, indexedCount: ids.length, results: [] };
    const scored = [];
    for (const id of ids) {
      const parts = String(index[id]).split("|");
      const name = parts[0] || "";
      const n = normalizeForSearch(name);
      if (!n) continue;
      let score = null;
      if (n === q) score = 0;
      else if (n.startsWith(q)) score = 1;
      else if (n.includes(q)) score = 2;
      else if (n.split(" ").some((w) => w.startsWith(q))) score = 3;
      if (score === null) continue;
      scored.push({ score, id: Number(id) || id, name, teamEn: parts[1] || null, teamJa: parts[2] || null, position: parts[3] || null });
    }
    scored.sort((a, b) => (a.score - b.score) || a.name.localeCompare(b.name));
    return { available: true, indexedCount: ids.length, results: scored.slice(0, limit) };
  }

  /** スカウト用フィード(新規登録・移籍・若手有望株・フォーム急変)の直近ぶん */
  async function getScoutFeed(limit) {
    if (!upstashEnabled) return { available: false, reasonJa: "保存先(Upstash)が未設定です。", items: [] };
    const n = Math.max(1, Math.min(SCOUT_FEED_KEEP, Number(limit) || 40));
    const raw = (await upstashCmd(["LRANGE", "kb:player:scoutfeed", "0", String(n - 1)]).catch(() => [])) || [];
    const items = raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    return { available: true, items };
  }

  // ---- 第8次監査(Critical)の修正: 選手の「更新の古い順」インデックス ----
  // 従来、日次収集の選手詳細ステージは「どの選手が最も古いか」を知るためだけに
  // 候補全員(約2,500〜3,000人)の記録を毎日1件ずつ読んでいた(Upstash無料枠
  // 1日10,000コマンドの3割前後を消費し、選手3万人規模では枠を単独で超える)。
  // playerId→statsUpdatedAt の小さな索引を1キーに持ち、読み1回・書き1回にする。
  async function getStatsIndex() {
    if (!upstashEnabled) return {};
    return (await upstashGetJSON("kb:player:statsIndex").catch(() => null)) || {};
  }
  async function saveStatsIndex(index) {
    if (!upstashEnabled || !index) return false;
    return (await upstashSetJSON("kb:player:statsIndex", index)) !== false;
  }

  /**
   * 蓄積状況のまとめ(ご指示の最終確認「何クラブ・何選手・何件」に答えるための実測)。
   * 「実装しました」ではなく「実際に何件入っているか」を返す。
   */
  async function getCoverageSummary() {
    if (!upstashEnabled) return { available: false, reasonJa: "保存先(Upstash)が未設定です。" };
    const slugs = (await upstashCmd(["LRANGE", "kb:club:index", "0", "-1"]).catch(() => [])) || [];
    const playerCount = Number(await upstashCmd(["GET", "kb:player:count"]).catch(() => 0)) || 0;
    const clubs = [];
    const sectionCounts = {};
    let staleClubs = 0;
    const now = Date.now();
    for (const slug of slugs) {
      const d = await upstashGetJSON(`kb:club:${slug}`).catch(() => null);
      if (!d) continue;
      const sections = Object.keys(d.sections || {});
      sections.forEach((s) => { sectionCounts[s] = (sectionCounts[s] || 0) + 1; });
      const updatedMs = new Date(d.updatedAt || 0).getTime();
      const ageHours = Number.isFinite(updatedMs) ? Math.round((now - updatedMs) / 3600000) : null;
      if (ageHours === null || ageHours > 72) staleClubs++;
      clubs.push({
        nameJa: d.nameJa, nameEn: d.nameEn, tier: d.tier,
        sectionsStored: sections.length, lastUpdatedHoursAgo: ageHours,
        recentChanges: (d.lastChangesJa || []).length,
      });
    }
    return {
      available: true,
      clubCount: clubs.length,
      playerCount,
      sectionCounts,
      staleClubs,
      staleNoteJa: staleClubs > 0 ? `${staleClubs}クラブは72時間以上更新されていません(輪番の周期内であれば正常です)。` : null,
      clubs: clubs.sort((a, b) => (b.sectionsStored - a.sectionsStored)),
      unavailableFieldsJa: UNAVAILABLE_FIELDS_JA,
    };
  }

  return {
    getDossier, updateSection, savePlayer, getPlayer, getStatsIndex, saveStatsIndex, getCoverageSummary, slugOf,
    getSearchIndex, saveSearchIndex, searchPlayers, getScoutFeed,
  };
}

module.exports = { createClubDossier, UNAVAILABLE_FIELDS_JA, slugOf, normalizeForSearch, SCOUT_FEED_KEEP };
