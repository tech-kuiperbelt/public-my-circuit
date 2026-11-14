// 状态模型：最小可变的组件/电线/分组框容器；不做几何或拓扑校验（校验在 validate.js）。
import {
  CLOCK_DEFAULT_PERIOD,
  CLOCK_MAX_PERIOD,
  CLOCK_MIN_PERIOD,
  FRAME_DEFAULT_COLOR,
  FRAME_DEFAULT_LABEL
} from './entities.js';

export function createState() {
  return {
    nextId: 1,
    components: {},
    wires: {},
    frames: {}
  };
}

function makeId(state, prefix) {
  const id = prefix + state.nextId;
  state.nextId += 1;
  return id;
}

function normalizeClockPeriod(value) {
  if (!Number.isInteger(value) || value < CLOCK_MIN_PERIOD || value > CLOCK_MAX_PERIOD) {
    return CLOCK_DEFAULT_PERIOD;
  }
  return value;
}

export function addComponent(state, type, cx, cy, opts) {
  const options = opts || {};
  const id = makeId(state, 'c');
  const component = {
    id,
    type,
    cx,
    cy,
    rotation: options.rotation || 0
  };
  if (type === 'TOGGLE' || type === 'BUTTON') {
    component.on = Boolean(options.on);
  }
  if (type === 'CLOCK') {
    component.on = Boolean(options.on);
    component.period = normalizeClockPeriod(options.period);
  }
  state.components[id] = component;
  return id;
}

export function addWire(state, points, endA, endB) {
  const id = makeId(state, 'w');
  state.wires[id] = {
    id,
    points,
    endA,
    endB
  };
  return id;
}

export function getComponent(state, id) {
  return state.components[id];
}

// 分组框使用世界坐标矩形；标签/颜色是注释属性，不参与电路。
export function addFrame(state, x, y, w, h, opts) {
  const options = opts || {};
  const id = makeId(state, 'f');
  state.frames[id] = {
    id,
    x,
    y,
    w,
    h,
    color: options.color || FRAME_DEFAULT_COLOR,
    label: options.label || FRAME_DEFAULT_LABEL
  };
  return id;
}

// 删除元件：保留电线；指向该元件的 pin 端点变成悬空 free。
export function removeComponent(state, id) {
  if (!state.components[id]) {
    return false;
  }
  delete state.components[id];
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    wire.endA = detachPin(wire.endA, id);
    wire.endB = detachPin(wire.endB, id);
  }
  return true;
}

function detachPin(end, componentId) {
  if (end && end.kind === 'pin' && end.componentId === componentId) {
    return { kind: 'free' };
  }
  return end;
}
