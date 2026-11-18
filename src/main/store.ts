// 保存ファイルの読み書き。守る決まりは二つ:
//   1. 読めなかった・壊れていたバイト列は、退避するまで上書きしない
//   2. 書き込みは一時ファイル → rename で、途中で落ちても半端なファイルを残さない
// electron に依存しない(パスは呼び出し側が渡す)ので、そのまま単体テストできる。
import * as fs from 'node:fs';
import { decode } from '../core/codec.ts';
import { emptyData, type Data } from '../core/model.ts';

export const errorMessage = (err: unknown): string => String((err as Error)?.message ?? err);
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');
const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code;

export interface Loaded {
  data: Data;
  /** 起動時に利用者へ伝えること(復元した・退避した・読めなかった) */
  notices: string[];
  /** v1 から引き継いだ(まだ v2 のファイルは無い) */
  migrated?: boolean;
}

export class Store {
  /** 原本を読めないまま起動した理由。null なら普通に保存してよい。 */
  private unreadable: string | null = null;
  private readonly file: string;
  private readonly legacyFile: string;

  constructor(file: string, legacyFile: string) {
    this.file = file;
    this.legacyFile = legacyFile;
  }

  load(): Loaded {
    this.unreadable = null;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (errCode(err) === 'ENOENT') return this.loadLegacy();
      // 権限などで読めない。空で起動して上書きすると原本が失われるので、保存の前に退避する。
      this.unreadable = errorMessage(err);
      return { data: emptyData(), notices: ['保存ファイルを読み込めませんでした。次に保存するとき、元のファイルは退避します: ' + this.unreadable] };
    }
    try {
      const data = decode(JSON.parse(raw));
      // 読めた内容を、前回までの無事な一世代として控える
      try { fs.writeFileSync(this.file + '.bak', raw, 'utf8'); } catch {}
      return { data, notices: [] };
    } catch {}
    // 壊れている。原本を退避してから、控えの一世代に戻れるか試す。
    const quarantine = `${this.file}.corrupt-${stamp()}`;
    try {
      fs.writeFileSync(quarantine, raw, 'utf8');
    } catch (err) {
      this.unreadable = '壊れたファイルを退避できませんでした: ' + errorMessage(err);
    }
    try {
      const data = decode(JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8')));
      return { data, notices: ['保存ファイルが壊れていたため、前回起動時の内容に戻しました(壊れたファイルは .corrupt- として残しています)。'] };
    } catch {}
    return { data: emptyData(), notices: ['保存ファイルが壊れていたため、空の状態で起動しました(元のファイルは .corrupt- として残しています)。'] };
  }

  /** v2 のファイルがまだ無いとき。v1 のファイルがあれば引き継ぐ(v1 には書き込まない)。 */
  private loadLegacy(): Loaded {
    let raw: string;
    try {
      raw = fs.readFileSync(this.legacyFile, 'utf8');
    } catch (err) {
      if (errCode(err) === 'ENOENT') return { data: emptyData(), notices: [] };
      return { data: emptyData(), notices: ['以前のバージョンのデータを読み込めませんでした(ファイルはそのまま残しています): ' + errorMessage(err)] };
    }
    try {
      const data = decode(JSON.parse(raw));
      return { data, migrated: true, notices: data.tasks.length || data.sessions.length ? ['以前のバージョンのデータを引き継ぎました。'] : [] };
    } catch {
      return { data: emptyData(), notices: ['以前のバージョンのデータが壊れていて引き継げませんでした(ファイルはそのまま残しています)。'] };
    }
  }

  /** 保存する。読めなかった原本を退避した場合はその先を返す。失敗は投げる。 */
  save(data: Data): string | null {
    // 新しい内容を書き終えてから、読めなかった原本を退避する。先に退避すると、
    // 書き込みが失敗したとき正規の場所にファイルが無くなり、次の起動が初回起動と
    // 誤解して空のデータで始まってしまう。
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    let preserved: string | null;
    try {
      preserved = this.preserveUnreadable();
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
    fs.renameSync(tmp, this.file);
    return preserved;
  }

  // rename は中身を読めなくても(ディレクトリに書ければ)原本を確実に残せる。
  private preserveUnreadable(): string | null {
    if (this.unreadable === null) return null;
    const backup = `${this.file}.unreadable-${stamp()}`;
    try {
      fs.renameSync(this.file, backup);
    } catch (err) {
      if (errCode(err) !== 'ENOENT') {
        throw new Error('読み込めなかった元のデータを退避できないため、保存を中止しました: ' + errorMessage(err));
      }
      this.unreadable = null;
      return null;
    }
    this.unreadable = null;
    return backup;
  }

  /** いまディスクにある内容の控えを取る(インポートで置き換える前)。無ければ null。 */
  backup(kind: string): string | null {
    const dest = `${this.file}.${kind}-${stamp()}`;
    try {
      fs.copyFileSync(this.file, dest);
      return dest;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      throw err;
    }
  }
}
