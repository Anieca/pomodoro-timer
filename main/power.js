'use strict';
// システムスリープ。眠っていた間は作業していないので、実働から除けるよう
// 両端の時刻をレンダラへ渡す。
//
// 時刻を持つのが main なのは、suspend の通知をレンダラが処理し切る前にプロセスが
// 凍結されうるため。片方でも取り逃すと睡眠時間が分からず、いま実働として計上されて
// いる分(下記)を直せない。復帰時にまとめて伝えれば取りこぼしがない。
//
// 現状レンダラは、復帰時の tick で予定終了(endAt)を過ぎているのを見つけて
// セッションを完了させる。実働区間は endAt でクリップされるため実時間が数時間に
// 膨らむことはないが、逆に「予定していた25分ぶんを丸ごと実働として計上する」ことに
// なっている。蓋を閉じて3時間後に開けても 25 分集中したことになってしまう。
const { powerMonitor } = require('electron');
const { sendToMain } = require('./windows');

let suspendedAt = null;

function watchPower() {
  powerMonitor.on('suspend', () => {
    suspendedAt = Date.now();
    // 眠る前にレンダラへ知らせておくのが肝。復帰直後は tick(250ms)が power:resume
    // より先に走りうるので、そこで予定終了の超過を検知されると補正が届く前に
    // セッションが完了扱いになる。眠る前に旗を立てておけば到着順に依存せず、
    // 復帰後の tick は必ず補正を待つ。
    sendToMain('power:suspend');
  });
  powerMonitor.on('resume', () => {
    const suspendAt = suspendedAt;
    suspendedAt = null;
    // suspend を観測できていない復帰では睡眠時間が分からない。誤った補正は実働の
    // 捏造になるので、分からないときは触らない(旗も立っていないので送らない)。
    if (suspendAt === null) return;
    const resumeAt = Date.now();
    // 時計が巻き戻ったときは補正できないが、旗を下ろすために通知自体は送る。
    sendToMain('power:resume', resumeAt > suspendAt ? { suspendAt, resumeAt } : null);
  });
}

module.exports = { watchPower };
