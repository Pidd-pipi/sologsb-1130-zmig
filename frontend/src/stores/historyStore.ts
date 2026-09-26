/**
 * 编排历史 store：每个镜头各维护一条撤销 / 重做双栈（最多 HISTORY_LIMIT 步），
 * 持久化到 IndexedDB histories 表，关掉页面再打开仍可继续回退；
 * 栈按 shotId 隔离，切换镜头不会串到别的镜头。
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { toPlain } from '../db';
import type { FrameEntry } from '../types/frame';
import type { FrameHistoryEntry, ShotHistory } from '../types/history';
import { HISTORY_LIMIT, createEmptyShotHistory } from '../types/history';

interface HistoryState {
  /** 已加载镜头的双栈缓存，键为 shotId */
  byShot: Record<number, ShotHistory>;
  /** 已完成首次读取的镜头，避免重复回库覆盖内存中的新记录 */
  loadedShotIds: number[];
}

/** 进行中的首次读取，并发 ensureLoaded 共享同一个 Promise */
const pendingLoads = new Map<number, Promise<void>>();

export const useHistoryStore = defineStore('history', {
  state: (): HistoryState => ({
    byShot: {},
    loadedShotIds: [],
  }),
  getters: {
    canUndo(state) {
      return (shotId: number | null): boolean => shotId !== null && (state.byShot[shotId]?.undo.length ?? 0) > 0;
    },
    canRedo(state) {
      return (shotId: number | null): boolean => shotId !== null && (state.byShot[shotId]?.redo.length ?? 0) > 0;
    },
    /** 撤销栈顶的操作描述（用于按钮提示与反馈文案） */
    undoLabel(state) {
      return (shotId: number | null): string => {
        if (shotId === null) return '';
        const undo = state.byShot[shotId]?.undo;
        return undo && undo.length ? undo[undo.length - 1].label : '';
      };
    },
    redoLabel(state) {
      return (shotId: number | null): string => {
        if (shotId === null) return '';
        const redo = state.byShot[shotId]?.redo;
        return redo && redo.length ? redo[redo.length - 1].label : '';
      };
    },
  },
  actions: {
    /** 首次接触某镜头时从 IndexedDB 读回它的双栈 */
    async ensureLoaded(shotId: number) {
      if (this.loadedShotIds.includes(shotId)) return;
      const pending = pendingLoads.get(shotId);
      if (pending) return pending;
      const task = (async () => {
        const saved = await api.getShotHistory(shotId);
        this.byShot[shotId] = saved ?? createEmptyShotHistory(shotId);
        if (!this.loadedShotIds.includes(shotId)) this.loadedShotIds.push(shotId);
      })().finally(() => {
        pendingLoads.delete(shotId);
      });
      pendingLoads.set(shotId, task);
      return task;
    },
    stacksOf(shotId: number): ShotHistory {
      if (!this.byShot[shotId]) this.byShot[shotId] = createEmptyShotHistory(shotId);
      return this.byShot[shotId];
    },
    /** 把当前双栈整体落库（脱代理后写入） */
    async persist(shotId: number) {
      const stacks = this.byShot[shotId];
      if (!stacks) return;
      await api.saveShotHistory(toPlain({ ...stacks, shotId, updatedAt: Date.now() }));
    },
    /**
     * 在一次编排动作发生前记录前置快照；
     * 新动作一旦记录，该镜头的重做链即作废。
     */
    async record(shotId: number, label: string, frames: FrameEntry[], selectedFrameNo: number | null) {
      await this.ensureLoaded(shotId);
      const stacks = this.stacksOf(shotId);
      stacks.undo.push({ label, frames: toPlain(frames), selectedFrameNo, at: Date.now() });
      if (stacks.undo.length > HISTORY_LIMIT) stacks.undo.splice(0, stacks.undo.length - HISTORY_LIMIT);
      stacks.redo = [];
      await this.persist(shotId);
    },
    /**
     * 弹出撤销栈顶（操作前快照），同时把当前状态压入重做栈。
     * 返回待恢复的快照；无可撤销时返回 null。
     */
    async undo(
      shotId: number,
      currentFrames: FrameEntry[],
      currentSelectedFrameNo: number | null,
    ): Promise<FrameHistoryEntry | null> {
      await this.ensureLoaded(shotId);
      const stacks = this.stacksOf(shotId);
      const entry = stacks.undo.pop();
      if (!entry) return null;
      stacks.redo.push({ label: entry.label, frames: toPlain(currentFrames), selectedFrameNo: currentSelectedFrameNo, at: Date.now() });
      if (stacks.redo.length > HISTORY_LIMIT) stacks.redo.splice(0, stacks.redo.length - HISTORY_LIMIT);
      await this.persist(shotId);
      return entry;
    },
    /**
     * 弹出重做栈顶，同时把当前状态压回撤销栈。
     * 返回待恢复的快照；无可重做时返回 null。
     */
    async redo(
      shotId: number,
      currentFrames: FrameEntry[],
      currentSelectedFrameNo: number | null,
    ): Promise<FrameHistoryEntry | null> {
      await this.ensureLoaded(shotId);
      const stacks = this.stacksOf(shotId);
      const entry = stacks.redo.pop();
      if (!entry) return null;
      stacks.undo.push({ label: entry.label, frames: toPlain(currentFrames), selectedFrameNo: currentSelectedFrameNo, at: Date.now() });
      if (stacks.undo.length > HISTORY_LIMIT) stacks.undo.splice(0, stacks.undo.length - HISTORY_LIMIT);
      await this.persist(shotId);
      return entry;
    },
    /** 镜头被删除后清掉内存里的缓存（IndexedDB 侧由 deleteShot 级联清理） */
    forget(shotId: number) {
      delete this.byShot[shotId];
      this.loadedShotIds = this.loadedShotIds.filter((id) => id !== shotId);
    },
  },
});
