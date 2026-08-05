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
    const ok = await upstashSetJSON(key, record);
    if (ok !== false && !existing) {
      await upstashCmd(["INCR", "kb:player:count"]).catch(() => {});
    }
    return { saved: ok !== false, isNew: !existing };
  }

  async function getPlayer(playerId) {
    if (!upstashEnabled || !playerId) return null;
    return (await upstashGetJSON(`kb:player:${playerId}`).catch(() => null)) || null;
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

  return { getDossier, updateSection, savePlayer, getPlayer, getStatsIndex, saveStatsIndex, getCoverageSummary, slugOf };
}

module.exports = { createClubDossier, UNAVAILABLE_FIELDS_JA, slugOf };
