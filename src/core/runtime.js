// 动态运行事务：结构失败拒绝；运行异常保留结构和完整轮次边界。
import { REASONS } from './reasons.js';
import { evaluateDynamic } from './dynamic.js';

export function commitResult(result, currentEvaluation, limits, options) {
  if (!result || !result.ok) return { ok: false, reason: result && result.reason };
  if (!result.state) return { ok: false, reason: REASONS.ILLEGAL_GEOMETRY };
  if (result.geometryOnly === true && currentEvaluation && currentEvaluation.status) {
    return { ok: true, state: result.state, evaluation: currentEvaluation };
  }
  const evaluation = evaluateDynamic(result.state, currentEvaluation, limits, options);
  if (!evaluation.ok) return { ok: false, reason: evaluation.reason };
  return { ok: true, state: result.state, evaluation };
}
