// CLOCK 调度器：位于 L2 纯状态转移之上，只负责在仿真时刻批量翻转 CLOCK.on，
// 然后调用现有 evaluateDynamic 传播。它不改变反馈环、传播轮次或门语义。
//
// 时间单位是整数仿真 tick；一个完整 CLOCK 周期包含两个半周期。
// 同一时刻到期的所有 CLOCK 先全部翻转，再统一求值一次，结果与元件遍历顺序无关。
import {
  CLOCK_DEFAULT_PERIOD,
  CLOCK_MAX_PERIOD,
  CLOCK_MIN_PERIOD
} from './entities.js';
import { evaluateDynamic } from './dynamic.js';

function clone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function blocksClockAdvance(evaluation) {
  return Boolean(evaluation) && evaluation.ok === true && evaluation.status !== 'stable';
}

export function normalizeClockPeriod(value) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(numeric) || numeric < CLOCK_MIN_PERIOD || numeric > CLOCK_MAX_PERIOD) {
    return null;
  }
  return numeric;
}

export function clockPeriod(component) {
  const normalized = normalizeClockPeriod(component && component.period);
  return normalized === null ? CLOCK_DEFAULT_PERIOD : normalized;
}

export function createClockRuntime() {
  return {
    time: 0,
    paused: false,
    schedule: new Map()
  };
}

export function resetClockRuntime(runtime) {
  if (!runtime) {
    return;
  }
  runtime.time = 0;
  runtime.schedule.clear();
}

// 清除所有 CLOCK 的输出，返回新 state。用于用户主动“重置仿真”。
export function resetClockValues(state) {
  const next = clone(state);
  let changed = false;
  for (const component of Object.values(next.components)) {
    if (component && component.type === 'CLOCK' && component.on) {
      component.on = false;
      changed = true;
    }
  }
  return { state: next, changed };
}

// 让调度表与当前 state 对齐：
// - 新建/复制的 CLOCK 从当前时刻开始自己的半周期；
// - period 改变时重新从当前时刻起算；
// - 已删除的 CLOCK 不再保留任何定时事件。
export function reconcileClockRuntime(runtime, state) {
  const seen = new Set();
  for (const id of Object.keys(state.components).sort()) {
    const component = state.components[id];
    if (!component || component.type !== 'CLOCK') {
      continue;
    }
    seen.add(id);
    const period = clockPeriod(component);
    const existing = runtime.schedule.get(id);
    if (!existing || existing.period !== period) {
      const firstHalf = Math.ceil(period / 2);
      runtime.schedule.set(id, {
        period,
        nextEdge: runtime.time + firstHalf,
        // 下一次翻转后的间隔；奇周期时在 ceil/floor 之间交替。
        gapAfterEdge: period - firstHalf
      });
    }
  }
  for (const id of Array.from(runtime.schedule.keys())) {
    if (!seen.has(id)) {
      runtime.schedule.delete(id);
    }
  }
}

function nextEdge(runtime) {
  let time = null;
  for (const entry of runtime.schedule.values()) {
    if (time === null || entry.nextEdge < time) {
      time = entry.nextEdge;
    }
  }
  if (time === null) {
    return null;
  }
  const ids = [];
  for (const [id, entry] of runtime.schedule) {
    if (entry.nextEdge === time) {
      ids.push(id);
    }
  }
  ids.sort();
  return { time, ids };
}

// 推进到 targetTime；所有中间边沿按时间顺序处理，同一时刻批量提交。
// 返回值中的 state 可能是原引用（无时钟边沿）或新副本。
export function advanceClockRuntime(runtime, state, previous, targetTime, limits, options) {
  if (!runtime || !state || !state.components) {
    return { ok: false, reason: 'INVALID_CLOCK_RUNTIME' };
  }
  if (!Number.isFinite(targetTime)) {
    targetTime = runtime.time;
  }
  targetTime = Math.floor(targetTime);
  if (targetTime < runtime.time) {
    targetTime = runtime.time;
  }

  reconcileClockRuntime(runtime, state);

  if (runtime.paused) {
    return {
      ok: true,
      state,
      evaluation: previous,
      time: runtime.time,
      changed: false,
      edges: 0,
      paused: true,
      blocked: false
    };
  }

  // 已有振荡/预算状态时不再注入新的时钟边沿；用户修改电路后可自然恢复。
  if (blocksClockAdvance(previous)) {
    return {
      ok: true,
      state,
      evaluation: previous,
      time: runtime.time,
      changed: false,
      edges: 0,
      paused: false,
      blocked: true
    };
  }

  let currentState = state;
  let evaluation = previous;
  let changed = false;
  let edges = 0;

  while (true) {
    const due = nextEdge(runtime);
    if (!due || due.time > targetTime) {
      break;
    }

    if (currentState === state) {
      currentState = clone(state);
    }

    for (const id of due.ids) {
      const entry = runtime.schedule.get(id);
      const component = currentState.components[id];
      if (!entry || !component || component.type !== 'CLOCK') {
        runtime.schedule.delete(id);
        continue;
      }
      component.on = !component.on;
      edges += 1;
      entry.nextEdge = due.time + entry.gapAfterEdge;
      entry.gapAfterEdge = entry.period - entry.gapAfterEdge;
    }

    evaluation = evaluateDynamic(currentState, evaluation, limits, options);
    changed = true;
    if (!evaluation || evaluation.ok !== true) {
      runtime.time = due.time;
      return {
        ok: false,
        reason: evaluation && evaluation.reason,
        state: currentState,
        evaluation,
        time: runtime.time,
        changed,
        edges,
        paused: false,
        blocked: true
      };
    }
    if (evaluation.status !== 'stable') {
      runtime.time = due.time;
      return {
        ok: true,
        state: currentState,
        evaluation,
        time: runtime.time,
        changed,
        edges,
        paused: false,
        blocked: true
      };
    }
  }

  runtime.time = targetTime;
  return {
    ok: true,
    state: currentState,
    evaluation,
    time: runtime.time,
    changed,
    edges,
    paused: false,
    blocked: false
  };
}
