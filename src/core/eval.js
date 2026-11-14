// 历史静态诊断 API（v3）；编辑器正式运行使用 dynamic.js。
// 职责：纯函数求值。无反馈走 DAG 快速路径；有反馈先分组求静态固定点，
// 再把反馈输出作为已知量做拓扑传播。不写回 state，不持有运行状态。
import { COMPONENT_PINS } from './geometry.js';
import { buildNets } from './nets.js';
import { REASONS } from './reasons.js';
import {
  DEFAULT_FEEDBACK_LIMITS,
  analyzeFeedback,
  buildInputVector,
  solveGroup,
  witnessToBits
} from './feedback.js';

function resolveLimits(limits) {
  const source = limits || {};
  return {
    gateEvalBudget:
      source.gateEvalBudget === undefined
        ? DEFAULT_FEEDBACK_LIMITS.gateEvalBudget
        : source.gateEvalBudget,
    exhaustiveVars:
      source.exhaustiveVars === undefined
        ? DEFAULT_FEEDBACK_LIMITS.exhaustiveVars
        : source.exhaustiveVars
  };
}

// 分析电路：buildNets + 结构检查 + 反馈图。供 commit 复用，避免重复建图。
export function analyzeState(state) {
  const built = buildNets(state);
  const analysis = analyzeFeedback(state, built);
  if (!analysis.ok) {
    return { ok: false, reason: REASONS.SECOND_DRIVER };
  }
  return { ok: true, analysis };
}

// 组件拓扑序。fixedSet 中的组件视为已知量：既不入队，也不计入入度，
// 这样移除全部反馈元件后剩余图必为 DAG（反馈 SCC 已全部固定）。
function componentOrder(state, built, fixedSet) {
  const ids = Object.keys(state.components).sort();
  const adjacency = new Map();
  const indegree = new Map();
  for (const id of ids) {
    adjacency.set(id, new Set());
    indegree.set(id, 0);
  }

  for (const net of built.nets) {
    if (net.driverPins.length !== 1) {
      continue;
    }
    const driverId = net.driverPins[0].componentId;
    if (!adjacency.has(driverId)) {
      continue;
    }
    if (fixedSet.has(driverId)) {
      continue;
    }
    for (const pin of net.pins) {
      if (pin.dir !== 'in' || fixedSet.has(pin.componentId)) {
        continue;
      }
      if (!adjacency.has(pin.componentId)) {
        continue;
      }
      const targets = adjacency.get(driverId);
      if (targets.has(pin.componentId)) {
        continue;
      }
      targets.add(pin.componentId);
      indegree.set(pin.componentId, indegree.get(pin.componentId) + 1);
    }
  }

  const queue = ids.filter(function (id) {
    return !fixedSet.has(id) && indegree.get(id) === 0;
  });
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    const targets = Array.from(adjacency.get(id)).sort();
    for (const target of targets) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
      }
    }
    queue.sort();
  }

  if (order.length !== ids.length - fixedSet.size) {
    return null;
  }
  return order;
}

function groupSummary(plan, result) {
  return {
    index: plan.index,
    status: result.status,
    feedbackIds: plan.feedbackIds.slice(),
    toggleIds: plan.toggleIds.slice(),
    combinationalCount: plan.C,
    feedbackCount: plan.k,
    inputCount: plan.inputCount,
    gateEvals: result.gateEvals
  };
}

function feedbackWitnessFromOutputs(plan, runtimeState) {
  if (!runtimeState || !runtimeState.componentOutput) {
    return null;
  }
  const output = runtimeState.componentOutput;
  const bits = new Uint8Array(plan.k);
  for (let j = 0; j < plan.k; j += 1) {
    bits[j] = output[plan.feedbackIds[j]] === 1 ? 1 : 0;
  }
  if (plan.k <= 30) {
    let value = 0;
    for (let j = 0; j < bits.length; j += 1) {
      if (bits[j]) {
        value += Math.pow(2, j);
      }
    }
    return { bits: value };
  }
  // k > 30 时数字位打包不可用，直接用数组见证保留完整历史态。
  return { array: bits };
}

// 固定反馈输出后按拓扑序传播，得到 net/pin/lamp 值与下一轮继承输出。
function propagate(state, built, fixedOutputs, order) {
  const netsById = new Map();
  const netValue = {};
  const pinValue = {};
  const lampOn = {};
  const componentOutput = {};

  for (const net of built.nets) {
    netsById.set(net.id, net);
    netValue[net.id] = 0;
  }
  for (const id of Object.keys(state.components)) {
    const component = state.components[id];
    const pins = COMPONENT_PINS[component.type] || [];
    for (const pin of pins) {
      pinValue[id + ':' + pin.id] = 0;
    }
  }

  function readInput(componentId, pinId) {
    return pinValue[componentId + ':' + pinId] === 1 ? 1 : 0;
  }

  function writeOutput(componentId, value) {
    const key = componentId + ':out';
    pinValue[key] = value;
    componentOutput[componentId] = value;
    const netId = built.netIdOfPin[key];
    if (netId === undefined) {
      return;
    }
    netValue[netId] = value;
    const net = netsById.get(netId);
    if (!net) {
      return;
    }
    for (const pin of net.pins) {
      pinValue[pin.componentId + ':' + pin.pinId] = value;
    }
  }

  // 反馈元件输出是已知量，先写入其出线 net。
  for (const componentId of Object.keys(fixedOutputs)) {
    writeOutput(componentId, fixedOutputs[componentId]);
  }

  for (const id of order) {
    const component = state.components[id];
    switch (component.type) {
      case 'CONST1':
        writeOutput(id, 1);
        break;
      case 'TOGGLE':
      case 'BUTTON':
        writeOutput(id, component.on ? 1 : 0);
        break;
      case 'NOT':
        writeOutput(id, readInput(id, 'in') ? 0 : 1);
        break;
      case 'AND':
        writeOutput(id, readInput(id, 'a') && readInput(id, 'b') ? 1 : 0);
        break;
      case 'OR':
        writeOutput(id, readInput(id, 'a') || readInput(id, 'b') ? 1 : 0);
        break;
      case 'LAMP':
        lampOn[id] = readInput(id, 'in') === 1;
        break;
      default:
        break;
    }
  }

  return { netValue, pinValue, lampOn, componentOutput };
}

// 复用已完成的反馈分析，避免 commit 阶段重复 buildNets/Tarjan。
// options.preferredWitness: verifyAllInputs 为当前 X 返回的见证（可空）。
export function evaluateWithAnalysis(analysis, state, runtimeState, limits, options) {
  const resolved = resolveLimits(limits);
  const opts = options || {};
  const built = analysis.built;
  const fixedOutputs = {};
  const fixedSet = new Set();
  const groupResults = [];
  let remaining = resolved.gateEvalBudget;
  let preferredWitness = Array.isArray(opts.preferredWitness)
    ? opts.preferredWitness
    : null;

  for (let index = 0; index < analysis.groups.length; index += 1) {
    const plan = analysis.groups[index];
    const xValue = buildInputVector(plan, state);
    const preferred = [];
    const inherited = feedbackWitnessFromOutputs(plan, runtimeState);
    if (inherited) {
      preferred.push(inherited);
    }
    const verified = preferredWitness ? preferredWitness[index] : null;
    if (verified) {
      preferred.push(verified);
    }

    const result = solveGroup(plan, xValue, preferred, resolved, remaining);
    remaining -= result.gateEvals;
    groupResults.push(groupSummary(plan, result));
    if (result.status === 'unsat') {
      return {
        ok: false,
        reason: REASONS.FEEDBACK_LOOP,
        feedbackGroups: groupResults
      };
    }
    if (result.status === 'undecided') {
      return {
        ok: false,
        reason: REASONS.FEEDBACK_LOOP_LIMIT,
        feedbackGroups: groupResults
      };
    }

    const bits = witnessToBits(plan, result.witness);
    for (let j = 0; j < plan.k; j += 1) {
      fixedOutputs[plan.feedbackIds[j]] = bits[j];
      fixedSet.add(plan.feedbackIds[j]);
    }
  }

  const order = componentOrder(state, built, fixedSet);
  if (!order) {
    // 有反馈时所有环都应由固定反馈元件打断；走到这里说明分析/固定不一致。
    return {
      ok: false,
      reason: REASONS.FEEDBACK_LOOP,
      feedbackGroups: groupResults
    };
  }

  const propagated = propagate(state, built, fixedOutputs, order);
  return Object.assign({ ok: true }, propagated, {
    feedbackGroups: groupResults
  });
}

export function evaluate(state, runtimeState, limits) {
  const prepared = analyzeState(state);
  if (!prepared.ok) {
    return { ok: false, reason: prepared.reason };
  }
  return evaluateWithAnalysis(prepared.analysis, state, runtimeState, limits);
}
