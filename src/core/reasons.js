// 拒绝原因枚举与玩家文案；所有拒绝共用同一套 reason。
export const REASONS = Object.freeze({
  SECOND_DRIVER: 'SECOND_DRIVER',
  FEEDBACK_LOOP: 'FEEDBACK_LOOP',
  FEEDBACK_LOOP_LIMIT: 'FEEDBACK_LOOP_LIMIT',
  PURE_WIRE_LOOP: 'PURE_WIRE_LOOP',
  PIN_ALREADY_CONNECTED: 'PIN_ALREADY_CONNECTED',
  PIN_COINCIDENT: 'PIN_COINCIDENT',
  BLOCKED_BY_COMPONENT: 'BLOCKED_BY_COMPONENT',
  WIRE_ON_COMPONENT_EDGE: 'WIRE_ON_COMPONENT_EDGE',
  NO_ROUTE: 'NO_ROUTE',
  ILLEGAL_GEOMETRY: 'ILLEGAL_GEOMETRY',
  WIRED_OBJECT_LOCKED: 'WIRED_OBJECT_LOCKED',
  COPY_BLOCKED: 'COPY_BLOCKED'
});

export const REASON_TEXT = Object.freeze({
  SECOND_DRIVER: '这会让 net 出现第二个驱动者，请用 OR 门',
  FEEDBACK_LOOP: '这会让电路在某些输入下没有稳定状态',
  FEEDBACK_LOOP_LIMIT: '反馈环过大，当前版本无法判定是否存在稳定状态',
  PURE_WIRE_LOOP: '这两个点已经连在一起',
  PIN_ALREADY_CONNECTED: '该引脚已经接线',
  PIN_COINCIDENT: '引脚重合，请留出走线空间',
  BLOCKED_BY_COMPONENT: '被元件挡住',
  WIRE_ON_COMPONENT_EDGE: '电线不能贴着元件边',
  NO_ROUTE: '当前版本未找到可用路线',
  ILLEGAL_GEOMETRY: '线路不合法（穿线、重叠或脱离网格）',
  WIRED_OBJECT_LOCKED: '请先断开电线',
  COPY_BLOCKED: '目标区域放不下（有元件或导线）'
});

export function reasonText(reason) {
  return REASON_TEXT[reason] || '';
}
