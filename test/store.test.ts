// 保存ファイルの読み書き(Electron を起動しない)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reduce } from '../src/core/engine.ts';
import { emptyData } from '../src/core/model.ts';
import { Host } from '../src/main/host.ts';
import { Store } from '../src/main/store.ts';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-store-'));
  const file = path.join(dir, 'atelier-data.json');
  const legacy = path.join(dir, 'pomodoro-data.json');
  return { dir, file, legacy, store: new Store(file, legacy), ls: () => fs.readdirSync(dir).sort() };
}
const sample = () => reduce(emptyData(), { type: 'task/add', id: 't1', title: '設計' }, 1000).data;

test('保存して読み直すと同じ内容になる。一時ファイルは残らない', () => {
  const t = setup();
  assert.deepEqual(t.store.load(), { data: emptyData(), notices: [] });
  t.store.save(sample());
  assert.deepEqual(t.ls(), ['atelier-data.json']);
  assert.deepEqual(new Store(t.file, t.legacy).load().data, sample());
});

test('壊れたファイルは退避し、前回起動時の内容に戻す', () => {
  const t = setup();
  t.store.save(sample());
  t.store.load(); // ここで .bak が作られる
  fs.writeFileSync(t.file, '{"tasks": [こわれた');
  const loaded = new Store(t.file, t.legacy).load();
  assert.deepEqual(loaded.data, sample());
  assert.equal(loaded.notices.length, 1);
  const quarantined = t.ls().find(f => f.includes('.corrupt-'));
  assert.ok(quarantined);
  assert.equal(fs.readFileSync(path.join(t.dir, quarantined), 'utf8'), '{"tasks": [こわれた');
});

test('控えも無ければ空で起動する(原本は退避してある)', () => {
  const t = setup();
  fs.writeFileSync(t.file, 'not json');
  const loaded = t.store.load();
  assert.deepEqual(loaded.data, emptyData());
  assert.ok(t.ls().some(f => f.includes('.corrupt-')));
});

test('v1 のファイルは読むだけで、書き換えない', () => {
  const t = setup();
  const v1 = JSON.stringify({ tasks: [{ id: 'a', title: '旧タスク', completed: false }], sessions: [], settings: { workMin: 50 } });
  fs.writeFileSync(t.legacy, v1);
  const loaded = t.store.load();
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.data.tasks[0].title, '旧タスク');
  assert.equal(loaded.data.settings.focusMin, 50);
  t.store.save(loaded.data);
  assert.equal(fs.readFileSync(t.legacy, 'utf8'), v1);
  assert.equal(new Store(t.file, t.legacy).load().migrated, undefined, '二度目は v2 を読む');
});

test('読めなかった原本は、退避してからでないと上書きしない', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, () => {
  const t = setup();
  fs.writeFileSync(t.file, JSON.stringify(sample()));
  fs.chmodSync(t.file, 0o000);
  const loaded = t.store.load();
  assert.deepEqual(loaded.data, emptyData());
  assert.equal(loaded.notices.length, 1);
  const preserved = t.store.save(emptyData());
  assert.ok(preserved?.includes('.unreadable-'));
  if (!preserved) return;
  fs.chmodSync(preserved, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(preserved, 'utf8')), sample());
  assert.equal(t.store.save(emptyData()), null, '退避は一度だけ');
});

test('読めなかった原本は、新しい内容を書けなかったら退避せずにその場に残す', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, () => {
  const t = setup();
  fs.writeFileSync(t.file, JSON.stringify(sample()));
  fs.chmodSync(t.file, 0o000);
  t.store.load();
  // 一時ファイルの場所をディレクトリで塞いで、書き込みを失敗させる
  fs.mkdirSync(t.file + '.tmp');
  assert.throws(() => t.store.save(emptyData()));
  assert.ok(fs.existsSync(t.file), '原本は正規の場所に残っている');
  assert.ok(!t.ls().some(f => f.includes('.unreadable-')), 'まだ退避していない');
  // 塞いでいたものが無くなれば、次の保存で退避してから書ける
  fs.rmdirSync(t.file + '.tmp');
  const preserved = t.store.save(emptyData());
  assert.ok(preserved?.includes('.unreadable-'));
  fs.chmodSync(t.file, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(t.file, 'utf8')), emptyData());
});

test('インポートの保存に失敗したら、いまの状態のまま変えない', () => {
  let fail = false;
  const store = {
    load: () => ({ data: sample(), notices: [] }),
    save: () => { if (fail) throw new Error('ディスクがいっぱいです'); return null; }
  } as unknown as Store;
  const host = new Host(store);
  const before = host.snapshot().data;
  let changed = 0;
  host.on('change', () => changed++);
  fail = true;
  assert.throws(() => host.replace(emptyData()), /ディスクがいっぱい/);
  assert.equal(host.snapshot().data, before);
  assert.equal(changed, 0);
  fail = false;
  host.replace(emptyData());
  assert.deepEqual(host.snapshot().data, emptyData());
  assert.equal(changed, 1);
});

test('インポート前の控え', () => {
  const t = setup();
  assert.equal(t.store.backup('before-import'), null);
  t.store.save(sample());
  const backup = t.store.backup('before-import');
  assert.deepEqual(JSON.parse(fs.readFileSync(backup!, 'utf8')), sample());
});
