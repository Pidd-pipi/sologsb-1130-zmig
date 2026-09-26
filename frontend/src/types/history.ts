/** 编排历史：每个镜头各保留最近若干步撤销 / 重做记录，随镜头隔离互不影响 */
import type { FrameEntry } from './frame';

/** 每个镜头最多保留的撤销步数 */
export const HISTORY_LIMIT = 20;

/** 一步编排记录：操作发生前的帧序快照与选中帧号 */
export interface FrameHistoryEntry {
  /** 操作描述，如 插入帧 / 删除帧 / 移动帧 / 修改单帧参数 / 批量套用曝光 */
  label: string;
  /** 操作前的整段帧序快照（帧号已按 1..N 排好） */
  frames: FrameEntry[];
  /** 操作前的选中帧号 */
  selectedFrameNo: number | null;
  /** 记录时间戳 */
  at: number;
}

/** 一个镜头的撤销 / 重做双栈，整体作为一条记录存入 IndexedDB（主键 shotId） */
export interface ShotHistory {
  shotId: number;
  /** 撤销栈，栈顶在末尾，最多 HISTORY_LIMIT 步 */
  undo: FrameHistoryEntry[];
  /** 重做栈，发生新编排动作时清空 */
  redo: FrameHistoryEntry[];
  updatedAt: number;
}

export const createEmptyShotHistory = (shotId: number): ShotHistory => ({
  shotId,
  undo: [],
  redo: [],
  updatedAt: Date.now(),
});
