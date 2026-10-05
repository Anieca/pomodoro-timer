import { launchApp, assert } from './test-env.mjs';

// タスク操作の基本の流れ:
//  クイック追加でセット → 実行中にタスクを切り替える(紐付くのは1つだけ)→ 実行中に完了 → 保存
const { page, errors, close } = await launchApp();

// サークル下のクイック追加でタスクを作成してセット
await page.fill('.focus-quick-add input', 'クイック追加タスク');
await page.press('.focus-quick-add input', 'Enter');
await page.waitForTimeout(300);
const quickAdded = await page.evaluate(() => ({
  focusTitle: document.querySelector('.focus-title')?.textContent,
  inList: [...document.querySelectorAll('#taskList .task-title')].map(e => e.textContent)
}));
// セット解除
await page.evaluate(() => document.querySelector('.focus-clear-btn').click());
await page.waitForTimeout(200);

// タスク追加 x2
for (const t of ['設計レビュー', 'レポート作成']) {
  await page.fill('#taskInput', t);
  await page.evaluate(() => document.querySelector('#taskForm button').click());
}
await page.waitForTimeout(300);

// ポモドーロ開始(タスクなし)
await page.evaluate(() => document.querySelector('#startBtn').click());
await page.waitForTimeout(500);

// 実行中にタスク行クリックで紐付け → 別タスクに切り替え(1タスクのみ紐付く)
await page.evaluate(() => document.querySelectorAll('#taskList .task-item')[0].click());
await page.evaluate(() => document.querySelectorAll('#taskList .task-item')[1].click());
await page.waitForTimeout(300);
const focusTitle = await page.evaluate(() => document.querySelector('.focus-title')?.textContent);
const selectedRows = await page.evaluate(() => document.querySelectorAll('#taskList .task-item.selected').length);

// 実行中にタスク完了(チェック)→ 中止
await page.evaluate(() => document.querySelector('#taskList .task-check').click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#stopBtn').click());
await page.waitForTimeout(300);

const saved = await page.evaluate(async () => await window.api.loadData());

console.log('--- RESULT ---');
console.log('quick add:', JSON.stringify(quickAdded));
console.log('focus task (switched):', JSON.stringify(focusTitle), '/ selected rows:', selectedRows);
console.log('saved tasks:', saved ? saved.tasks.map(t => `${t.title}(${t.completed ? '完' : '未'})`).join(', ') : 'none');
console.log('console errors:', errors.length ? errors : 'none');

assert(quickAdded.focusTitle === 'クイック追加タスク', 'quick-add sets the focus task');
assert(quickAdded.inList.includes('クイック追加タスク'), 'quick-added task appears in the list');
assert(selectedRows === 1, 'switching between tasks keeps exactly one selected');
assert(focusTitle === '設計レビュー' || focusTitle === 'レポート作成', 'focus task is one of the linked tasks');
assert(!!saved && Array.isArray(saved.sessions), 'data persisted with a sessions array');
assert(!!saved && saved.tasks.length >= 2, 'added tasks were persisted');
assert(!!saved && saved.tasks.some(t => t.completed), 'task completed while running was persisted');
assert(errors.length === 0, 'no console errors');

await close();
console.log(process.exitCode ? 'DONE (with failures)' : 'OK');
