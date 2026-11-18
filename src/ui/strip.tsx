// 一日の物差し。縦が時刻で、実働の区間を帯として置く。「いま」と「ふりかえり」で同じものを使う。
import { useEffect, useRef } from 'preact/hooks';
import { fmtDur, fmtTime, taskTitle, wallHours, type Block } from '../core/derive.ts';
import { KIND_LABEL, type Task } from '../core/model.ts';

interface Props {
  blocks: Block[];
  dayStart: number;
  tasks: readonly Task[];
  /** 表示する時台の範囲 [from, to) */
  hours: [number, number];
  /** 今日なら「いま」の線を引く */
  now?: number;
  hourPx?: number;
  selectedId?: string | null;
  onPick?(sessionId: string): void;
}

/** 記録と「いま」が収まる時台の範囲。何も無ければ日中を見せる。 */
export function hourRange(blocks: Block[], dayStart: number, now?: number): [number, number] {
  const points = blocks.flatMap(b => [b.start, b.end]);
  if (now !== undefined) points.push(now);
  if (points.length === 0) return [8, 19];
  const first = Math.floor(wallHours(Math.min(...points), dayStart));
  const last = Math.ceil(wallHours(Math.max(...points), dayStart));
  const from = Math.max(0, first - (now !== undefined ? 1 : 0));
  return [from, Math.min(24, Math.max(last + 1, from + 6))];
}

export function DayStrip({ blocks, dayStart, tasks, hours, now, hourPx = 60, selectedId, onPick }: Props) {
  const [from, to] = hours;
  // 位置は時計の表示から求める(夏時間の切り替え日でも、時台の目盛りと揃う)
  const y = (t: number): number => (wallHours(t, dayStart) - from) * hourPx;
  const nowRef = useRef<HTMLDivElement>(null);
  const nowAt = now === undefined ? null : wallHours(now, dayStart);
  const showNow = nowAt !== null && nowAt >= from && nowAt <= to;

  // 開いたとき、「いま」が見える位置へ寄せる
  useEffect(() => { nowRef.current?.scrollIntoView({ block: 'center' }); }, [dayStart, showNow]);

  return (
    <div class="strip" style={{ height: `${(to - from) * hourPx}px` }}>
      {Array.from({ length: to - from + 1 }, (_, i) => (
        <div class="strip-hour" key={i} style={{ top: `${i * hourPx}px` }}>
          <span class="num">{from + i}</span>
        </div>
      ))}
      {blocks.map((b, i) => {
        const height = Math.max(2, y(b.end) - y(b.start));
        const label = b.kind === 'focus' ? taskTitle(tasks, b.taskId) : KIND_LABEL[b.kind];
        const Tag = onPick ? 'button' : 'div';
        return (
          <Tag
            key={`${b.sessionId}-${i}`}
            class="block"
            data-kind={b.kind}
            data-live={b.live || undefined}
            data-untasked={b.kind === 'focus' && b.taskId === null || undefined}
            aria-pressed={onPick ? b.sessionId === selectedId : undefined}
            style={{ top: `${y(b.start)}px`, height: `${height}px` }}
            title={`${fmtTime(b.start)}〜${fmtTime(b.end)}  ${label}(${fmtDur(b.end - b.start)})`}
            onClick={onPick ? () => onPick(b.sessionId) : undefined}
          >
            {height >= 17 && <span class="block-label">{label}</span>}
          </Tag>
        );
      })}
      {showNow && (
        <div class="strip-now" ref={nowRef} style={{ top: `${y(now!)}px` }}>
          <span class="num">{fmtTime(now!)}</span>
        </div>
      )}
    </div>
  );
}
