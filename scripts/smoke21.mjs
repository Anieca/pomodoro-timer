import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 「原本を読めないまま起動 → 保存で原本を上書き」経路が main 側で閉じているかの検証:
//  D) 読めない原本 → 保存時に .unreadable- へ退避してから書き込む(原本のバイト列は保全)
//  E) 退避そのものができない(rename が権限で失敗) → 保存を中止し、原本は無傷のまま
//  F) 置き換えデータを書けない → 原本を退避も削除もしない(正本を消してから失敗しない)
//  G) 最初の保存が終了時の同期保存だった場合 → 退避先をネイティブダイアログで知らせる
const APP_DIR = path.resolve(import.meta.dirname, '..');
const EXE = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

async function launch(userData) {
  const app = await electron.launch({
    executablePath: EXE, args: ['--no-sandbox', APP_DIR],
    env: { ...process.env, POMODORO_USER_DATA: userData }, timeout: 30000
  });
  // ネイティブモーダルは応答者がおらずテストを固めるため、記録用に差し替える。
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBoxSync = opts => { globalThis.__dialogs.push(opts); return 0; };
    dialog.showErrorBox = (title, content) => { globalThis.__dialogs.push({ title, detail: content }); };
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#startBtn', { timeout: 15000 });
  await page.waitForTimeout(300); // init の consumeLoadWarning / render 完了待ち
  return { app, page };
}

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
const dataFile = ud => path.join(ud, 'pomodoro-data.json');
const preserved = ud => fs.readdirSync(ud).filter(f => f.startsWith('pomodoro-data.json.unreadable-'));
// 退避ファイルは原本の mode(000)を引き継ぐため、読む前に権限を戻す。
const readForced = f => { fs.chmodSync(f, 0o600); return fs.readFileSync(f, 'utf8'); };
const dialogs = app => app.evaluate(() => globalThis.__dialogs);

const ORIGINAL = JSON.stringify({
  tasks: [{ id: 'keep1', title: '読めない原本のタスク', completed: false, createdAt: new Date().toISOString(), completedAt: null }],
  sessions: [], selectedTaskId: null, settings: {}
});

async function addTask(page, title) {
  await page.fill('#taskInput', title);
  await page.evaluate(() => document.querySelector('#taskForm button').click());
}
const toastText = page => page.evaluate(() => {
  const el = document.querySelector('#toast');
  return { hidden: el.hidden, text: el.textContent };
});
// 保存の IPC 往復は固定待ちだと取りこぼす(起動時の警告トーストを読んでしまう)ため、
// 期待するトーストが出るまで待ってから内容を返す。
async function waitToast(page, re) {
  await page.waitForFunction(
    src => { const el = document.querySelector('#toast'); return !el.hidden && new RegExp(src).test(el.textContent); },
    re.source, { timeout: 10000 }
  );
  return toastText(page);
}

// root で実行すると chmod 000 でも読めてしまい、前提が成立しない。
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.log('skip: root では chmod による読み取り不可を再現できない');
  process.exit(0);
}

/* ===== D: 読めない原本は退避してから上書きされる ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), ORIGINAL);
  fs.chmodSync(dataFile(ud), 0o000);

  const { app, page } = await launch(ud);
  const before = await page.evaluate(() => document.querySelectorAll('#taskList .task-item').length);
  const warn = await toastText(page);
  assert(before === 0, 'D: 読めない原本では空起動');
  assert(!warn.hidden && /読み込めませんでした/.test(warn.text), 'D: 読み込み失敗を起動時に警告');
  assert(preserved(ud).length === 0, 'D: 読み込み時点では退避しない(保存要求まで保留)');

  await addTask(page, '新しいタスク');
  const notice = await waitToast(page, /退避しました/);
  const bk = preserved(ud);
  console.log('D: preserved=', bk, 'toast=', JSON.stringify(notice));
  assert(bk.length === 1, 'D: 保存時に原本を .unreadable- へ退避');
  assert(readForced(path.join(ud, bk[0])) === ORIGINAL, 'D: 退避ファイルは原本のバイト列を保全');
  assert(!notice.hidden && /退避/.test(notice.text), 'D: 退避したことをトーストで通知');

  const written = JSON.parse(fs.readFileSync(dataFile(ud), 'utf8'));
  assert(written.tasks.some(t => t.title === '新しいタスク'), 'D: 退避後は通常どおり保存できる');
  assert(!written.tasks.some(t => t.id === 'keep1'), 'D: 新ファイルは空データから始まる(原本は退避側)');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== E: 退避できないなら保存しない ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), ORIGINAL);
  fs.chmodSync(dataFile(ud), 0o000);
  // 退避(rename)だけを失敗させたい。ディレクトリを書き込み不可にすると rename は
  // EACCES になるが、.tmp の作成も巻き添えで落ちて退避処理まで到達しない。
  // .tmp を先に作っておけば「既存ファイルへの上書き」はディレクトリエントリを
  // 作らないため書き込みは通り、rename だけが落ちる。
  fs.writeFileSync(dataFile(ud) + '.tmp', '');
  fs.chmodSync(dataFile(ud) + '.tmp', 0o600);
  fs.chmodSync(ud, 0o500);

  const { app, page } = await launch(ud);
  await addTask(page, '保存されないはずのタスク');
  const notice = await waitToast(page, /中止/);
  console.log('E: toast=', JSON.stringify(notice));
  assert(!notice.hidden && /中止/.test(notice.text), 'E: 退避に失敗したら保存を中止した旨を通知');
  assert(fs.existsSync(dataFile(ud)), 'E: 原本が残っている');
  assert(preserved(ud).length === 0, 'E: 退避ファイルは作られない');

  await app.close();
  fs.chmodSync(ud, 0o700);
  assert(readForced(dataFile(ud)) === ORIGINAL, 'E: 原本のバイト列は無傷');
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== F: 置き換えを書けないときは原本を動かさない ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), ORIGINAL);
  fs.chmodSync(dataFile(ud), 0o000);
  fs.mkdirSync(dataFile(ud) + '.tmp');           // .tmp への writeFileSync を EISDIR で失敗させる

  const { app, page } = await launch(ud);
  await addTask(page, '書き込めないタスク');
  const notice = await waitToast(page, /保存に失敗/);
  console.log('F: toast=', JSON.stringify(notice));
  assert(!notice.hidden && /保存に失敗/.test(notice.text), 'F: 保存失敗をトーストで通知');
  assert(fs.existsSync(dataFile(ud)), 'F: 正本が消えていない');
  assert(preserved(ud).length === 0, 'F: 書き込み前に原本を退避してしまわない');
  assert(readForced(dataFile(ud)) === ORIGINAL, 'F: 原本のバイト列は無傷');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

/* ===== G: 終了時の同期保存が最初の退避になる場合も退避先を伝える ===== */
{
  const ud = mkdir();
  fs.writeFileSync(dataFile(ud), ORIGINAL);
  fs.chmodSync(dataFile(ud), 0o000);

  const { app, page } = await launch(ud);
  // 非同期保存を一度も経ずに終了した状況(beforeunload の同期保存が最初の保存)。
  const res = await page.evaluate(() =>
    window.api.saveDataSync({ tasks: [], sessions: [], selectedTaskId: null, settings: {} }));
  const bk = preserved(ud);
  const shown = await dialogs(app);
  console.log('G: res=', JSON.stringify(res), 'dialogs=', JSON.stringify(shown));
  assert(res && res.ok === true, 'G: 同期保存は成功する');
  assert(bk.length === 1, 'G: 同期保存でも原本を退避する');
  assert(shown.length === 1, 'G: ダイアログを1回だけ出す');
  assert(shown[0] && shown[0].detail.includes(bk[0]), 'G: 退避先のパスを伝える');

  await app.close();
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(process.exitCode ? '\nsmoke21: FAILED' : '\nsmoke21: OK');
