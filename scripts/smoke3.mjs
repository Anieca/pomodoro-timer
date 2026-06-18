import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-test-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pomo-export-'));

// 既存データを仕込む
fs.writeFileSync(path.join(userData, 'pomodoro-data.json'), JSON.stringify({
  tasks: [
    { id: 't1', title: '設計, "レビュー"', completed: true, createdAt: '2026-06-09T01:00:00Z', completedAt: '2026-06-09T03:00:00Z' },
    { id: 't2', title: 'レポート作成', completed: false, createdAt: '2026-06-09T02:00:00Z', completedAt: null }
  ],
  sessions: [
    { id: 'p1', mode: 'work', startedAt: '2026-06-09T01:00:00Z', endedAt: '2026-06-09T01:30:00Z', durationSec: 1500, completed: true, taskIds: ['t1', 't2'],
      intervals: [
        { startedAt: '2026-06-09T01:00:00Z', endedAt: '2026-06-09T01:20:00Z' },
        { startedAt: '2026-06-09T01:25:00Z', endedAt: '2026-06-09T01:30:00Z' }
      ],
      taskTimes: [{ taskId: 't1', durationSec: 1200 }, { taskId: 't2', durationSec: 300 }] },
    { id: 'b1', mode: 'short', startedAt: '2026-06-09T01:30:00Z', endedAt: '2026-06-09T01:35:00Z', durationSec: 300, completed: true, taskIds: [],
      intervals: [{ startedAt: '2026-06-09T01:30:00Z', endedAt: '2026-06-09T01:35:00Z' }], taskTimes: [] },
    { id: 'p2', mode: 'work', startedAt: '2026-06-09T02:00:00Z', endedAt: '2026-06-09T02:10:00Z', durationSec: 600, completed: false, taskIds: [],
      intervals: [{ startedAt: '2026-06-09T02:00:00Z', endedAt: '2026-06-09T02:10:00Z' }],
      taskTimes: [{ taskId: null, durationSec: 600 }] }
  ],
  settings: { workMin: 25, shortMin: 5, longMin: 15, longEvery: 4, whiteNoise: { enabled: false, file: '', volume: 50 } }
}));

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: ['--no-sandbox', APP_DIR],
  env: { ...process.env, POMODORO_USER_DATA: userData },
  timeout: 30000
});

// 保存ダイアログをスタブ
await app.evaluate(({ dialog }, outDir) => {
  let n = 0;
  dialog.showSaveDialog = async (_win, opts) => ({
    canceled: false,
    filePath: `${outDir}/${++n}-${opts.defaultPath}`
  });
}, outDir);

const page = await app.firstWindow();
await page.waitForSelector('#startBtn', { timeout: 15000 });
await page.waitForTimeout(800);

for (const f of ['json', 'csv-sessions', 'csv-tasks']) {
  await page.evaluate(async fmt => await window.api.exportData(fmt, await window.api.loadData()), f);
}

console.log('--- EXPORTED FILES ---');
for (const f of fs.readdirSync(outDir).sort()) {
  console.log(`\n===== ${f} =====`);
  const c = fs.readFileSync(path.join(outDir, f), 'utf8');
  console.log(f.endsWith('.json') ? c.slice(0, 300) + '…' : c);
}
await app.close();
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(outDir, { recursive: true, force: true });
console.log('OK');
