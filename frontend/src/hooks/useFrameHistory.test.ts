/**
 * useFrameHistory 单元测试：最近 20 步、撤销/重做、重做链作废、
 * 跨镜头隔离、localStorage 持久化恢复、外部改动后基线重置。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameEntry } from '../types/frame';

const frameFixtures: Record<number, FrameEntry[]> = {};

const mockFrameStore = {
  frames: [] as FrameEntry[],
  selectedFrameNo: null as number | null,
  loadForShot: vi.fn(async (shotId: number) => {
    mockFrameStore.frames = (frameFixtures[shotId] ?? []).map((f) => ({ ...f }));
  }),
  restoreSnapshot: vi.fn(async (_shotId: number, frames: FrameEntry[]) => {
    mockFrameStore.frames = frames.map((f) => ({ ...f }));
  }),
};

const mockShotStore = {
  shots: [] as { id: number; durationSec: number; startFrame: number; endFrame: number }[],
  byId(id: number) {
    return mockShotStore.shots.find((s) => s.id === id);
  },
  restoreRange: vi.fn(),
};

vi.mock('../stores/frameStore', () => ({
  useFrameStore: () => mockFrameStore,
}));
vi.mock('../stores/shotStore', () => ({
  useShotStore: () => mockShotStore,
}));
vi.mock('../db', () => ({ toPlain: <T>(v: T): T => JSON.parse(JSON.stringify(v)) }));

type HistoryApi = typeof import('./useFrameHistory');

async function makeHook(): Promise<HistoryApi> {
  vi.resetModules();
  return import('./useFrameHistory');
}

function frame(i: number, exposureSec = 0.25): FrameEntry {
  return {
    id: i,
    frameNo: i,
    shotId: 1,
    shotCount: 2,
    exposureSec,
    aperture: 5.6,
    iso: 200,
    shutterAngle: 180,
    lighting: '主灯 + 柔光箱',
    propOffsetMm: 0,
    note: '',
    updatedAt: 1,
  };
}

function shotRange(shotId: number, count: number) {
  return { id: shotId, durationSec: count / 24, startFrame: 1, endFrame: count };
}

/** 断言用：restoreRange 只写时长 / 帧区间三个字段 */
function rangeFields(count: number) {
  return { durationSec: count / 24, startFrame: 1, endFrame: count };
}

function setFrames(shotId: number, rows: FrameEntry[]) {
  frameFixtures[shotId] = rows;
  mockFrameStore.frames = rows.map((f) => ({ ...f }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFrameStore.frames = [];
  mockFrameStore.selectedFrameNo = null;
  mockShotStore.shots = [shotRange(1, 1), shotRange(2, 1)];
  setFrames(1, [frame(1)]);
  setFrames(2, [frame(1)]);
});

describe('useFrameHistory', () => {
  it('初始无历史时两个按钮都不可用', async () => {
    const { useFrameHistory } = await makeHook();
    const h = useFrameHistory();
    await h.init(1);
    expect(h.canUndo.value).toBe(false);
    expect(h.canRedo.value).toBe(false);
  });

  it('动作后可连续撤销并回退帧明细与时长，撤销后可重做', async () => {
    const { useFrameHistory } = await makeHook();
    const h = useFrameHistory();
    await h.init(1);

    await h.run(async () => {
      setFrames(1, [frame(1), frame(2)]);
      mockShotStore.shots[0] = shotRange(1, 2);
    });
    expect(h.canUndo.value).toBe(true);
    expect(h.canRedo.value).toBe(false);

    // 再改一步：单帧参数
    await h.run(async () => {
      setFrames(1, [frame(1, 0.125), frame(2)]);
    });

    await h.undo();
    expect(mockFrameStore.frames[0].exposureSec).toBe(0.25);
    expect(h.canRedo.value).toBe(true);

    await h.undo();
    expect(mockFrameStore.frames.length).toBe(1);
    expect(mockShotStore.restoreRange).toHaveBeenLastCalledWith(1, rangeFields(1));
    expect(h.canUndo.value).toBe(false);
    expect(h.canRedo.value).toBe(true);

    await h.redo();
    expect(mockFrameStore.frames.length).toBe(2);
    expect(mockShotStore.restoreRange).toHaveBeenLastCalledWith(1, rangeFields(2));
    await h.redo();
    expect(mockFrameStore.frames[0].exposureSec).toBe(0.125);
    expect(h.canRedo.value).toBe(false);
  });

  it('新的编排动作发生后原重做链作废', async () => {
    const { useFrameHistory } = await makeHook();
    const h = useFrameHistory();
    await h.init(1);
    await h.run(async () => {
      setFrames(1, [frame(1), frame(2)]);
      mockShotStore.shots[0] = shotRange(1, 2);
    });
    await h.undo();
    expect(h.canRedo.value).toBe(true);

    await h.run(async () => {
      setFrames(1, [frame(1, 0.5)]);
    });
    expect(h.canRedo.value).toBe(false);
    expect(await h.redo()).toBe(false);
  });

  it('内容无变化的动作不入栈（id / updatedAt 差异不算变化）', async () => {
    const { useFrameHistory } = await makeHook();
    const h = useFrameHistory();
    await h.init(1);
    const changed = await h.run(async () => {
      setFrames(1, [{ ...frame(1), id: 999, updatedAt: 12345 }]);
    });
    expect(changed).toBe(false);
    expect(h.canUndo.value).toBe(false);
  });

  it('只保留最近 20 步', async () => {
    const { useFrameHistory, FRAME_HISTORY_LIMIT } = await makeHook();
    const h = useFrameHistory();
    await h.init(1);
    for (let i = 2; i <= 25; i++) {
      await h.run(async () => {
        setFrames(1, Array.from({ length: i }, (_, j) => frame(j + 1)));
        mockShotStore.shots[0] = shotRange(1, i);
      });
    }
    let undos = 0;
    while (await h.undo()) undos++;
    expect(undos).toBe(FRAME_HISTORY_LIMIT);
    // 最老的 4 步已被丢弃，回退到底时停在 5 帧而不是 1 帧
    expect(mockFrameStore.frames.length).toBe(5);
  });

  it('切换镜头后撤销重做只作用于当前镜头，不串镜', async () => {
    const { useFrameHistory } = await makeHook();
    const h = useFrameHistory();
    await h.init(1);
    await h.run(async () => {
      setFrames(1, [frame(1), frame(2)]);
      mockShotStore.shots[0] = shotRange(1, 2);
    });

    await h.init(2);
    expect(h.canUndo.value).toBe(false);
    await h.run(async () => {
      setFrames(2, [frame(1), frame(2, 0.5)]);
      mockShotStore.shots[1] = shotRange(2, 2);
    });
    expect(h.canUndo.value).toBe(true);
    await h.undo();
    expect(mockFrameStore.frames.length).toBe(1);
    expect(mockShotStore.restoreRange).toHaveBeenLastCalledWith(2, rangeFields(1));

    // 切回镜头 1，仍保留自己的历史（init 会按 fixture 重新载入）
    setFrames(1, [frame(1), frame(2)]);
    await h.init(1);
    expect(h.canUndo.value).toBe(true);
    await h.undo();
    expect(mockShotStore.restoreRange).toHaveBeenLastCalledWith(1, rangeFields(1));
  });

  it('关掉页面再回来（重新载入模块读 localStorage）仍能撤销', async () => {
    let mod = await makeHook();
    const h1 = mod.useFrameHistory();
    await h1.init(1);
    await h1.run(async () => {
      setFrames(1, [frame(1), frame(2)]);
      mockShotStore.shots[0] = shotRange(1, 2);
    });
    expect(localStorage.getItem('gbstopmotion:frame-history:v1')).not.toBeNull();

    // 重新加载模块：内存单例清空，只剩 localStorage 里的持久历史
    vi.resetModules();
    mod = await import('./useFrameHistory');
    const h2 = mod.useFrameHistory();
    await h2.init(1);
    expect(h2.canUndo.value).toBe(true);
    expect(h2.canRedo.value).toBe(false);
    expect(await h2.undo()).toBe(true);
    expect(mockFrameStore.frames.length).toBe(1);
    expect(mockShotStore.restoreRange).toHaveBeenLastCalledWith(1, rangeFields(1));
  });

  it('外部改过帧序（如镜头详情页）后，旧历史失效并以当前状态为基线', async () => {
    const { useFrameHistory } = await makeHook();
    const h1 = useFrameHistory();
    await h1.init(1);
    await h1.run(async () => {
      setFrames(1, [frame(1), frame(2)]);
    });

    // 模拟别的页面把数据改成与栈顶不同的 3 帧
    setFrames(1, [frame(1), frame(2), frame(3, 0.125)]);
    const h2 = useFrameHistory();
    await h2.init(1);
    expect(h2.canUndo.value).toBe(false);
    expect(h2.canRedo.value).toBe(false);
  });
});
