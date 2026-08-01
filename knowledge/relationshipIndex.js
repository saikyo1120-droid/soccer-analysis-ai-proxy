/**
 * server/knowledge/relationshipIndex.js
 * ------------------------------------------------
 * 「知識グラフ(Knowledge Graph)」のご要望に対する、正直な実装範囲の説明:
 *
 * 本格的なグラフデータベース(Neo4jのような、任意方向のグラフ探索・複雑な
 * クエリができるもの)を、npmパッケージ無し・Upstash Redis(単純なKVS+リスト)
 * だけの環境にゼロから実装するのはリスクが高く、堅牢性も保証できません。
 * そのため、ここでは「クラブ→監督」「クラブ→フォーメーション」のような
 * “一方向の関係”を素直にキー・バリューとして保存する、最小限の関係インデックス
 * を実装しています。
 *
 * できること: 「このクラブの現在の監督は誰か」のような単純な関係の保存・参照。
 * できないこと: 「この監督が率いているクラブを全部教えて」のような逆方向の探索、
 *   複数ホップをまたぐ探索(クラブ→監督→過去の所属クラブ、等)。これらが必要に
 *   なった場合は、逆引き用のインデックスを別途追加するか、本格的なグラフDBの
 *   導入を検討する必要があります(README にも明記)。
 *
 * キー形式: graph:<subjectType>:<subjectId>:<relation>
 *   例: graph:team:Bayern Munich:manager → { targetType:"person", targetId:"…", updatedAt }
 */
function createRelationshipIndex({ upstashEnabled, upstashGetJSON, upstashSetJSON }) {
  async function setRelation(subjectType, subjectId, relation, targetType, targetId, meta) {
    if (!upstashEnabled) return { saved: false, reason: "NO_UPSTASH" };
    if (!subjectType || !subjectId || !relation || !targetId) return { saved: false, reason: "INVALID_ITEM" };
    const key = `graph:${subjectType}:${subjectId}:${relation}`;
    await upstashSetJSON(key, { targetType: targetType || null, targetId, meta: meta || null, updatedAt: new Date().toISOString() });
    return { saved: true };
  }

  async function getRelation(subjectType, subjectId, relation) {
    if (!upstashEnabled || !subjectType || !subjectId || !relation) return null;
    return (await upstashGetJSON(`graph:${subjectType}:${subjectId}:${relation}`)) || null;
  }

  return { setRelation, getRelation };
}

module.exports = { createRelationshipIndex };
