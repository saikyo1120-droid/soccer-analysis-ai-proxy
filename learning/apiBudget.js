/**
 * server/learning/apiBudget.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑦で新設した「APIリクエスト予算ガード」。
 *
 * なぜ必要か(優先順位⑨「今日追加した知識0件」の根本原因のひとつ):
 *   API-Football無料プランは1日100リクエストが上限です。日次学習ジョブが
 *   知らないうちに上限へ到達すると、以降のリクエストがすべて失敗し、
 *   「エラーが大量に出て知識が0件」という状態になります。しかもこれまでは
 *   「上限に当たったのか」「本当に変化が無かったのか」を区別できませんでした。
 *
 *   このモジュールは、1日に何リクエスト使ったかをUpstashに記録し、
 *   予算が尽きそうなときには「オプション扱いの処理」を先に諦めることで、
 *   必須の処理(欧州5大リーグの順位など)を守ります。そして諦めた場合は
 *   必ず理由を文字列として残すため、利用者は「サボった」のではなく
 *   「予算のために意図的に見送った」ことを確認できます。
 *
 * 設計方針:
 *   - 予算の総量は API_DAILY_BUDGET(既定100=無料プラン)で設定します。
 *     有料プラン(例: Pro=7500/日)へ移行した場合はこの環境変数を増やすだけで、
 *     日次ジョブが自動的により多くの選手・リーグを更新するようになります。
 *   - USER_REQUEST_RESERVE(既定20)ぶんは、実際の利用者のリクエスト用に
 *     常に空けておきます(日次ジョブが全部使い切ってしまうと、日中にアプリを
 *     開いた利用者が何も見られなくなるため)。
 *   - Upstashが未設定でも動作します(その場合は「今回の実行内での消費」だけを
 *     数え、日をまたいだ累積は行いません。正直にその旨をreasonへ残します)。
 */

const DEFAULT_DAILY_BUDGET = 100; // API-Football 無料プラン
const DEFAULT_USER_RESERVE = 20;

function createApiBudget({
  upstashEnabled,
  upstashGetJSON,
  upstashSetJSON,
  dailyBudget = DEFAULT_DAILY_BUDGET,
  userReserve = DEFAULT_USER_RESERVE,
} = {}) {
  let dateKey = null;
  let spentBefore = 0; // 同じ日の過去の実行で使った分(Upstashから復元)
  let spentThisRun = 0;
  let persisted = false;

  const keyFor = (dk) => `learn:apibudget:${dk}`;

  async function init(dk) {
    dateKey = dk;
    spentThisRun = 0;
    spentBefore = 0;
    persisted = false;
    if (!upstashEnabled || typeof upstashGetJSON !== "function") return;
    try {
      const stored = await upstashGetJSON(keyFor(dk));
      if (stored && Number.isFinite(stored.spent)) {
        spentBefore = stored.spent;
        persisted = true;
      } else {
        persisted = true; // Upstashは使えるが今日はまだ記録が無い、という正常な状態
      }
    } catch (e) {
      persisted = false;
    }
  }

  function totalSpent() {
    return spentBefore + spentThisRun;
  }

  // 日次ジョブが使ってよい残量(利用者用の予約分を差し引いたもの)
  function remainingForJob() {
    return Math.max(0, dailyBudget - userReserve - totalSpent());
  }

  /**
   * n リクエストぶんの予算を確保できるか試す。
   * @returns {{allowed: boolean, remaining: number, reason: string|null}}
   *   allowed=false のときの reason は、そのまま利用者向けの「できなかった理由」
   *   として保存できる日本語の文字列。
   */
  function tryReserve(n, label) {
    const need = Number(n) || 0;
    const left = remainingForJob();
    if (need <= left) {
      spentThisRun += need;
      return { allowed: true, remaining: left - need, reason: null };
    }
    return {
      allowed: false,
      remaining: left,
      reason: `APIリクエストの1日の予算(${dailyBudget}件中、利用者用に${userReserve}件を確保した残り)が不足したため${label ? `「${label}」を` : ""}見送りました(必要${need}件・残り${left}件)。API_DAILY_BUDGETを引き上げる(有料プランへの移行)と自動的に再開します。`,
    };
  }

  // 予算を消費せずに「あと何件いけるか」だけ知りたいとき
  function canAfford(n) {
    return (Number(n) || 0) <= remainingForJob();
  }

  // 予約したが実際には使わなかったぶんを返却する(APIを呼ぶ前に別の理由で
  // スキップした場合など。予算を過小評価したままにしないため)
  function refund(n) {
    spentThisRun = Math.max(0, spentThisRun - (Number(n) || 0));
  }

  async function flush() {
    if (!upstashEnabled || typeof upstashSetJSON !== "function" || !dateKey) return false;
    try {
      await upstashSetJSON(keyFor(dateKey), { spent: totalSpent(), updatedAt: new Date().toISOString() });
      return true;
    } catch (e) {
      return false;
    }
  }

  function summary() {
    return {
      dailyBudget,
      userReserve,
      spentBeforeThisRun: spentBefore,
      spentThisRun,
      totalSpent: totalSpent(),
      remainingForJob: remainingForJob(),
      // Upstashが無いと日をまたいだ累積が取れないことを正直に示す
      persistent: persisted,
    };
  }

  return { init, tryReserve, canAfford, refund, flush, summary, totalSpent, remainingForJob };
}

module.exports = { createApiBudget, DEFAULT_DAILY_BUDGET, DEFAULT_USER_RESERVE };
