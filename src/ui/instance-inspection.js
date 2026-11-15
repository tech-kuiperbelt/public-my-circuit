// Read-only resolution of one instance's actual runtime scene. A saved
// definition's initialEvaluation is never used as a substitute for a scene.
import { evaluateDynamic } from '../core/dynamic.js';
import { definitionBuilt, externalInputsForInstance, getDefinition, inputPorts, portValue } from '../core/ports.js';
import { getOscillationHighlight } from './oscillation-highlight.js';

function completeEvaluation(value) {
  return Boolean(value && value.ok === true && value.pinValue && value.netValue &&
    value.componentOutput && value.componentTypes && value.inputDrivers &&
    value.inputConnections && Array.isArray(value.pending) && value.stats);
}

export function resolveInstanceInspection(state, evaluation, instanceId, definitions) {
  const instance = state && state.components && state.components[instanceId];
  if (!instance || instance.type !== 'CUSTOM') return { ok: false, reason: '当前图纸中没有该封装实例' };
  const definition = getDefinition(definitions, instance.definitionId);
  if (!definition || !definition.circuit) return { ok: false, reason: '定义数据不完整，无法查看现场' };
  const highlight = getOscillationHighlight(state, evaluation, definitions);
  if (!highlight || !highlight.componentIds.includes(instanceId)) {
    return { ok: false, reason: '该实例不是当前振荡现场中的元件' };
  }
  const failure = evaluation.failure;
  const innerFailure = failure && failure.kind === 'runtime' && failure.status === 'oscillating' &&
    Array.isArray(failure.path) && failure.path[0] === instanceId;
  const committed = evaluation.internal && evaluation.internal[instanceId];
  if (innerFailure) {
    for (const port of inputPorts(definition)) {
      if (!Object.prototype.hasOwnProperty.call(evaluation.pinValue || {}, instanceId + ':' + port.id)) {
        return { ok: false, reason: '现场缺少实例输入，无法可靠重现振荡' };
      }
    }
    const externalInputs = externalInputsForInstance(evaluation, instanceId, definition);
    let scene = failure.inner;
    if (!completeEvaluation(scene)) {
      if (!committed || committed.definitionId !== instance.definitionId || !completeEvaluation(committed.evaluation)) {
        return { ok: false, reason: '旧诊断缺少内部运行状态，无法可靠重现振荡' };
      }
      scene = evaluateDynamic(definition.circuit, committed.evaluation, undefined, {
        definitions, includeBarePins: true, externalInputs,
        definitionStack: [instance.definitionId]
      });
    }
    if (!completeEvaluation(scene) || scene.status !== 'oscillating') {
      return { ok: false, reason: '未能重现原振荡现场；保留上一层现场，请勿以定义初态代替' };
    }
    return {
      ok: true, evaluation: scene, kind: 'inner-failure',
      inputs: Object.fromEntries(externalInputs.map(input => [input.portId, input.value]))
    };
  }
  if (!committed || committed.definitionId !== instance.definitionId ||
      !completeEvaluation(committed.evaluation) || committed.evaluation.status !== 'stable') {
    return { ok: false, reason: '该实例缺少已提交的内部运行现场，无法查看' };
  }
  const built = definitionBuilt(definition, definitions);
  const inputs = Object.fromEntries(inputPorts(definition).map(port =>
    [port.id, portValue(committed.evaluation, definition, port, built)]));
  return { ok: true, evaluation: committed.evaluation, inputs, kind: 'outer-feedback' };
}
