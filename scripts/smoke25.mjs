import { _electron as electron } from 'playwright-core';
import { ELECTRON, isAppError, waitForApp } from './test-env.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 統計ビューの配線の検証(集計の決まりそのものは stats-test.mjs で見る)。
//  A) 記録を入れて開くと、期間の集計が KPI・日別・時間帯・タスク別に出る
//  B) 期間を切り替えると日数と集計が変わる
//  C) 開いている間に正本が変わると描き直す(削除したタスクは「(削除済み)」ではなく
//     main の匿名化に従い「タスクなし」へ寄る)
//  D) 記録が無ければ空の案内を出し、例外を出さない
//  E) 内訳を持たない旧データの時間がサイドバーのタスクごとの集計にも出る
const APP_DIR = path.resolve(import.meta.dirname, '..');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

const now = new Date();
const at = (dd, h, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dd, h, m).toISOString();
const work = (id, dd, h, taskId, completed = true) => ({
  id, mode: 'work', completed,
  startedAt: at(dd, h), endedAt: at(dd, h, 25), durationSec: 25 * 60,
  taskIds: completed ? [taskId] : [], taskTimes: [{ taskId, durationSec: 25 * 60 }],
  intervals: [{ startedAt: at(dd, h), endedAt: at(dd, h, 25) }]
});

async function launch(seed) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
  if (seed) fs.writeFileSync(path.join(ud, 'pomodoro-data.json'), JSON.stringify(seed));
  const app = await electron.launch({
    executablePath: ELECTRON, args: ['--no-sandbox', APP_DIR],
    env: { ...process.env, POMODORO_USER_DATA: ud }, timeout: 30000
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', m => { if (isAppError(m)) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.waitForSelector('#startBtn', { timeout: 15000 });
  await waitForApp(page);
  return { app, page, errors };
}

const read = page => page.evaluate(() => ({
  period: document.querySelector('#statsPeriod').textContent,
  kpis: [...document.querySelectorAll('.stats-kpi-value')].map(e => e.textContent),
  bars: document.querySelectorAll('.stats-bar-col').length,
  barTitles: [...document.querySelectorAll('.stats-bar-col')].map(e => e.title),
  hours: document.querySelectorAll('.stats-hour').length,
  tasks: [...document.querySelectorAll('.stats-task-name')].map(e => e.textContent),
  active: document.querySelector('#statsRange .active')?.dataset.days,
  empty: [...document.querySelectorAll('#statsModal .empty-note')].map(e => e.textContent)
}));

/* ===== A〜C ===== */
{
  const { app, page, errors } = await launch({
    tasks: [
      { id: 't1', title: '資料づくり', completed: false, createdAt: at(-20, 9) },
      { id: 't2', title: 'レビュー', completed: false, createdAt: at(-20, 9) }
    ],
    sessions: [
      work('a', 0, 9, 't1'),
      work('b', 0, 10, 't1', false),
      work('c', -1, 14, 't2'),
      work('d', -20, 14, 't2')            // 7日には入らず 30日には入る
    ]
  });

  await page.click('#statsBtn');
  await page.waitForSelector('#statsModal:not([hidden])');
  const a = await read(page);
  console.log('A:', JSON.stringify(a));
  assert(a.active === '7' && a.bars === 7, 'A: 既定は 7日');
  assert(a.kpis[0] === '1時間15分', 'A: 集中時間は期間内のフォーカスの合計');
  assert(a.kpis[1] === '2🍅', 'A: 完了ポモドーロ');
  assert(a.kpis[2] === '67%', 'A: 完走率');
  assert(a.kpis[3] === '2日', 'A: 連続日数');
  assert(a.barTitles[6].includes('50分') && a.barTitles[6].includes('1🍅'), 'A: 今日の棒に集中時間と完了数');
  assert(a.hours === 24, 'A: 時間帯は 24 マス');
  assert(a.tasks[0] === '資料づくり' && a.tasks[1] === 'レビュー', 'A: タスク別は多い順');

  await page.click('#statsRange button[data-days="30"]');
  const b = await read(page);
  assert(b.active === '30' && b.bars === 30, 'B: 30日に切り替わる');
  assert(b.kpis[0] === '1時間40分', 'B: 30日では 20日前の記録も入る');
  assert(b.tasks[0] === '資料づくり' && b.tasks[1] === 'レビュー', 'B: 同時間なら先に積んだ順');

  // C: 開いたままタスクを削除する(取り消しのトーストは出るが待たない)
  await page.evaluate(() => deleteTask('t2'));
  await page.waitForFunction(() => [...document.querySelectorAll('.stats-task-name')].some(e => e.textContent === 'タスクなし'));
  const c = await read(page);
  assert(!c.tasks.includes('レビュー') && c.tasks.includes('タスクなし'), 'C: 開いたままでも正本の変化を描き直す');

  await page.keyboard.press('Escape');
  assert(await page.isHidden('#statsModal'), 'Esc で閉じる');
  assert(errors.length === 0, `コンソールエラーなし ${JSON.stringify(errors)}`);
  await app.close();
}

/* ===== E: 内訳を持たない旧データもサイドバーのタスクごとの集計に出る ===== */
{
  const { app, page, errors } = await launch({
    tasks: [
      { id: 't1', title: '資料づくり', completed: false, createdAt: at(-20, 9) },
      { id: 't2', title: 'レビュー', completed: false, createdAt: at(-20, 9) }
    ],
    // 旧 pomodoros 形式(taskTimes・区間を持たない)
    pomodoros: [
      { id: 'l1', mode: 'work', completed: true, taskIds: ['t1'], durationSec: 25 * 60, startedAt: at(-1, 9), endedAt: at(-1, 9, 25) },
      { id: 'l2', mode: 'work', completed: true, taskIds: ['t1'], durationSec: 25 * 60, startedAt: at(-1, 10), endedAt: at(-1, 10, 25) },
      { id: 'l3', mode: 'work', completed: true, taskIds: ['t1', 't2'], durationSec: 25 * 60, startedAt: at(-1, 11), endedAt: at(-1, 11, 25) }
    ]
  });
  const meta = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.task-item')]
    .map(li => [li.querySelector('.task-title').textContent, li.querySelector('.task-meta').textContent])));
  console.log('E:', JSON.stringify(meta));
  assert(meta['資料づくり'] === '🍅3 · 50分', 'E: 旧データの時間もタスクに積む(完了数は従来どおり taskIds で数える)');
  assert(meta['レビュー'] === '🍅1 · 0分', 'E: タスクが決まらない旧データの時間はどのタスクにも積まない(統計と揃える)');
  assert(errors.length === 0, `E: コンソールエラーなし ${JSON.stringify(errors)}`);
  await app.close();
}

/* ===== D: 記録なし ===== */
{
  const { app, page, errors } = await launch(null);
  await page.click('#statsBtn');
  await page.waitForSelector('#statsModal:not([hidden])');
  const d = await read(page);
  console.log('D:', JSON.stringify(d));
  assert(d.kpis[0] === '0分' && d.kpis[2] === '—', 'D: 0 と「出せない」を区別して表示');
  assert(d.empty.length === 2, 'D: 日別とタスク別に空の案内');
  await page.click('#statsClose');
  assert(await page.isHidden('#statsModal'), 'D: 閉じるボタンで閉じる');
  assert(errors.length === 0, `D: コンソールエラーなし ${JSON.stringify(errors)}`);
  await app.close();
}
