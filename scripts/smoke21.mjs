import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 「原本を読めなかったまま起動 → 保存で原本を上書き」経路が main 側で閉じているかの検証:
//  D) 読めない原本 → 保存時に .unreadable- へ退避してから書き込む(原本のバイト列は保全)
//  E) 退避もできない(親ディレクトリが書き込み不可) → 保存を中止し、原本は無傷のまま
const APP_DIR = path.resolve(import.meta.dirname, '..');
const EXE = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

async function launch(userData) {
  const app = await electron.launch({
    executablePath: EXE, args: ['--no-sandbox', APP_DIR],
    env: { ...process.env, POMODORO_USER_DATA: userData }, timeout: 30000
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

const ORIGINAL = JSON.stringify({
  tasks: [{ id: 'keep1', title: '読めない原本のタスク', completed: false, createdAt: new Date().toISOString(), completedAt: null }],
  sessions: [], selectedTaskId: null, settings: {}
});

async function addTask(page, title) {
  await page.fill('#taskInput', title);
  await page.evaluate(() => document.querySelector('#taskForm button').click());
  await page.waitForTimeout(400); // save() の IPC 往復とトースト描画待ち
}
const toastText = page => page.evaluate(() => {
  const el = document.querySelector('#toast');
  return { hidden: el.hidden, text: el.textContent };
});

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
  const bk = preserved(ud);
  const notice = await toastText(page);
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
  fs.chmodSync(ud, 0o500);                       // rename も書き込みも不可にする

  const { app, page } = await launch(ud);
  await addTask(page, '保存されないはずのタスク');
  const notice = await toastText(page);
  console.log('E: toast=', JSON.stringify(notice));
  assert(!notice.hidden && /中止/.test(notice.text), 'E: 保存を中止した旨をトーストで通知');

  fs.chmodSync(ud, 0o700);
  assert(fs.existsSync(dataFile(ud)), 'E: 原本が残っている');
  assert(readForced(dataFile(ud)) === ORIGINAL, 'E: 原本のバイト列は無傷');
  assert(preserved(ud).length === 0, 'E: 退避ファイルは作られない');

  await app.close();
  fs.chmodSync(ud, 0o700);
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(process.exitCode ? '\nsmoke21: FAILED' : '\nsmoke21: OK');
