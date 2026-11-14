// 历史 v3 诊断运行策略；不由编辑器调用。
// 职责：运行策略层。把命令候选 state 变成可提交事务：
// 结构分析 → （需要时）规则 A 全输入校验 → 状态继承求值 → 成功才返回新 state/evaluation。
// 失败不修改入参 state 或已保存运行状态；本模块不写回任何全局。
import { REASONS } from './reasons.js';
import { analyzeState, evaluateWithAnalysis } from './eval.js';
import { buildInputVector, verifyAllInputs } from './feedback.js';

function emptyEvaluation() {
  return {
    ok: true,
    netValue: {},
    pinValue: {},
    lampOn: {},
    componentOutput: {}
  };
}

// 纯几何操作不改变逻辑拓扑与 net 关系，直接沿用上一轮运行状态，
// 不执行规则 A 全输入校验（见 feedback-loop-design §8.3 / §14.3）。
function isGeometryOnly(result) {
  return result.geometryOnly === true;
}

export function commitResult(result, currentEvaluation, limits) {
  if (!result || !result.ok) {
    return { ok: false, reason: result && result.reason };
  }
  if (!result.state) {
    return { ok: false, reason: REASONS.ILLEGAL_GEOMETRY };
  }

  const previous = currentEvaluation && currentEvaluation.ok
    ? currentEvaluation
    : emptyEvaluation();

  if (isGeometryOnly(result)) {
    return { ok: true, state: result.state, evaluation: previous };
  }

  const prepared = analyzeState(result.state);
  if (!prepared.ok) {
    return { ok: false, reason: prepared.reason };
  }

  let preferredWitness = null;
  if (result.inputOnly !== true && result.skipA !== true) {
    const currentX = prepared.analysis.groups.map(function (plan) {
      return buildInputVector(plan, result.state);
    });
    const verification = verifyAllInputs(prepared.analysis, limits, { currentX });
    if (verification.status === 'unsat') {
      return {
        ok: false,
        reason: REASONS.FEEDBACK_LOOP,
        verification
      };
    }
    if (verification.status === 'undecided') {
      return {
        ok: false,
        reason: REASONS.FEEDBACK_LOOP_LIMIT,
        verification
      };
    }
    preferredWitness = verification.currentWitness;
  }

  const evaluation = evaluateWithAnalysis(
    prepared.analysis,
    result.state,
    previous,
    limits,
    { preferredWitness }
  );
  if (!evaluation.ok) {
    return { ok: false, reason: evaluation.reason };
  }

  return {
    ok: true,
    state: result.state,
    evaluation
  };
}
