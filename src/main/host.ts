// エンジンを回す場所。状態・時計・保存を一手に持ち、変わったら購読者に知らせる。
// 画面(メイン・ミニ)も Tray も、ここから同じ状態を受け取って描くだけ。
import { EventEmitter } from 'node:events';
import { reduce, type Command, type Effect } from '../core/engine.ts';
import type { Data } from '../core/model.ts';
import type { Snapshot } from '../shared/api.ts';
import { errorMessage, type Store } from './store.ts';

const PULSE_MS = 500;
/** 鼓動がこれ以上空いたら、その間プロセスは止まっていた(= 実働ではない)とみなす */
const GAP_MS = 10_000;
const RETRY_SAVE_MS = 10_000;

interface Events {
  change: [Snapshot];
  effect: [Effect];
  notice: [string];
  /** 毎回の鼓動(残り時間の表示を進める) */
  pulse: [];
}

export class Host extends EventEmitter<Events> {
  private data: Data;
  private readonly store: Store;
  private offset = 0;
  private lastPulse: number;
  private timer: NodeJS.Timeout | null = null;
  private dirtySince: number | null = null;
  private lastSaveError: string | null = null;
  private pendingNotices: string[];

  constructor(store: Store) {
    super();
    this.store = store;
    const loaded = store.load();
    this.data = loaded.data;
    this.pendingNotices = loaded.notices;
    this.lastPulse = this.now();
    // 引き継いだ内容はすぐ v2 のファイルにする(次の起動でもう一度引き継がないように)
    if (loaded.migrated) this.save();
    this.dispatch({ type: 'timer/recover' });
  }

  now(): number {
    return Date.now() + this.offset;
  }

  snapshot(): Snapshot {
    return { data: this.data, now: this.now() };
  }

  /** 起動時の知らせを一度だけ渡す */
  takeNotices(): string[] {
    const out = this.pendingNotices;
    this.pendingNotices = [];
    return out;
  }

  start(): void {
    this.timer ??= setInterval(() => this.pulse(), PULSE_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispatch(cmd: Command): void {
    // どの命令も、止まっていた時間の補正を済ませてから処理する。鼓動より先に操作が
    // 届くと(スリープ明けの一押しなど)、補正前の時計で完了が判定され、眠っていた
    // 時間までフォーカスとして記録されてしまう。補正そのもの(timer/gap)は除く。
    if (cmd.type !== 'timer/gap') this.reconcile();
    this.apply(cmd);
  }

  /** 前に生きていたのを確かめた時刻から鼓動が空きすぎていたら、その間は止まっていたとして補正する。 */
  private reconcile(): void {
    const now = this.now();
    if (now - this.lastPulse > GAP_MS) this.apply({ type: 'timer/gap', from: this.lastPulse, to: now });
    this.lastPulse = now;
  }

  private apply(cmd: Command): void {
    const result = reduce(this.data, cmd, this.now());
    if (result.data !== this.data) {
      this.data = result.data;
      this.save();
      this.emit('change', this.snapshot());
    }
    for (const effect of result.effects) this.emit('effect', effect);
  }

  /**
   * 保存データを丸ごと置き換える(インポート)。保存できてから差し替える。
   * 先に差し替えると、保存に失敗したとき「置き換えられなかった」と伝えたのに
   * 中身だけが入れ替わったまま残り、次の保存で元のデータを上書きしてしまう。
   */
  replace(data: Data): void {
    const preserved = this.store.save(data); // 失敗したら投げる(いまの状態はそのまま)
    this.data = data;
    this.dirtySince = null;
    this.lastSaveError = null;
    if (preserved) this.emit('notice', '読み込めなかった元のファイルを退避しました: ' + preserved);
    this.emit('change', this.snapshot());
  }

  /** from〜to の間は止まっていた(スリープからの復帰)。 */
  slept(from: number, to: number): void {
    this.lastPulse = to;
    this.dispatch({ type: 'timer/gap', from, to });
  }

  pulse(): void {
    // suspend の通知を取り逃しても、鼓動の飛びで止まっていたことは分かる(dispatch が補正する)
    this.dispatch({ type: 'timer/tick' });
    if (this.dirtySince !== null && Date.now() - this.dirtySince > RETRY_SAVE_MS) this.save();
    this.emit('pulse');
  }

  private save(): void {
    try {
      const preserved = this.store.save(this.data);
      this.dirtySince = null;
      this.lastSaveError = null;
      if (preserved) this.emit('notice', '読み込めなかった元のファイルを退避しました: ' + preserved);
    } catch (err) {
      this.dirtySince = Date.now();
      const message = errorMessage(err);
      // 同じ失敗を鼓動のたびに知らせない
      if (message !== this.lastSaveError) this.emit('notice', '保存できませんでした(あとでもう一度試します): ' + message);
      this.lastSaveError = message;
    }
  }

  /* ---------- テスト用の時計 ---------- */

  /** 時計を進める(その間も動いていたものとして)。 */
  advance(ms: number): void {
    this.offset += ms;
    this.lastPulse += ms;
    this.pulse();
    this.emit('change', this.snapshot());
  }

  /** 時計だけが飛ぶ(その間プロセスは止まっていた)。 */
  jump(ms: number): void {
    this.offset += ms;
    this.pulse();
    this.emit('change', this.snapshot());
  }
}
