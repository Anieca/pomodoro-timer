// スモークテスト一括ランナー。現行UI・sessionsスキーマに追従した一連のテストを
// 順に実行し、いずれか失敗すれば非ゼロ終了する(CI / npm test 用)。
import { spawn } from 'node:child_process';
import * as path from 'node:path';

const DIR = import.meta.dirname;
const TESTS = [
  'smoke.mjs',
  'smoke11.mjs',
  'smoke12.mjs',
  'smoke13.mjs',
  'smoke14.mjs',
  'smoke16.mjs',
  'smoke17.mjs',
  'smoke18.mjs',
  'smoke19.mjs',
  'smoke20.mjs',
  'smoke21.mjs'
];

const run = file => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(DIR, file)], { stdio: 'inherit' });
  child.on('exit', code => resolve(code ?? 1));
});

const results = [];
for (const file of TESTS) {
  console.log(`\n===== ${file} =====`);
  const code = await run(file);
  results.push({ file, code });
}

console.log('\n===== SUMMARY =====');
for (const r of results) console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.file}`);
const failed = results.filter(r => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
