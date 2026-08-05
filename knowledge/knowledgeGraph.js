/**
 * server/knowledge/knowledgeGraph.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑲「Knowledge Engineの構造化」の実装。
 *
 * ■ ご指示の原文
 *   「Knowledge Engineを単なる保存場所ではなく、AIが推論しやすい形へ構造化して
 *     ください。クラブ→監督→戦術→選手→怪我→フォーメーション→試合→分析→学習結果
 *     というように相互に関連付けられる構造へしてください。
 *     Knowledge Graphが必要なら遠慮なく設計変更してください。」
 *
 * ■ なぜ作り直したか(既存 relationshipIndex.js の限界)
 *   既存の実装は `graph:<type>:<id>:<relation>` という1本のキーに1つの相手を
 *   書くだけのものでした。正直に書かれた制約のとおり、
 *     ・逆방향の探索ができない(「この監督が率いているクラブは?」が引けない)
 *     ・1対多が表現できない(クラブに所属する選手は複数いる)
 *     ・複数ホップの探索が、あらかじめ決めた一本道しか辿れない
 *   という状態で、ご指示の「相互に関連付けられる構造」には届いていませんでした。
 *
 * ■ 新しい設計(Upstashの単純なKVS+リストだけで作る、本物の有向グラフ)
 *   ノード:  kg:node:<type>:<id>            … { type, id, labelJa, attrs, updatedAt }
 *   出る辺:  kg:out:<type>:<id>             … [ edgeKey, ... ](リスト)
 *   入る辺:  kg:in:<type>:<id>              … [ edgeKey, ... ](リスト)  ←これが逆探索を可能にする
 *   辺の本体: kg:edge:<edgeKey>              … { from, to, relation, sinceAt, meta }
 *   edgeKey = <fromType>|<fromId>|<relation>|<toType>|<toId> (安定・重複排除できる)
 *
 *   これにより、
 *     ・1対多(クラブ→複数の選手)が自然に表現できる
 *     ・逆探索(選手→所属クラブ、監督→率いたクラブ)ができる
 *     ・幅優先探索で「クラブから3ホップ以内にある知識」をまとめて集められる
 *     ・2つのノードの間の経路を求め、**日本語で説明**できる
 *   ようになります。最後の「経路を日本語で説明できる」ことが、
 *   「AIが推論しやすい形」というご指示の本質だと考えました。
 *   単に保存できるだけでは推論に使えず、
 *   「なぜこの選手の怪我がこのクラブの予測に効くのか」を辿って言葉にできて
 *   初めて、利用者に説明できるAIになるためです。
 *
 * ■ 正直な制約
 *   ・Upstashは1コマンド1リクエストなので、探索の深さ・幅には上限を設けています
 *     (既定: 深さ3・1ノードあたり20辺・訪問ノード60件)。無制限に辿ると
 *     Redisへのリクエストが爆発するためで、上限に達した場合はその旨を返します。
 *   ・グラフに入るのは、Knowledge Engineが実データから保存した関係だけです。
 *     AIが「関係がありそう」と推測した辺は入れません(でっち上げ防止)。
 */

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_EDGES_PER_NODE = 20;
const DEFAULT_MAX_VISITED = 60;
const EDGE_LIST_CAP = 60; // 1ノードあたりに保持する辺の上限(古いものから捨てる)

// 関係の日本語ラベル。経路を日本語で説明するために使う。
// ここに無い関係もそのまま扱えるが、説明文はやや素っ気なくなる。
const RELATION_LABELS_JA = {
  manager: "の監督は",
  managedBy: "を率いているのは",
  previousClub: "の前職は",
  tacticalStyle: "の戦術傾向は",
  formationTendency: "の基本布陣は",
  preferredFormation: "が好む布陣は",
  usesFormation: "が採用している布陣は",
  hasPlayer: "に所属しているのは",
  club: "が所属しているのは",
  injured: "で離脱中なのは",
  suspended: "で出場停止なのは",
  transferredIn: "に加入したのは",
  transferredOut: "から退団したのは",
  playedMatch: "が戦った試合は",
  analyzedBy: "について分析したのは",
  learnedFrom: "から学んだことは",
  topScorer: "の得点王は",
  inLeague: "が所属するリーグは",
  rivalOf: "のライバルは",
};

// 逆向きの関係名(逆探索の結果を自然な日本語にするため)
const INVERSE_RELATION = {
  manager: "managedBy",
  managedBy: "manager",
  hasPlayer: "club",
  club: "hasPlayer",
  transferredIn: "transferredOut",
  transferredOut: "transferredIn",
};

const TYPE_LABELS_JA = {
  team: "クラブ", person: "人物", coach: "監督", player: "選手",
  formation: "布陣", tactic: "戦術", match: "試合", league: "リーグ",
  injury: "離脱", analysis: "分析", lesson: "学習結果",
};

function edgeKeyOf(fromType, fromId, relation, toType, toId) {
  return [fromType, fromId, relation, toType, toId].map((v) => String(v).replace(/\|/g, "/")).join("|");
}
function parseEdgeKey(key) {
  const [fromType, fromId, relation, toType, toId] = String(key || "").split("|");
  return { fromType, fromId, relation, toType, toId };
}
function nodeIdOf(type, id) {
  return `${type}:${id}`;
}

function createKnowledgeGraph({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON }) {
  /**
   * ノード(クラブ・選手・監督・布陣など)を登録する。
   * 既にある場合は属性を上書きせず、与えられたものだけ更新する
   * (知らない情報でノードを空にしてしまわないため)。
   */
  async function upsertNode(type, id, { labelJa, attrs } = {}) {
    if (!upstashEnabled || !type || !id) return { saved: false, reason: "INVALID" };
    const key = `kg:node:${type}:${id}`;
    let existing = null;
    try { existing = await upstashGetJSON(key); } catch (e) { return { saved: false, reason: "LOOKUP_FAILED" }; }
    const node = {
      type, id,
      labelJa: labelJa || (existing && existing.labelJa) || id,
      attrs: { ...((existing && existing.attrs) || {}), ...(attrs || {}) },
      firstSeenAt: (existing && existing.firstSeenAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const ok = await upstashSetJSON(key, node);
    return { saved: ok !== false, node };
  }

  async function getNode(type, id) {
    if (!upstashEnabled || !type || !id) return null;
    return (await upstashGetJSON(`kg:node:${type}:${id}`).catch(() => null)) || null;
  }

  /**
   * 有向の辺を張る。両端のノードも自動で作られる。
   * 「入る辺」の索引も同時に更新するため、逆方向の探索ができるようになる。
   *
   * @param {object} edge - { fromType, fromId, relation, toType, toId,
   *                          fromLabelJa?, toLabelJa?, meta?, sinceAt? }
   */
  async function addEdge(edge) {
    if (!upstashEnabled) return { saved: false, reason: "NO_UPSTASH" };
    const e = edge || {};
    if (!e.fromType || !e.fromId || !e.relation || !e.toType || !e.toId) {
      return { saved: false, reason: "INVALID_EDGE" };
    }
    const key = edgeKeyOf(e.fromType, e.fromId, e.relation, e.toType, e.toId);
    // 同じ辺が既にあるなら、観測日時だけ更新して重複登録しない
    let existing = null;
    try { existing = await upstashGetJSON(`kg:edge:${key}`); } catch (err) { /* 読めなくても続行する */ }

    const record = {
      from: { type: e.fromType, id: e.fromId },
      to: { type: e.toType, id: e.toId },
      relation: e.relation,
      meta: e.meta || null,
      // 「いつからその関係か」。監督の就任日などが分かる場合に入る。
      sinceAt: e.sinceAt || (existing && existing.sinceAt) || null,
      firstSeenAt: (existing && existing.firstSeenAt) || new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    await upstashSetJSON(`kg:edge:${key}`, record);
    await upsertNode(e.fromType, e.fromId, { labelJa: e.fromLabelJa });
    await upsertNode(e.toType, e.toId, { labelJa: e.toLabelJa });

    // 監査で発見した欠陥の修正(knowledgeStoreで起きたのと同じ「幽霊」問題):
    //   索引に載せるのを「新規のときだけ」にしていたため、上限(60件)から
    //   押し出された辺は、次に同じ関係を観測しても索引へ戻る機会が無く、
    //   **本体はRedisに残っているのに永久に辿れない**状態になっていた。
    //   しかも索引は古い順に捨てられるので、最初に張られる「クラブ→監督」のような
    //   重要な関係から先に消え、毎日増える試合の辺が残るという最悪の順序だった。
    //   索引に載っているか毎回確認し、無ければ載せ直す。
    const outKey = `kg:out:${e.fromType}:${e.fromId}`;
    const inKey = `kg:in:${e.toType}:${e.toId}`;
    const ensureIndexed = async (listKey) => {
      try {
        const list = (await upstashCmd(["LRANGE", listKey, "0", "-1"])) || [];
        if (list.includes(key)) return false;
        await upstashCmd(["RPUSH", listKey, key]).catch(() => {});
        await upstashCmd(["LTRIM", listKey, String(-EDGE_LIST_CAP), "-1"]).catch(() => {});
        return true;
      } catch (err) { return false; }
    };
    const reIndexedOut = await ensureIndexed(outKey);
    const reIndexedIn = await ensureIndexed(inKey);
    return { saved: true, created: !existing, reIndexed: (!!existing && (reIndexedOut || reIndexedIn)), key };
  }

  /** 索引に入っている辺の総数(上限で切ったかどうかの判定に使う) */
  async function countEdges(listKey) {
    try {
      const l = (await upstashCmd(["LRANGE", listKey, "0", "-1"])) || [];
      return l.length;
    } catch (e) { return 0; }
  }

  /** そのノードから出ている辺(1対多に対応) */
  async function getOutEdges(type, id, limit = DEFAULT_MAX_EDGES_PER_NODE) {
    if (!upstashEnabled || !type || !id) return [];
    const keys = (await upstashCmd(["LRANGE", `kg:out:${type}:${id}`, String(-limit), "-1"]).catch(() => [])) || [];
    const out = [];
    for (const k of keys) {
      const rec = await upstashGetJSON(`kg:edge:${k}`).catch(() => null);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** そのノードへ入ってきている辺(逆探索。既存実装ではできなかったこと) */
  async function getInEdges(type, id, limit = DEFAULT_MAX_EDGES_PER_NODE) {
    if (!upstashEnabled || !type || !id) return [];
    const keys = (await upstashCmd(["LRANGE", `kg:in:${type}:${id}`, String(-limit), "-1"]).catch(() => [])) || [];
    const out = [];
    for (const k of keys) {
      const rec = await upstashGetJSON(`kg:edge:${k}`).catch(() => null);
      if (rec) out.push(rec);
    }
    return out;
  }

  /**
   * あるノードを起点に、向きを問わず(両方向)たどれる範囲を集める。
   * ご指示の「クラブ→監督→戦術→選手→怪我→布陣→試合→分析→学習結果」という
   * 連鎖は、この探索1回でまとめて取れる。
   *
   * @returns {{ center, nodes: [], edges: [], truncated: boolean, visitedCount }}
   */
  async function getNeighborhood(type, id, opts = {}) {
    const maxDepth = Math.max(1, Math.min(4, opts.maxDepth || DEFAULT_MAX_DEPTH));
    const maxVisited = Math.max(5, Math.min(200, opts.maxVisited || DEFAULT_MAX_VISITED));
    const edgesPerNode = Math.max(1, Math.min(40, opts.maxEdgesPerNode || DEFAULT_MAX_EDGES_PER_NODE));
    if (!upstashEnabled || !type || !id) {
      return { center: null, nodes: [], edges: [], truncated: false, visitedCount: 0, reasonJa: "Upstashが設定されていないため、知識グラフを読み出せません。" };
    }
    const seenNodes = new Map();
    const seenEdges = new Map();
    let truncated = false;
    const queue = [{ type, id, depth: 0 }];
    seenNodes.set(nodeIdOf(type, id), { type, id, depth: 0 });

    while (queue.length) {
      const cur = queue.shift();
      if (cur.depth >= maxDepth) continue;
      if (seenNodes.size >= maxVisited) { truncated = true; break; }
      const [outs, ins, outTotal, inTotal] = await Promise.all([
        getOutEdges(cur.type, cur.id, edgesPerNode),
        getInEdges(cur.type, cur.id, edgesPerNode),
        countEdges(`kg:out:${cur.type}:${cur.id}`),
        countEdges(`kg:in:${cur.type}:${cur.id}`),
      ]);
      // 監査の指摘への対応: 1ノードあたりの読み取り上限(既定20)で切れた場合も
      // 「全部を見た」ことにしていた。切ったなら必ずそう伝える。
      if (outTotal > edgesPerNode || inTotal > edgesPerNode) truncated = true;
      for (const e of [...outs, ...ins]) {
        const ek = edgeKeyOf(e.from.type, e.from.id, e.relation, e.to.type, e.to.id);
        if (!seenEdges.has(ek)) seenEdges.set(ek, { ...e, depth: cur.depth + 1 });
        // 反対側のノードを次の探索対象に入れる
        const other = (e.from.type === cur.type && e.from.id === cur.id) ? e.to : e.from;
        const ok = nodeIdOf(other.type, other.id);
        if (!seenNodes.has(ok)) {
          if (seenNodes.size >= maxVisited) { truncated = true; break; }
          seenNodes.set(ok, { type: other.type, id: other.id, depth: cur.depth + 1 });
          queue.push({ type: other.type, id: other.id, depth: cur.depth + 1 });
        }
      }
    }

    // ノードの表示名を補う(1件ずつ読むのでノード数の上限が効いている)
    const nodes = [];
    for (const n of seenNodes.values()) {
      const full = await getNode(n.type, n.id);
      nodes.push({ ...n, labelJa: (full && full.labelJa) || n.id, attrs: (full && full.attrs) || {} });
    }
    return {
      center: { type, id },
      nodes,
      edges: Array.from(seenEdges.values()),
      truncated,
      visitedCount: seenNodes.size,
      reasonJa: truncated
        ? `関連が多いため、${maxVisited}件までで探索を打ち切りました(全体を辿ったわけではありません)。`
        : null,
    };
  }

  /**
   * 2つのノードの間の最短経路を求め、**日本語で説明する**。
   * これが「AIが推論しやすい形」というご指示の核心。
   * 例: 「レアル・マドリード の監督は アンチェロッティ / が好む布陣は 4-3-3」
   *
   * @returns {{found, path: [], explanationJa: string}}
   */
  async function explainConnection(fromType, fromId, toType, toId, opts = {}) {
    const maxDepth = Math.max(1, Math.min(4, opts.maxDepth || DEFAULT_MAX_DEPTH));
    if (!upstashEnabled) return { found: false, path: [], explanationJa: "知識グラフを読み出せません(保存先が未設定です)。" };
    const startKey = nodeIdOf(fromType, fromId);
    const goalKey = nodeIdOf(toType, toId);
    if (startKey === goalKey) return { found: true, path: [], explanationJa: "同じ対象です。" };

    const prev = new Map([[startKey, null]]);
    const queue = [{ type: fromType, id: fromId, depth: 0 }];
    let hit = null;
    while (queue.length && !hit) {
      const cur = queue.shift();
      if (cur.depth >= maxDepth) continue;
      const [outs, ins] = await Promise.all([
        getOutEdges(cur.type, cur.id),
        getInEdges(cur.type, cur.id),
      ]);
      for (const e of [...outs, ...ins]) {
        const other = (e.from.type === cur.type && e.from.id === cur.id) ? e.to : e.from;
        const ok = nodeIdOf(other.type, other.id);
        if (prev.has(ok)) continue;
        prev.set(ok, { edge: e, fromKey: nodeIdOf(cur.type, cur.id) });
        if (ok === goalKey) { hit = ok; break; }
        queue.push({ type: other.type, id: other.id, depth: cur.depth + 1 });
      }
    }
    if (!hit) {
      return {
        found: false, path: [],
        explanationJa: "現在たどれる知識の中に、この2つを結ぶ関係は見つかりませんでした(推測でつなぐことはしません)。",
      };
    }
    // 経路を復元する
    const steps = [];
    let cursor = hit;
    while (prev.get(cursor)) {
      const { edge, fromKey } = prev.get(cursor);
      steps.unshift({ edge, fromKey, toKey: cursor });
      cursor = fromKey;
    }
    // 監査で発見した欠陥の修正:
    //   逆向きにたどるとき、主語と目的語だけ入れ替えて**関係の言い回しはそのまま**
    //   使っていた。その結果
    //     「ムバッペから退団したのはレアル・マドリード」(実際は加入)
    //     「シャビ・アロンソを率いているのはレアル・マドリード」(主客が逆)
    //   のように、事実と逆のことを述べる文が生成されていた。
    //   逆向きの言い回しが用意されている関係だけを逆向きに読み、
    //   用意が無い関係は**必ず元の向きのまま**書く(意味を保つ)。
    const parts = [];
    for (const st of steps) {
      const e = st.edge;
      const forward = nodeIdOf(e.from.type, e.from.id) === st.fromKey;
      const hasInverse = !forward && INVERSE_RELATION[e.relation];
      const rel = hasInverse ? INVERSE_RELATION[e.relation] : e.relation;
      const label = RELATION_LABELS_JA[rel] || `の「${rel}」は`;
      // 逆向きの言い回しが無い場合は、辺の向きどおり(from→to)に書く。
      // 経路としては逆に辿っていても、述べている事実は正しいままになる。
      const subj = (forward || hasInverse) ? (forward ? e.from : e.to) : e.from;
      const obj = (forward || hasInverse) ? (forward ? e.to : e.from) : e.to;
      const subjNode = await getNode(subj.type, subj.id);
      const objNode = await getNode(obj.type, obj.id);
      parts.push(`${(subjNode && subjNode.labelJa) || subj.id}${label}${(objNode && objNode.labelJa) || obj.id}`);
    }
    return {
      found: true,
      path: steps.map((st) => st.edge),
      explanationJa: parts.join("、") + "、という関係でつながっています。",
    };
  }

  /**
   * 探索結果を、推論エンジン/LLMへ渡せる短い日本語の箇条書きにする。
   * 「AIが推論しやすい形」を、実際に推論の入力として使える形まで持っていく部分。
   */
  async function summarizeNeighborhoodJa(type, id, opts = {}) {
    const nb = await getNeighborhood(type, id, opts);
    if (!nb.edges.length) {
      return { linesJa: [], summaryJa: "このクラブについて、まだ関係として整理された知識がありません。", truncated: false };
    }
    const byId = new Map(nb.nodes.map((n) => [nodeIdOf(n.type, n.id), n]));
    const lines = nb.edges.slice(0, opts.maxLines || 20).map((e) => {
      const f = byId.get(nodeIdOf(e.from.type, e.from.id));
      const t = byId.get(nodeIdOf(e.to.type, e.to.id));
      const label = RELATION_LABELS_JA[e.relation] || `の「${e.relation}」は`;
      const since = e.sinceAt ? `(${String(e.sinceAt).slice(0, 10)}〜)` : "";
      return `${(f && f.labelJa) || e.from.id}${label}${(t && t.labelJa) || e.to.id}${since}`;
    });
    return {
      linesJa: lines,
      summaryJa: nb.truncated
        ? `関連する知識のうち${nb.edges.length}件を、${nb.nodes.length}個の対象にまたがって整理しています(関連が多いため一部のみです)。`
        : `関連する知識を${nb.edges.length}件、${nb.nodes.length}個の対象にまたがって整理しています。`,
      truncated: nb.truncated,
      nodeCount: nb.nodes.length,
      edgeCount: nb.edges.length,
    };
  }

  return {
    upsertNode, getNode, addEdge, getOutEdges, getInEdges,
    getNeighborhood, explainConnection, summarizeNeighborhoodJa,
  };
}

module.exports = {
  createKnowledgeGraph,
  RELATION_LABELS_JA, TYPE_LABELS_JA, INVERSE_RELATION,
  edgeKeyOf, parseEdgeKey,
};
