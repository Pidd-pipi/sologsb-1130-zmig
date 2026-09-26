/**
 * 帧序编排撤销 / 重做：每个镜头各自保留最近 20 步编排记录。
 * 插入、移除、换序、单帧参数修改与批量曝光都通过 run() 包裹，
 * 动作前的整条帧序（含镜头时长 / 帧区间）压入快照栈；
 * 撤销 / 重做时整体回写，帧号、条数、时长与明细一起回退。
 *
 * 历史按镜头 id 隔离并持久化到 localStorage：
 * 切换镜头、关掉页面再回来，撤销重做都只作用于当前镜头，不会串镜。
 * 新的编排动作一旦发生，该镜头原有的重做链立即作废。
 */
import { computed, ref, reactive } from 'vue';
import { useFrameStore } from '../stores/frameStore';
import { useShotStore } from '../stores/shotStore';
import { toPlain } from '../db';
import type { FrameEntry } from '../types/frame';

const STORAGE_KEY = 'gbstopmotion:frame-history:v1';
/** 最多保留的编排步数（步数 = 快照数 - 1） */
export const FRAME_HISTORY_LIMIT = 20;
const MAX_SNAPSHOTS = FRAME_HISTORY_LIMIT + 1;

interface ShotRangeSnapshot {
  durationSec: number;
  startFrame: number;
  endFrame: number;
}

interface ShotSnapshot extends ShotRangeSnapshot {
  frames: FrameEntry[];
}

interface ShotHistory {
  /** 已发生的状态链，past[last] 即当前状态，首个元素是基线，永不出栈 */
  past: ShotSnapshot[];
  /** 已撤销、可重做的状态，栈顶是最近一次撤销 */
  future: ShotSnapshot[];
}

type HistoryMap = Record<string, ShotHistory>;

function loadHistories(): HistoryMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HistoryMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 模块级单例：同页面内所有 hook 调用共享一份按镜头隔离的历史 */
const histories = reactive<HistoryMap>(loadHistories());

function persistHistories(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(histories));
  } catch {
    /* 存储不可用时只保留内存栈，不阻塞编排 */
  }
}

/**
 * 快照的规范形式：只比较帧内容与镜头帧区间，忽略 id / updatedAt
 * （落库会重新分配自增 id、批量套用会刷新 updatedAt，这些不构成内容变化），
 * 帧号按排序后的位次归一，避免起止帧号偏移导致的误判。
 */
function canonical(snap: ShotSnapshot): string {
  const frames = snap.frames
    .slice()
    .sort((a, b) => a.frameNo - b.frameNo)
    .map((f, i) => ({
      i,
      shotCount: f.shotCount,
      exposureSec: f.exposureSec,
      aperture: f.aperture,
      iso: f.iso,
      shutterAngle: f.shutterAngle,
      lighting: f.lighting,
      propOffsetMm: f.propOffsetMm,
      note: f.note,
    }));
  return JSON.stringify({
    frames,
    durationSec: snap.durationSec,
    startFrame: snap.startFrame,
    endFrame: snap.endFrame,
  });
}

export function useFrameHistory() {
  const frameStore = useFrameStore();
  const shotStore = useShotStore();

  /** 当前历史作用的镜头；null 时撤销 / 重做均不可用。
   *  用 ref 持有：切换镜头时即使新镜头历史内容未变，canUndo/canRedo 也要重算。 */
  const activeShotId = ref<number | null>(null);

  function capture(shotId: number): ShotSnapshot {
    const shot = shotStore.byId(shotId);
    return {
      frames: frameStore.frames.map((f) => toPlain(f)),
      durationSec: shot?.durationSec ?? 0,
      startFrame: shot?.startFrame ?? 1,
      endFrame: shot?.endFrame ?? 1,
    };
  }

  async function applySnapshot(shotId: number, snap: ShotSnapshot): Promise<void> {
    await frameStore.restoreSnapshot(shotId, snap.frames);
    await shotStore.restoreRange(shotId, {
      durationSec: snap.durationSec,
      startFrame: snap.startFrame,
      endFrame: snap.endFrame,
    });
  }

  /**
   * 切换 / 打开镜头时调用：载入该镜头帧序后接管历史。
   * 若本地没有该镜头的历史，或历史栈顶与当前数据对不上
   * （例如在镜头详情页改过、或数据被外部清掉），以当前状态为基线重新起栈。
   */
  async function init(shotId: number): Promise<void> {
    activeShotId.value = shotId;
    await frameStore.loadForShot(shotId);
    const key = String(shotId);
    const history = histories[key];
    const current = capture(shotId);
    const pointer = history?.past[history.past.length - 1];
    if (!history || !pointer || canonical(pointer) !== canonical(current)) {
      histories[key] = { past: [current], future: [] };
      persistHistories();
    }
  }

  /**
   * 包裹一次编排动作：动作前抓取快照，动作后若内容确有变化则入栈。
   * 入栈同时清空重做链；返回该动作是否产生了实际变化。
   */
  async function run(action: () => Promise<void> | void): Promise<boolean> {
    const shotId = activeShotId.value;
    if (shotId === null) {
      await action();
      return false;
    }
    const key = String(shotId);
    let history = histories[key];
    if (!history) {
      history = { past: [capture(shotId)], future: [] };
      histories[key] = history;
    }
    const pointer = history.past[history.past.length - 1];
    const before = capture(shotId);
    await action();
    const after = capture(shotId);
    if (canonical(before) === canonical(after)) return false;
    // 动作前状态与栈顶不一致（数据被其他页面改过）时，丢弃接不上的旧链
    if (canonical(pointer) !== canonical(before)) {
      history.past = [before];
    }
    history.past.push(after);
    history.future = [];
    if (history.past.length > MAX_SNAPSHOTS) {
      history.past = history.past.slice(history.past.length - MAX_SNAPSHOTS);
    }
    persistHistories();
    return true;
  }

  async function undo(): Promise<boolean> {
    const shotId = activeShotId.value;
    if (shotId === null) return false;
    const history = histories[String(shotId)];
    if (!history || history.past.length <= 1) return false;
    const current = history.past.pop();
    if (!current) return false;
    history.future.push(current);
    persistHistories();
    await applySnapshot(shotId, history.past[history.past.length - 1]);
    return true;
  }

  async function redo(): Promise<boolean> {
    const shotId = activeShotId.value;
    if (shotId === null) return false;
    const history = histories[String(shotId)];
    const next = history?.future.pop();
    if (!history || !next) return false;
    history.past.push(next);
    persistHistories();
    await applySnapshot(shotId, next);
    return true;
  }

  const canUndo = computed(() => {
    if (activeShotId.value === null) return false;
    return (histories[String(activeShotId.value)]?.past.length ?? 0) > 1;
  });
  const canRedo = computed(() =>
    activeShotId.value === null ? false : (histories[String(activeShotId.value)]?.future.length ?? 0) > 0,
  );

  return { init, run, undo, redo, canUndo, canRedo };
}
