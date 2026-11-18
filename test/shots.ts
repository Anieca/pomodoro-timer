// 主な画面のスクリーンショットを撮る(テストではない)。node test/shots.ts [出力先]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchApp, MIN } from './env.ts';

const out = path.resolve(process.argv[2] ?? 'shots');
fs.mkdirSync(out, { recursive: true });
const scheme = (process.argv[3] ?? 'light') as 'light' | 'dark';

const t = await launchApp();
const { page } = t;
await page.emulateMedia({ colorScheme: scheme });
const add = async (title: string): Promise<void> => { await page.fill('#newTask', title); await page.press('#newTask', 'Enter'); };
await page.screenshot({ path: path.join(out, `0-empty-${scheme}.png`) });
for (const title of ['設計書の骨子を書く', 'レビュー指摘に返信する', '移行スクリプトの検証', '週報をまとめる']) await add(title);

// 午前中に何本か済ませた体にする
for (let i = 0; i < 3; i++) {
  await page.click('#toggle');
  await t.advance(25 * MIN);
  await t.advance(5 * MIN);
  if (i === 0) await page.click('.task[data-id] .check');
}
await page.click('#toggle');
await t.advance(11 * MIN);
await page.mouse.move(700, 300);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, `1-now-${scheme}.png`) });
await page.waitForTimeout(3200);
await page.screenshot({ path: path.join(out, `1a-still-${scheme}.png`) });
// 端に手を伸ばすと、退いていたタスクが戻る
await page.mouse.move(120, 300);
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, `1b-reach-${scheme}.png`) });
await page.mouse.move(700, 300);
await page.click('#toggle');
await page.mouse.move(700, 120);
await page.waitForTimeout(2200);
await page.screenshot({ path: path.join(out, `2-paused-${scheme}.png`) });
await page.click('text=ふりかえり');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, `3-review-${scheme}.png`) });
await page.click('text=いま');
await page.click('#openSettings');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, `4-settings-${scheme}.png`) });
await page.keyboard.press('Escape');
const opening = t.app.waitForEvent('window');
await page.evaluate(() => window.api.toggleMini());
const mini = await opening;
await mini.waitForSelector('html[data-ready="true"]', { state: 'attached' });
await mini.emulateMedia({ colorScheme: scheme });
await mini.screenshot({ path: path.join(out, `5-mini-${scheme}.png`) });
console.log('errors:', t.errors);
await t.close();
console.log('saved to', out);
