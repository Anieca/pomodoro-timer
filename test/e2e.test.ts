// スモークテスト。ビルド済みのアプリ(out/)を Electron で起動し、画面から操作して確かめる。
// 時間は main の時計を進めて作る(advance = 動いていた / sleep = 止まっていた)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataFile, launchApp, legacyFile, MIN, tempUserData, type Launched } from './env.ts';

async function run(options: Parameters<typeof launchApp>[0], body: (t: Launched) => Promise<void>): Promise<void> {
  const t = await launchApp(options);
  try {
    await body(t);
    assert.deepEqual(t.errors, [], 'コンソールエラーが無い');
  } finally {
    await t.close();
  }
}

const addTask = async (t: Launched, title: string): Promise<void> => {
  await t.page.fill('#newTask', title);
  await t.page.press('#newTask', 'Enter');
  await t.page.waitForSelector(`.task-title:text-is("${title}")`);
};
const clock = (t: Launched): Promise<string> => t.page.innerText('#clock');
const expectText = (t: Launched, selector: string, text: string | RegExp): Promise<unknown> =>
  t.page.waitForFunction(([sel, src, flags]) => {
    const el = document.querySelector(sel);
    return !!el && (flags === null ? el.textContent === src : new RegExp(src, flags).test(el.textContent ?? ''));
  }, [selector, typeof text === 'string' ? text : text.source, typeof text === 'string' ? null : text.flags] as const, { timeout: 5000 });

test('タスク: 足す・選ぶ・名前を変える・終える・削除して元に戻す', () => run({}, async t => {
  const { page } = t;
  await addTask(t, '設計');
  await addTask(t, 'レビュー');
  await expectText(t, '#subject', '設計'); // 最初に足したものにそのまま向き合う
  await page.click('.task-title:text-is("レビュー")');
  await expectText(t, '#subject', 'レビュー');

  await page.hover('.task:has-text("設計")');
  await page.click('.task:has-text("設計") .task-rename');
  await page.fill('.task-edit', '設計書');
  await page.press('.task-edit', 'Enter');
  await page.waitForSelector('.task-title:text-is("設計書")');

  await page.click('.task[data-active] .check');
  await expectText(t, '#subject', '設計書'); // 終えたら残りの未完了へ移る
  await page.click('#toggleDone');
  await page.waitForSelector('#doneList .task-title:text-is("レビュー")');

  await page.hover('.task[data-active]');
  await page.click('.task[data-active] .task-delete');
  await page.waitForSelector('.task[data-id]', { state: 'detached' });
  await page.click('.toast-action');
  await page.waitForSelector('.task-title:text-is("設計書")');

  const saved = t.saved();
  assert.deepEqual(saved.tasks.map(x => [x.title, x.doneAt !== null, x.deletedAt]), [['設計書', false, null], ['レビュー', true, null]]);
}));

test('タスクはドラッグで並べ替えられる', () => run({}, async t => {
  for (const title of ['A', 'B', 'C']) await addTask(t, title);
  const c = t.page.locator('.task:has-text("C")');
  const a = t.page.locator('.task:has-text("A")');
  await c.dragTo(a, { targetPosition: { x: 40, y: 4 } });
  await t.page.waitForFunction(() => [...document.querySelectorAll('#taskList .task-title')].map(e => e.textContent).join('') === 'CAB');
  assert.deepEqual(t.saved().tasks.map(x => x.title), ['C', 'A', 'B']);
}));

test('フォーカスを完走すると記録され、休憩が続き、今日の帯に載る', () => run({}, async t => {
  const { page } = t;
  await addTask(t, 'A');
  await addTask(t, 'B');
  assert.equal(await clock(t), '25:00');
  await page.click('#toggle');
  await expectText(t, '#phase', 'フォーカス');
  await t.advance(10 * MIN);
  await expectText(t, '#clock', '15:00');
  await page.click('.task-title:text-is("B")'); // 止めずに切り替える
  await t.advance(15 * MIN);
  await expectText(t, '#phase', '小休憩');
  await expectText(t, '#clock', '05:00');
  await expectText(t, '#todayFocus', '25分');
  await expectText(t, '#todayPomos', '完走 1 回');
  assert.equal(await page.getAttribute('html', 'data-ambience'), 'pink-noise.wav', '休憩中は休憩用の音源');

  const [session] = t.saved().sessions;
  assert.equal(session.completed, true);
  assert.deepEqual(session.spans.map(s => Math.round((s.end - s.start) / MIN)), [10, 15]);
  assert.notEqual(session.spans[0].taskId, session.spans[1].taskId);

  await t.advance(5 * MIN);
  await expectText(t, '#phase', '次はフォーカス');
  assert.equal(await page.locator('#cycle i[data-on]').count(), 1);
  assert.equal(await page.locator('.rail .block').count(), 3);
  assert.equal(await page.getAttribute('html', 'data-ambience'), '');
}));

test('一時停止・延長・中断', () => run({}, async t => {
  const { page } = t;
  await page.keyboard.press('Space');
  await expectText(t, '#toggle', '一時停止');
  assert.equal(await page.getAttribute('html', 'data-ambience'), 'brown-noise.wav');
  await t.advance(5 * MIN);
  await page.click('#toggle');
  await expectText(t, '#phase', 'フォーカス・一時停止中');
  await t.advance(30 * MIN);
  assert.equal(await clock(t), '20:00', '一時停止中は減らない');
  await page.click('#extend');
  await expectText(t, '#clock', '25:00');
  await page.click('#toggle');
  await t.advance(2 * MIN);
  await page.click('#stop');
  await expectText(t, '#phase', '次はフォーカス');
  const [session] = t.saved().sessions;
  assert.equal(session.completed, false);
  assert.equal(session.plannedSec, 30 * 60);
  assert.equal(session.spans.length, 2);
}));

test('スリープはフォーカスの実働に入らない', () => run({}, async t => {
  await t.page.click('#toggle');
  await t.advance(10 * MIN);
  await t.sleep(3 * 60 * MIN);
  await expectText(t, '#clock', '15:00');
  await expectText(t, '#phase', 'フォーカス');
  await t.advance(15 * MIN);
  await expectText(t, '#phase', '小休憩');
  assert.equal(t.saved().sessions[0].spans.length, 2);
}));

test('終了しても進行中のフォーカスは一時停止として残り、次の起動で続きから', async () => {
  const userData = tempUserData();
  try {
    await run({ userData }, async t => {
      await addTask(t, '続きもの');
      await t.page.click('#toggle');
      await t.advance(7 * MIN);
    });
    assert.equal(JSON.parse(fs.readFileSync(dataFile(userData), 'utf8')).run.open, null);
    await run({ userData }, async t => {
      await expectText(t, '#phase', 'フォーカス・一時停止中');
      await expectText(t, '#subject', '続きもの');
      // 終了から再起動までの実時間ぶんは進んでいない
      assert.equal(await clock(t), '18:00');
      await t.page.click('#toggle');
      await t.advance(18 * MIN);
      assert.equal((await t.data()).sessions[0].completed, true);
    });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('v1 のデータを引き継ぐ(v1 のファイルには触れない)', async () => {
  const iso = (h: number, m: number): string => new Date(2026, 6, 7, h, m).toISOString();
  const v1 = JSON.stringify({
    tasks: [{ id: 'a', title: '旧タスク', completed: false, createdAt: iso(9, 0), completedAt: null }],
    sessions: [{
      id: 's1', mode: 'work', startedAt: iso(9, 0), endedAt: iso(9, 25), durationSec: 1500, completed: true,
      intervals: [{ startedAt: iso(9, 0), endedAt: iso(9, 25) }], taskIds: ['a'], taskTimes: [{ taskId: 'a', durationSec: 1500 }]
    }],
    selectedTaskId: 'a',
    settings: { workMin: 50, shortMin: 10, longMin: 15, longEvery: 4, autoStartBreak: false, autoStartWork: false,
      whiteNoise: { enabled: true, file: 'white-noise.wav', breakFile: 'white-noise.wav', volume: 50 } },
    timer: { mode: 'work', cycle: 1 }
  });
  await run({ legacy: v1 }, async t => {
    await expectText(t, '.toast', /引き継ぎました/);
    await expectText(t, '#subject', '旧タスク');
    assert.equal(await clock(t), '50:00');
    assert.equal((await t.data()).sessions[0].spans[0].taskId, 'a', '記録はタスクに付いたまま引き継ぐ');
    assert.equal(fs.readFileSync(legacyFile(t.userData), 'utf8'), v1);
    assert.equal(t.saved().version, 2);
    // ふりかえりで、その日の記録が見える
    await t.page.click('text=ふりかえり');
    await t.page.click('#range button:text-is("90日")');
    assert.equal(await t.page.locator('#log .log-row').count(), 0);
  });
});

test('壊れた保存ファイルは退避して、空で起動する', () => run({ seed: '{"tasks": [こわれ' }, async t => {
  await expectText(t, '.toast', /壊れていた/);
  assert.equal(await clock(t), '25:00');
  await addTask(t, '新しく始める');
  const files = fs.readdirSync(t.userData);
  const quarantined = files.find(f => f.includes('.corrupt-'));
  assert.ok(quarantined);
  assert.equal(fs.readFileSync(path.join(t.userData, quarantined), 'utf8'), '{"tasks": [こわれ');
  assert.equal(t.saved().tasks[0].title, '新しく始める');
}));

test('ふりかえり: 記録を付け替える・削除して元に戻す・日を移る', () => run({}, async t => {
  const { page } = t;
  await addTask(t, 'A');
  await addTask(t, 'B');
  await page.click('#toggle');
  await t.advance(25 * MIN);
  await page.click('text=ふりかえり');
  await expectText(t, '#daySum', /25分.*1/);
  await page.waitForSelector('#log .log-row[data-kind="focus"]');
  assert.match(await page.innerText('#figures'), /25分[\s\S]*100/);

  const b = (await t.data()).tasks.find(x => x.title === 'B')!.id;
  await page.selectOption('#log .log-row[data-kind="focus"] .log-task', b);
  await page.waitForFunction(id => document.querySelector<HTMLSelectElement>('#log .log-task')?.value === id, b);
  assert.equal((await t.data()).sessions[0].spans[0].taskId, b);

  await page.hover('#log .log-row[data-kind="focus"]');
  await page.click('#log .log-row[data-kind="focus"] .task-delete');
  await expectText(t, '#daySum', 'この日の記録はありません');
  await page.click('.toast-action');
  await expectText(t, '#daySum', /25分/);

  await page.click('#dayPrev');
  await expectText(t, '#daySum', 'この日の記録はありません');
  await page.click('#dayToday');
  await expectText(t, '#daySum', /25分/);
}));

test('設定は変えたそばから効き、範囲に丸められる', () => run({}, async t => {
  const { page } = t;
  await page.click('#openSettings');
  await page.fill('#set-focusMin', '50');
  await page.press('#set-focusMin', 'Tab');
  await expectText(t, '#clock', '50:00');
  await page.fill('#set-focusMin', '9999');
  await page.press('#set-focusMin', 'Tab');
  await expectText(t, '#clock', '180:00');
  assert.equal(await page.inputValue('#set-focusMin'), '180');
  await page.uncheck('#set-autoBreak');
  await page.uncheck('#set-sound-on');
  assert.equal(await page.locator('#set-sound-focus option').count(), 3);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#settings', { state: 'detached' });
  await expectText(t, '#soundToggle', '環境音 オフ');
  await page.click('#toggle');
  assert.equal(await page.getAttribute('html', 'data-ambience'), '');
  await t.advance(180 * MIN);
  await expectText(t, '#phase', '次は小休憩'); // 自動で始まらない
  await expectText(t, '#stop', '休憩を飛ばす');
  await page.click('#stop');
  await expectText(t, '#phase', '次はフォーカス');
  assert.deepEqual([t.saved().settings.focusMin, t.saved().settings.autoBreak], [180, false]);
}));

test('インポート: このアプリのデータだけを通し、置き換える前の控えを残す', async () => {
  const userData = tempUserData();
  const good = path.join(userData, 'import-good.json');
  const bad = path.join(userData, 'import-bad.json');
  fs.writeFileSync(good, JSON.stringify({ version: 2, tasks: [{ id: 'x', title: '持ち込んだタスク', createdAt: 1 }], sessions: [] }));
  fs.writeFileSync(bad, JSON.stringify({ hello: 'world' }));
  const stubDialogs = (t: Launched, file: string): Promise<void> => t.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  }, file);
  try {
    await run({ userData }, async t => {
      await addTask(t, 'もとのタスク');
      await t.page.click('#openSettings');

      await stubDialogs(t, bad);
      await t.page.click('#importJson');
      await expectText(t, '.toast', /このアプリのデータではありません/);
      assert.equal((await t.data()).tasks[0].title, 'もとのタスク');

      await stubDialogs(t, good);
      await t.page.click('#importJson');
      await expectText(t, '.toast:last-child', /読み込みました/);
      await t.page.keyboard.press('Escape');
      await t.page.waitForSelector('.task-title:text-is("持ち込んだタスク")');
      const backup = fs.readdirSync(userData).find(f => f.includes('.before-import-'));
      assert.ok(backup);
      assert.equal(JSON.parse(fs.readFileSync(path.join(userData, backup), 'utf8')).tasks[0].title, 'もとのタスク');

      // 動いている間は読み込ませない
      await t.page.click('#toggle');
      await t.page.click('#openSettings');
      await t.page.click('#importJson');
      await expectText(t, '.toast:last-child', /タイマーを止めてから/);
    });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('ミニタイマーは同じ状態を映し、そこからも操作できる', () => run({}, async t => {
  await addTask(t, 'ミニで見る');
  const opening = t.app.waitForEvent('window');
  await t.page.evaluate(() => window.api.toggleMini());
  const mini = await opening;
  await mini.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  assert.equal(await mini.innerText('#miniClock'), '25:00');
  assert.equal(await mini.innerText('#miniLine'), 'ミニで見る');
  await mini.click('#miniToggle');
  await expectText(t, '#toggle', '一時停止');
  await t.advance(5 * MIN);
  await mini.waitForFunction(() => document.querySelector('#miniClock')?.textContent === '20:00');
}));
