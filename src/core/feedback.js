// 历史规则 A / 固定点诊断；动态模式不调用本模块作运行准入。
import { COMPONENT_PINS } from './geometry.js';
import { buildNets } from './nets.js';

export const DEFAULT_FEEDBACK_LIMITS = Object.freeze({
  gateEvalBudget: 8000000,
  exhaustiveVars: 20
});

const OP_NOT = 1;
const OP_AND = 2;
const OP_OR = 3;

const GATE_TYPES = new Set(['NOT', 'AND', 'OR']);

function opCode(type) {
  if (type === 'NOT') return OP_NOT;
  if (type === 'AND') return OP_AND;
  if (type === 'OR') return OP_OR;
  return 0;
}

function inputPinIds(type) {
  const defs = COMPONENT_PINS[type] || [];
  const out = [];
  for (const def of defs) {
    if (def.dir === 'in') out.push(def.id);
  }
  return out;
}

function prepareBuilt(built, state) {
  const source = built || buildNets(state);
  if (source.netsById instanceof Map) {
    return source;
  }
  const netsById = new Map();
  for (const net of source.nets) {
    netsById.set(net.id, net);
  }
  return Object.assign({}, source, { netsById });
}

function tarjan(n, adj) {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const sccOf = new Int32Array(n).fill(-1);
  const stack = [];
  const sccs = [];
  let counter = 0;

  for (let root = 0; root < n; root += 1) {
    if (index[root] !== -1) continue;
    const frames = [{ v: root, next: 0 }];
    index[root] = counter;
    low[root] = counter;
    counter += 1;
    stack.push(root);
    onStack[root] = 1;

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const v = frame.v;
      if (frame.next < adj[v].length) {
        const w = adj[v][frame.next];
        frame.next += 1;
        if (index[w] === -1) {
          index[w] = counter;
          low[w] = counter;
          counter += 1;
          stack.push(w);
          onStack[w] = 1;
          frames.push({ v: w, next: 0 });
        } else if (onStack[w] && index[w] < low[v]) {
          low[v] = index[w];
        }
        continue;
      }

      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].v;
        if (low[v] < low[parent]) low[parent] = low[v];
      }
      if (low[v] === index[v]) {
        const component = [];
        for (;;) {
          const w = stack.pop();
          onStack[w] = 0;
          sccOf[w] = sccs.length;
          component.push(w);
          if (w === v) break;
        }
        component.sort(function (a, b) {
          return a - b;
        });
        sccs.push(component);
      }
    }
  }

  return { sccOf, sccs };
}

function makeDsu(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;

  function find(x) {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  }

  return { find, union };
}

function insertSorted(array, value) {
  let lo = 0;
  let hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (array[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  array.splice(lo, 0, value);
}

function buildGroupPlan(built, componentIds, indexOf, types, radj, adj, feedbackList, index) {
  const feedbackSet = new Set(feedbackList);
  const n = componentIds.length;
  const relevant = new Uint8Array(n);
  const stack = [];
  for (const f of feedbackList) {
    if (!relevant[f]) {
      relevant[f] = 1;
      stack.push(f);
    }
  }
  while (stack.length > 0) {
    const v = stack.pop();
    for (const u of radj[v]) {
      if (!relevant[u]) {
        relevant[u] = 1;
        stack.push(u);
      }
    }
  }

  const toggleIdx = [];
  const const1Idx = [];
  const planNodes = [];
  for (let v = 0; v < n; v += 1) {
    if (!relevant[v]) continue;
    if (types[v] === 'TOGGLE' || types[v] === 'BUTTON') toggleIdx.push(v);
    else if (types[v] === 'CONST1') const1Idx.push(v);
    else if (GATE_TYPES.has(types[v]) && !feedbackSet.has(v)) planNodes.push(v);
  }

  const planSet = new Set(planNodes);
  const sourceCache = new Map();

  function sourcesOf(v) {
    if (sourceCache.has(v)) return sourceCache.get(v);
    const pins = inputPinIds(types[v]);
    const sources = [];
    for (const pinId of pins) {
      const netId = built.netIdOfPin[componentIds[v] + ':' + pinId];
      if (netId === undefined) {
        sources.push(-1);
        continue;
      }
      const net = built.netsById.get(netId);
      if (!net || net.driverPins.length !== 1) {
        sources.push(-1);
        continue;
      }
      const driver = indexOf.get(net.driverPins[0].componentId);
      sources.push(driver === undefined ? -1 : driver);
    }
    sourceCache.set(v, sources);
    return sources;
  }

  const indegree = new Int32Array(n);
  for (const v of planNodes) {
    let degree = 0;
    for (const source of radj[v]) {
      if (planSet.has(source)) degree += 1;
    }
    indegree[v] = degree;
  }

  const ready = planNodes.filter(function (v) {
    return indegree[v] === 0;
  });
  ready.sort(function (a, b) {
    return a - b;
  });

  const planIdx = [];
  while (ready.length > 0) {
    const v = ready.shift();
    planIdx.push(v);
    for (const target of adj[v]) {
      if (!planSet.has(target)) continue;
      indegree[target] -= 1;
      if (indegree[target] === 0) insertSorted(ready, target);
    }
  }
  if (planIdx.length !== planNodes.length) {
    for (const v of planNodes) {
      if (planIdx.indexOf(v) === -1) planIdx.push(v);
    }
  }

  const feedbackIdx = feedbackList.slice().sort(function (a, b) {
    return a - b;
  });

  const C = planIdx.length;
  const k = feedbackIdx.length;
  const planOp = new Uint8Array(C);
  const planA = new Int32Array(C);
  const planB = new Int32Array(C);

  for (let i = 0; i < C; i += 1) {
    const v = planIdx[i];
    const sources = sourcesOf(v);
    planOp[i] = opCode(types[v]);
    planA[i] = sources.length > 0 ? sources[0] : -1;
    planB[i] = sources.length > 1 ? sources[1] : -1;
  }

  const fbOp = new Uint8Array(k);
  const fbA = new Int32Array(k);
  const fbB = new Int32Array(k);
  for (let i = 0; i < k; i += 1) {
    const v = feedbackIdx[i];
    const sources = sourcesOf(v);
    fbOp[i] = opCode(types[v]);
    fbA[i] = sources.length > 0 ? sources[0] : -1;
    fbB[i] = sources.length > 1 ? sources[1] : -1;
  }

  const inputCount = toggleIdx.length;

  return {
    index,
    feedbackIds: feedbackIdx.map(function (v) {
      return componentIds[v];
    }),
    feedbackIdx: Int32Array.from(feedbackIdx),
    toggleIds: toggleIdx.map(function (v) {
      return componentIds[v];
    }),
    toggleIdx: Int32Array.from(toggleIdx),
    planIds: planIdx.map(function (v) {
      return componentIds[v];
    }),
    planIdx: Int32Array.from(planIdx),
    planOp,
    planA,
    planB,
    fbOp,
    fbA,
    fbB,
    const1Idx: Int32Array.from(const1Idx),
    C,
    k,
    inputCount,
    perTrial: C + k,
    xSpace: inputCount > 30 ? Infinity : Math.pow(2, inputCount)
  };
}

export function analyzeFeedback(state, built) {
  const prepared = prepareBuilt(built, state);
  for (const net of prepared.nets) {
    if (net.driverPins.length > 1) {
      return { ok: false, multipleDrivers: true };
    }
  }

  const componentIds = Object.keys(state.components).sort();
  const n = componentIds.length;
  const indexOf = new Map();
  for (let i = 0; i < n; i += 1) indexOf.set(componentIds[i], i);
  const types = componentIds.map(function (id) {
    return state.components[id].type;
  });

  const adj = [];
  const radj = [];
  for (let i = 0; i < n; i += 1) {
    adj.push([]);
    radj.push([]);
  }
  const seenEdges = new Set();
  for (const net of prepared.nets) {
    if (net.driverPins.length !== 1) continue;
    const driver = indexOf.get(net.driverPins[0].componentId);
    if (driver === undefined) continue;
    for (const pin of net.pins) {
      if (pin.dir !== 'in') continue;
      const target = indexOf.get(pin.componentId);
      if (target === undefined) continue;
      const key = driver + '>' + target;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      adj[driver].push(target);
      radj[target].push(driver);
    }
  }
  for (let i = 0; i < n; i += 1) {
    adj[i].sort(function (a, b) {
      return a - b;
    });
    radj[i].sort(function (a, b) {
      return a - b;
    });
  }

  const tarjanResult = tarjan(n, adj);
  const sccs = tarjanResult.sccs;
  const sccOf = tarjanResult.sccOf;
  const sccCount = sccs.length;

  const hasSelfLoop = new Uint8Array(n);
  for (let v = 0; v < n; v += 1) {
    if (adj[v].indexOf(v) !== -1) hasSelfLoop[v] = 1;
  }

  const feedbackScc = new Uint8Array(sccCount);
  for (let s = 0; s < sccCount; s += 1) {
    const component = sccs[s];
    if (component.length > 1 || hasSelfLoop[component[0]]) feedbackScc[s] = 1;
  }

  const dagSets = [];
  for (let s = 0; s < sccCount; s += 1) dagSets.push(new Set());
  for (let u = 0; u < n; u += 1) {
    for (const v of adj[u]) {
      const su = sccOf[u];
      const sv = sccOf[v];
      if (su !== sv) dagSets[su].add(sv);
    }
  }
  const dag = dagSets.map(function (set) {
    return Array.from(set).sort(function (a, b) {
      return a - b;
    });
  });

  const dsu = makeDsu(sccCount);
  for (let source = 0; source < sccCount; source += 1) {
    if (!feedbackScc[source]) continue;
    const visited = new Uint8Array(sccCount);
    const stack = [source];
    visited[source] = 1;
    while (stack.length > 0) {
      const current = stack.pop();
      for (const next of dag[current]) {
        if (visited[next]) continue;
        visited[next] = 1;
        if (feedbackScc[next]) dsu.union(source, next);
        stack.push(next);
      }
    }
  }

  const buckets = new Map();
  for (let s = 0; s < sccCount; s += 1) {
    if (!feedbackScc[s]) continue;
    const root = dsu.find(s);
    if (!buckets.has(root)) buckets.set(root, []);
    const bucket = buckets.get(root);
    for (const v of sccs[s]) bucket.push(v);
  }

  const groupLists = [];
  for (const bucket of buckets.values()) {
    bucket.sort(function (a, b) {
      return a - b;
    });
    groupLists.push(bucket);
  }
  groupLists.sort(function (a, b) {
    return a[0] - b[0];
  });

  const feedbackComponentIds = [];
  for (let v = 0; v < n; v += 1) {
    if (feedbackScc[sccOf[v]]) feedbackComponentIds.push(componentIds[v]);
  }

  const groups = groupLists.map(function (feedbackList, groupIndex) {
    return buildGroupPlan(
      prepared,
      componentIds,
      indexOf,
      types,
      radj,
      adj,
      feedbackList,
      groupIndex
    );
  });

  return {
    ok: true,
    componentIds,
    types,
    indexOf,
    adj,
    radj,
    sccs,
    sccOf,
    feedbackComponentIds,
    groups,
    built: prepared
  };
}

export function buildInputVector(plan, state) {
  let value = 0;
  const ids = plan.toggleIds;
  for (let j = 0; j < ids.length; j += 1) {
    const component = state.components[ids[j]];
    if (component && component.on) value += Math.pow(2, j);
  }
  return value;
}

function normalizeLimits(limits) {
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

function parseWitness(witness) {
  if (!witness) return null;
  if (Array.isArray(witness) || witness instanceof Uint8Array) {
    return { uniform: -1, bits: 0, array: witness };
  }
  if (typeof witness !== 'object') return null;
  if (witness.uniform === 0 || witness.uniform === 1) {
    return { uniform: witness.uniform, bits: witness.uniform, array: null };
  }
  if (typeof witness.bits === 'number' && Number.isFinite(witness.bits)) {
    return { uniform: -1, bits: witness.bits, array: null };
  }
  if (Array.isArray(witness.array) || witness.array instanceof Uint8Array) {
    return { uniform: -1, bits: 0, array: witness.array };
  }
  return null;
}

function planMaxIndex(plan) {
  let max = -1;
  const arrays = [
    plan.feedbackIdx,
    plan.toggleIdx,
    plan.planIdx,
    plan.planA,
    plan.planB,
    plan.fbA,
    plan.fbB,
    plan.const1Idx
  ];
  for (const array of arrays) {
    if (!array) continue;
    for (let i = 0; i < array.length; i += 1) {
      if (array[i] > max) max = array[i];
    }
  }
  return max;
}

const sessionCache = new WeakMap();

// 每个 plan 复用 scratch 与 trial/runTrial 闭包；一次提交内按 X 反复调用时
// 避免每次分配数组与函数（S0 后续实测发现这是高 xSpace 场景的主要墙钟开销）。
function createSession(plan) {
  const out = new Uint8Array(planMaxIndex(plan) + 1);
  if (plan.const1Idx) {
    for (let i = 0; i < plan.const1Idx.length; i += 1) {
      out[plan.const1Idx[i]] = 1;
    }
  }

  const feedbackIdx = plan.feedbackIdx;
  const toggleIdx = plan.toggleIdx;
  const planIdx = plan.planIdx;
  const planOp = plan.planOp;
  const planA = plan.planA;
  const planB = plan.planB;
  const fbOp = plan.fbOp;
  const fbA = plan.fbA;
  const fbB = plan.fbB;
  const k = plan.k;
  const C = plan.C;
  const perTrial = plan.perTrial;

  function trial(xInt, sInt, uniform, array) {
    for (let j = 0; j < toggleIdx.length; j += 1) {
      out[toggleIdx[j]] = (xInt >>> j) & 1;
    }
    for (let j = 0; j < k; j += 1) {
      out[feedbackIdx[j]] = array
        ? (array[j] ? 1 : 0)
        : uniform >= 0
          ? uniform
          : (sInt >>> j) & 1;
    }

    for (let i = 0; i < C; i += 1) {
      const node = planIdx[i];
      const aIndex = planA[i];
      const a = aIndex < 0 ? 0 : out[aIndex];
      const op = planOp[i];
      if (op === OP_NOT) {
        out[node] = a ? 0 : 1;
      } else {
        const bIndex = planB[i];
        const b = bIndex < 0 ? 0 : out[bIndex];
        out[node] = op === OP_AND ? (a && b ? 1 : 0) : a || b ? 1 : 0;
      }
    }

    for (let j = 0; j < k; j += 1) {
      const aIndex = fbA[j];
      const a = aIndex < 0 ? 0 : out[aIndex];
      const op = fbOp[j];
      let value;
      if (op === OP_NOT) {
        value = a ? 0 : 1;
      } else {
        const bIndex = fbB[j];
        const b = bIndex < 0 ? 0 : out[bIndex];
        value = op === OP_AND ? (a && b ? 1 : 0) : a || b ? 1 : 0;
      }
      if (value !== out[feedbackIdx[j]]) return false;
    }
    return true;
  }

  // 返回 -1=预算不足；0=不是固定点；1=固定点。
  function attempt(xInt, sInt, uniform, array, budget, used) {
    if (used + perTrial > budget) return -1;
    return trial(xInt, sInt, uniform, array) ? 1 : 0;
  }

  return { attempt, perTrial };
}

function getSession(plan) {
  let session = sessionCache.get(plan);
  if (!session) {
    session = createSession(plan);
    sessionCache.set(plan, session);
  }
  return session;
}

function solveGroupWithSession(plan, xInt, preferred, normalized, remainingBudget, session) {
  const budget =
    remainingBudget === undefined ? normalized.gateEvalBudget : remainingBudget;
  const exhaustiveVars = normalized.exhaustiveVars;
  const perTrial = session.perTrial;
  const attempt = session.attempt;
  let gateEvals = 0;

  if (plan.inputCount > 30 || !Number.isFinite(plan.xSpace)) {
    return { status: 'undecided', reason: 'input_space_limit', gateEvals: 0 };
  }

  if (Array.isArray(preferred)) {
    for (const candidate of preferred) {
      const parsed = parseWitness(candidate);
      if (!parsed) continue;
      const result = attempt(
        xInt,
        parsed.bits,
        parsed.uniform,
        parsed.array,
        budget,
        gateEvals
      );
      if (result === -1) {
        return { status: 'undecided', reason: 'budget_runtime', gateEvals };
      }
      gateEvals += perTrial;
      if (result === 1) {
        return { status: 'sat', witness: candidate, gateEvals };
      }
    }
  }

  let result = attempt(xInt, 0, 0, null, budget, gateEvals);
  if (result === -1) {
    return { status: 'undecided', reason: 'budget_runtime', gateEvals };
  }
  gateEvals += perTrial;
  if (result === 1) {
    return { status: 'sat', witness: { uniform: 0 }, gateEvals };
  }

  result = attempt(xInt, 0, 1, null, budget, gateEvals);
  if (result === -1) {
    return { status: 'undecided', reason: 'budget_runtime', gateEvals };
  }
  gateEvals += perTrial;
  if (result === 1) {
    return { status: 'sat', witness: { uniform: 1 }, gateEvals };
  }

  if (plan.k > exhaustiveVars || plan.k > 30) {
    return { status: 'undecided', reason: 'vars_limit', gateEvals };
  }

  const space = Math.pow(2, plan.k);
  for (let s = 0; s < space; s += 1) {
    result = attempt(xInt, s, -1, null, budget, gateEvals);
    if (result === -1) {
      return { status: 'undecided', reason: 'budget_runtime', gateEvals };
    }
    gateEvals += perTrial;
    if (result === 1) {
      return { status: 'sat', witness: { bits: s }, gateEvals };
    }
  }

  return { status: 'unsat', reason: 'no_fixed_point', gateEvals };
}

export function solveGroup(plan, xInt, preferred, limits, remainingBudget) {
  return solveGroupWithSession(
    plan,
    xInt,
    preferred,
    normalizeLimits(limits),
    remainingBudget,
    getSession(plan)
  );
}

export function verifyAllInputs(analysis, limits, options) {
  const normalized = normalizeLimits(limits);
  const opts = options || {};
  const hasCurrent = Array.isArray(opts.currentX);
  const budget = normalized.gateEvalBudget;
  const groups = analysis.groups || [];

  let gateEvals = 0;
  let anyUnsat = false;
  let anyUndecided = false;
  let undecidedReason = null;
  const groupResults = [];
  const currentWitness = [];

  for (const plan of groups) {
    let status = 'sat_all';
    let reason = 'accepted';
    let groupEvals = 0;
    let counterexampleX;
    let witness = null;
    const currentX = hasCurrent ? opts.currentX[plan.index] : undefined;

    if (plan.inputCount > 30 || !Number.isFinite(plan.xSpace)) {
      status = 'undecided';
      reason = 'input_space_limit';
    } else {
      const session = getSession(plan);
      for (let x = 0; x < plan.xSpace; x += 1) {
        const result = solveGroupWithSession(
          plan,
          x,
          null,
          normalized,
          budget - gateEvals - groupEvals,
          session
        );
        groupEvals += result.gateEvals;
        if (result.status === 'sat') {
          if (x === currentX) witness = result.witness;
        } else if (result.status === 'unsat') {
          status = 'unsat';
          reason = result.reason || 'no_fixed_point';
          counterexampleX = x;
          break;
        } else {
          status = 'undecided';
          reason = result.reason || 'undecided';
          break;
        }
      }
    }

    gateEvals += groupEvals;
    if (status === 'unsat') {
      anyUnsat = true;
    } else if (status === 'undecided' && !anyUndecided) {
      anyUndecided = true;
      undecidedReason = reason;
    }

    const entry = {
      index: plan.index,
      status,
      reason,
      gateEvals: groupEvals
    };
    if (counterexampleX !== undefined) entry.counterexampleX = counterexampleX;
    groupResults.push(entry);
    currentWitness.push(witness);
  }

  let status;
  let reason;
  if (anyUnsat) {
    status = 'unsat';
    reason = 'no_fixed_point';
  } else if (anyUndecided) {
    status = 'undecided';
    reason = undecidedReason || 'undecided';
  } else {
    status = 'sat_all';
    reason = 'accepted';
  }

  return {
    status,
    reason,
    gateEvals,
    groups: groupResults,
    currentWitness
  };
}

export function witnessToBits(plan, witness) {
  const bits = new Uint8Array(plan.k);
  if (!witness) return bits;
  const array = Array.isArray(witness)
    ? witness
    : (witness.array || null);
  if (array) {
    for (let j = 0; j < plan.k; j += 1) {
      bits[j] = array[j] ? 1 : 0;
    }
    return bits;
  }
  if (witness.uniform === 0 || witness.uniform === 1) {
    bits.fill(witness.uniform);
    return bits;
  }
  const value = typeof witness.bits === 'number' ? witness.bits : 0;
  for (let j = 0; j < plan.k; j += 1) {
    if (j < 31) bits[j] = (value >>> j) & 1;
    else bits[j] = Math.floor(value / Math.pow(2, j)) & 1;
  }
  return bits;
}
