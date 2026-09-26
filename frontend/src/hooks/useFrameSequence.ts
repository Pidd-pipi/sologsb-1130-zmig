/**
 * 帧序编排：插入 / 删除 / 移动帧并重排帧序号，联动镜头帧区间。
 * 撤销 / 重做按镜头隔离：恢复快照后帧号、张数、时长与明细一并回退。
 * 被 /frames 与 /shots/:id 消费。
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useFrameStore } from '../stores/frameStore';
import { useShotStore } from '../stores/shotStore';
import { useHistoryStore } from '../stores/historyStore';
import { durationToFrames, framesToDuration } from '../utils/frameMath';
import type { BatchExposure, FrameEntry } from '../types/frame';

export function useFrameSequence() {
  const frameStore = useFrameStore();
  const shotStore = useShotStore();
  const historyStore = useHistoryStore();
  const { frames, selectedFrameNo } = storeToRefs(frameStore);

  const shotId = computed(() => frameStore.shotId);
  const shot = computed(() => (shotId.value === null ? undefined : shotStore.byId(shotId.value)));
  const fps = computed(() => shot.value?.fps ?? 24);
  const frameCount = computed(() => frames.value.length);
  const totalDuration = computed(() => framesToDuration(frameCount.value, fps.value));
  const plannedFrames = computed(() => durationToFrames(shot.value?.durationSec ?? 0, fps.value));

  const canUndo = computed(() => historyStore.canUndo(shotId.value));
  const canRedo = computed(() => historyStore.canRedo(shotId.value));
  const undoLabel = computed(() => historyStore.undoLabel(shotId.value));
  const redoLabel = computed(() => historyStore.redoLabel(shotId.value));

  /** 切换镜头或重进页面后，读回该镜头持久化的撤销 / 重做双栈 */
  async function ensureHistory() {
    if (shotId.value !== null) await historyStore.ensureLoaded(shotId.value);
  }

  /** 插入一帧；seed 为写入新帧的曝光参数，与插入合并为同一步历史 */
  async function insertAfter(frameNo: number | null, seed?: Partial<FrameEntry>) {
    const index = frameNo === null ? frames.value.length : frames.value.findIndex((f) => f.frameNo === frameNo) + 1;
    await frameStore.insertAt(Math.max(0, index), seed);
    await syncShotRange();
  }

  async function removeAt(frameNo: number) {
    const index = frames.value.findIndex((f) => f.frameNo === frameNo);
    if (index < 0) return;
    await frameStore.removeAt(index);
    await syncShotRange();
  }

  async function move(fromIndex: number, toIndex: number) {
    await frameStore.move(fromIndex, toIndex);
    await syncShotRange();
  }

  /** 批量套用曝光参数（全部帧或指定下标），与单帧修改一样可撤销 */
  async function applyBatchExposure(batch: BatchExposure, indexes?: number[]) {
    await frameStore.applyBatch(batch, indexes);
  }

  /**
   * 帧序变化后重算镜头的帧区间与时长。
   * 帧区间与条带上的帧条目一一对应（结束帧号 = 起始帧号 + 帧条目数 - 1），
   * 时长 = 帧条目数 ÷ 帧率；新增帧即延长本段，删除帧即缩短本段。
   */
  async function syncShotRange() {
    if (shotId.value === null) return;
    const current = shotStore.byId(shotId.value);
    if (!current) return;
    const fps = current.fps || 24;
    const count = Math.max(1, frames.value.length);
    const seconds = Math.round((count / fps) * 1000) / 1000;
    await shotStore.update(shotId.value, {
      durationSec: seconds,
      startFrame: current.startFrame,
      endFrame: current.startFrame + count - 1,
    });
  }

  /** 条带上的单帧曝光/位移改动 */
  async function patch(frameNo: number, patchValue: Partial<FrameEntry>) {
    await frameStore.patchFrame(frameNo, patchValue);
  }

  function select(frameNo: number | null) {
    frameStore.select(frameNo);
  }

  /** 撤销上一步编排：恢复操作前快照并重算镜头时长，返回被撤销的操作描述 */
  async function undo(): Promise<string | null> {
    const id = shotId.value;
    if (id === null) return null;
    const entry = await historyStore.undo(id, frames.value, selectedFrameNo.value);
    if (!entry) return null;
    await frameStore.restoreFrames(entry.frames, entry.selectedFrameNo);
    await syncShotRange();
    return entry.label;
  }

  /** 重做被撤销的编排：恢复重做栈顶快照并重算镜头时长，返回被重做的操作描述 */
  async function redo(): Promise<string | null> {
    const id = shotId.value;
    if (id === null) return null;
    const entry = await historyStore.redo(id, frames.value, selectedFrameNo.value);
    if (!entry) return null;
    await frameStore.restoreFrames(entry.frames, entry.selectedFrameNo);
    await syncShotRange();
    return entry.label;
  }

  return {
    frames,
    selectedFrameNo,
    shot,
    fps,
    frameCount,
    totalDuration,
    plannedFrames,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    ensureHistory,
    insertAfter,
    removeAt,
    move,
    applyBatchExposure,
    patch,
    select,
    syncShotRange,
    undo,
    redo,
    reload: (id: number) => frameStore.loadForShot(id),
  };
}
