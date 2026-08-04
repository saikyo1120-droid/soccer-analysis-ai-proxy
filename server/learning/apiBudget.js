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
  // 第5次監査での追加。原子的なカウンター(INCRBY)を使うために、
  // 生のコマンドを実行できる関数を受け取れるようにする(省略可)。
  upstashCmd,
  dailyBudget = DEFAULT_DAILY_BUDGET,
  userReserve = DEFAULT_USER_RESERVE,
} = {}) {
  // 欠陥Bの修正で後から書き換えられるようにするため let にする
  let dailyBudgetMutable = dailyBudget;
  let dateKey = null;
  let spentBefore = 0; // 同じ日の他の実行で使った分(Upstashから復元)
  let spentThisRun = 0;
  let spentFlushed = 0; // このプロセスが既に書き戻した分
  let persisted = false;

  const keyFor = (dk) => `learn:apibudget:${dk}`;
  // 第5次監査で発見した「更新の取りこぼし(lost update)」対策で使う原子的カウンター。
  // 旧方式は SET key {spent: 合計} だったため、2つのプロセスが同時に書くと
  // 後から書いた方の値で上書きされ、**実際に使ったリクエストが消えて無かったことに
  // なる**(=1日の上限を超過しうる)。INCRBY は「増分を足す」ので同時実行でも壊れない。
  const counterKeyFor = (dk) => `learn:apibudget:n:${dk}`;
  const atomic = typeof upstashCmd === "function";

  async function init(dk) {
    dateKey = dk;
    spentThisRun = 0;
    spentBefore = 0;
    spentFlushed = 0;
    persisted = false;
    if (!upstashEnabled) return;
    if (atomic) {
      try {
        const raw = await upstashCmd(["GET", counterKeyFor(dk)]);
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) spentBefore = n;
        persisted = true;
      } catch (e) {
        persisted = false;
      }
      // 旧方式(JSON)で記録された当日分が残っていれば、大きい方を採る。
      // 移行日にだけ意味がある処理で、以後は自然に消える。
      if (typeof upstashGetJSON === "function") {
        try {
          const legacy = await upstashGetJSON(keyFor(dk));
          if (legacy && Number.isFinite(legacy.spent) && legacy.spent > spentBefore) {
            spentBefore = legacy.spent;
          }
        } catch (e) { /* 旧データが読めなくても続行する */ }
      }
      return;
    }
    if (typeof upstashGetJSON !== "function") return;
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

  /**
   * API-Football が全レスポンスで返す x-ratelimit-requests-remaining を使って、
   * 自前のカウンターを「本家の数字」に合わせ直す。
   *
   * 第5次監査の指摘への対応。自前カウンターは、タイムアウトしたリクエスト・
   * 別プロセスの消費・プロセス強制終了などで必ず実態からズレる。本家が
   * 「残りいくつか」を毎回教えてくれるのだから、それを正とすべき。
   * ただし**減らす方向には決して動かさない**(過小報告=上限超過事故になるため)。
   */
  function reconcileFromRemaining(remaining) {
    const rem = Number(remaining);
    if (!Number.isFinite(rem) || rem < 0) return false;
    const actualSpent = dailyBudgetMutable - rem;
    if (!Number.isFinite(actualSpent) || actualSpent <= totalSpent()) return false;
    // 差分は「自分以外が使った分」とみなして spentBefore へ寄せる
    spentBefore += actualSpent - totalSpent();
    return true;
  }

  function totalSpent() {
    return spentBefore + spentThisRun;
  }

  // 日次ジョブが使ってよい残量(利用者用の予約分を差し引いたもの)
  function remainingForJob() {
    return Math.max(0, dailyBudgetMutable - userReserve - totalSpent());
  }

  /**
   * n リクエストぶんの予算を確保できるか試す。
   * @returns {{allowed: boolean, remaining: number, reason: string|null}}
   *   allowed=false のときの reason は、そのまま利用者向けの「できなかった理由」
   *   として保存できる日本語の文字列。
   */
  // 2026年8月・再監査で発見した欠陥Aの修正:
  // userReserve は「日次ジョブが枠を使い切って、日中に利用者が何も見られなくなる」
  // ことを防ぐための予約枠だった。しかし予算チェックを callApiFootball 内へ移した
  // 結果、**利用者のリクエストまで同じ remainingForJob() を見るようになり、
  // 予約枠のぶんが誰にも使えない死んだ枠になっていた**(100の枠なら80しか使えない)。
  // 利用者のリクエストは予約枠を含む全体から確保できるようにする。
  function remainingForUser() {
    return Math.max(0, dailyBudgetMutable - totalSpent());
  }
  function tryReserveUser(n, label) {
    const need = Number(n) || 0;
    const left = remainingForUser();
    if (need <= left) { spentThisRun += need; return { allowed: true, remaining: left - need, reason: null }; }
    return {
      allowed: false, remaining: left,
      reason: `APIリクエストの1日の上限(${dailyBudgetMutable}件)に達したため${label ? `「${label}」を` : ""}実行できませんでした。明日0時(UTC)にリセットされます。`,
    };
  }

  // 欠陥Bの修正: 契約プランの自動判定は最初のAPI応答のヘッダーで初めて分かるため、
  // 予算インスタンスを作った時点ではまだ分からない(既定100のまま固定されていた)。
  // 後から判明した実際の上限を反映できるようにする。
  function updateDailyBudget(n) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0 && v !== dailyBudgetMutable) { dailyBudgetMutable = v; return true; }
    return false;
  }

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
      reason: `APIリクエストの1日の予算(${dailyBudgetMutable}件中、利用者用に${userReserve}件を確保した残り)が不足したため${label ? `「${label}」を` : ""}見送りました(必要${need}件・残り${left}件)。API_DAILY_BUDGETを引き上げる(有料プランへの移行)と自動的に再開します。`,
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
    if (!upstashEnabled || !dateKey) return false;
    if (atomic) {
      const delta = spentThisRun - spentFlushed;
      if (delta <= 0) return true; // 書き戻すものが無い
      try {
        const raw = await upstashCmd(["INCRBY", counterKeyFor(dateKey), String(delta)]);
        spentFlushed += delta;
        const total = Number(raw);
        if (Number.isFinite(total)) {
          // INCRBY の戻り値は「全プロセス合計の確定値」。自分の書き戻し済み分を
          // 引けば「自分以外が使った分」が分かる。これで他プロセスの消費も
          // 取りこぼさずに反映できる。
          spentBefore = Math.max(0, total - spentFlushed);
        }
        // 当日ぶんのキーが永久に残らないように48時間で自動削除する
        await upstashCmd(["EXPIRE", counterKeyFor(dateKey), "172800"]).catch(() => {});
        return true;
      } catch (e) {
        return false;
      }
    }
    if (typeof upstashSetJSON !== "function") return false;
    try {
      const ok = await upstashSetJSON(keyFor(dateKey), { spent: totalSpent(), updatedAt: new Date().toISOString() });
      return ok !== false;
    } catch (e) {
      return false;
    }
  }

  function summary() {
    return {
      dailyBudget: dailyBudgetMutable,
      userReserve,
      spentBeforeThisRun: spentBefore,
      spentThisRun,
      totalSpent: totalSpent(),
      remainingForJob: remainingForJob(),
      // Upstashが無いと日をまたいだ累積が取れないことを正直に示す
      persistent: persisted,
    };
  }

  return {
    init, tryReserve, tryReserveUser, canAfford, refund, flush, summary,
    totalSpent, remainingForJob, remainingForUser, updateDailyBudget,
    reconcileFromRemaining,
  };
}

module.exports = { createApiBudget, DEFAULT_DAILY_BUDGET, DEFAULT_USER_RESERVE };
