// 实体契约：当前 POC 的元件类型与 footprint（几何细节见 geometry.js）。
export const ENTITY_TYPES = Object.freeze([
  'CONST1',
  'TOGGLE',
  'BUTTON',
  'CLOCK',
  'NOT',
  'AND',
  'OR',
  'LAMP'
]);

export const FOOTPRINT = Object.freeze({ width: 1, height: 1 });

// CLOCK 的 period 是一个完整周期（0→1→0）的仿真时间单位数。
// 周期至少为 2，保证两个半周期都至少占 1 个仿真单位。
export const CLOCK_DEFAULT_PERIOD = 20;
export const CLOCK_MIN_PERIOD = 2;
export const CLOCK_MAX_PERIOD = 1000000;

// 分组框是画布上的注释对象，不参与 net/求值。
export const FRAME_DEFAULT_COLOR = '#8a8a8a';
export const FRAME_DEFAULT_LABEL = '未定义';
