// 封装端口与定义的只读解析工具。只依赖逻辑拓扑，不依赖 Canvas/DOM/UI。
import { componentPins } from './geometry.js';
import { buildNets } from './nets.js';

function bit(value) {
  return value === 1 ? 1 : 0;
}

export { definitionMap, getDefinition } from './definition-source.js';
export function portsOf(definition) {
  return definition && Array.isArray(definition.ports) ? definition.ports : [];
}

export function inputPorts(definition) {
  return portsOf(definition).filter(function (port) {
    return port.direction === 'in';
  });
}

export function outputPorts(definition) {
  return portsOf(definition).filter(function (port) {
    return port.direction === 'out';
  });
}

export function portById(definition, id) {
  for (const port of portsOf(definition)) {
    if (port.id === id) {
      return port;
    }
  }
  return null;
}

export function instancePins(component, definitions) {
  return componentPins(component, definitions);
}

export function bindingKey(binding) {
  if (!binding || typeof binding !== 'object') {
    return null;
  }
  if (binding.kind === 'pin') {
    return 'pin:' + binding.componentId + ':' + binding.pinId;
  }
  if (binding.kind === 'wire') {
    return 'wire:' + binding.wireId;
  }
  return null;
}

export function bindingNetId(built, binding) {
  if (!built || !binding) {
    return undefined;
  }
  if (binding.kind === 'pin') {
    return built.netIdOfPin[binding.componentId + ':' + binding.pinId];
  }
  if (binding.kind === 'wire') {
    return built.netIdOfWire[binding.wireId];
  }
  return undefined;
}

export function bindingValue(evaluation, built, binding) {
  if (!binding) {
    return 0;
  }
  if (binding.kind === 'pin') {
    const key = binding.componentId + ':' + binding.pinId;
    if (evaluation && evaluation.pinValue &&
        Object.prototype.hasOwnProperty.call(evaluation.pinValue, key)) {
      return bit(evaluation.pinValue[key]);
    }
  }
  const netId = bindingNetId(built, binding);
  if (netId !== undefined && evaluation && evaluation.netValue &&
      Object.prototype.hasOwnProperty.call(evaluation.netValue, netId)) {
    return bit(evaluation.netValue[netId]);
  }
  return 0;
}

export function portValue(evaluation, definition, port, built) {
  return bindingValue(evaluation, built, port && port.binding);
}

export function outputValues(evaluation, definition, built) {
  const values = {};
  for (const port of outputPorts(definition)) {
    values[port.id] = portValue(evaluation, definition, port, built);
  }
  return values;
}

export function zeroExternalInputs(definition) {
  return inputPorts(definition).map(function (port) {
    return { portId: port.id, binding: port.binding, value: 0 };
  });
}

// 外层实例的输入值来自实例 pinValue；返回给内部求值器的边界驱动描述。
export function externalInputsForInstance(evaluation, instanceId, definition) {
  return inputPorts(definition).map(function (port) {
    const key = instanceId + ':' + port.id;
    const value = evaluation && evaluation.pinValue &&
      Object.prototype.hasOwnProperty.call(evaluation.pinValue, key)
      ? bit(evaluation.pinValue[key])
      : 0;
    return { portId: port.id, binding: port.binding, value };
  });
}

const builtCache = new WeakMap();

// 定义内部拓扑在引用期间不可变，可缓存 buildNets 结果。缓存只包含拓扑，
// 不包含任何实例运行状态。
export function definitionBuilt(definition, definitions) {
  let built = builtCache.get(definition);
  if (!built) {
    built = buildNets(definition.circuit, { definitions, includeBarePins: true });
    builtCache.set(definition, built);
  }
  return built;
}
