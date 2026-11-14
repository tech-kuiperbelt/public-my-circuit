// 职责：由拓扑推导 net（并查集）。几何重叠永不产生连接。
import { componentPins } from './geometry.js';

function createDsu(ids) {
  const parent = new Map();
  for (const id of ids) {
    parent.set(id, id);
  }

  function find(id) {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    let current = id;
    while (parent.get(current) !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  return { find, union };
}

function pinDef(component, pinId, definitions) {
  const defs = componentPins(component, definitions);
  if (!defs) {
    return null;
  }
  for (const def of defs) {
    if (def.id === pinId) {
      return def;
    }
  }
  return null;
}

function comparePin(a, b) {
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  if (a.pinId !== b.pinId) {
    return a.pinId < b.pinId ? -1 : 1;
  }
  return 0;
}

function compareString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildNets(state, options) {
  const definitions = options && options.definitions !== undefined
    ? options.definitions
    : undefined;
  const includeBarePins = Boolean(options && options.includeBarePins);
  const wireIds = Object.keys(state.wires).sort(compareString);
  const dsu = createDsu(wireIds);
  const pinsOnWire = new Map();
  for (const wireId of wireIds) {
    pinsOnWire.set(wireId, []);
  }

  for (const wireId of wireIds) {
    const wire = state.wires[wireId];
    const ends = [wire.endA, wire.endB];
    for (const end of ends) {
      if (!end) {
        continue;
      }
      if (end.kind === 'pin') {
        const component = state.components[end.componentId];
        if (!component) {
          continue;
        }
        const def = pinDef(component, end.pinId, definitions);
        if (!def) {
          continue;
        }
        pinsOnWire.get(wireId).push({
          componentId: end.componentId,
          pinId: end.pinId,
          dir: def.dir
        });
      } else if (end.kind === 'junction') {
        if (end.wireId && state.wires[end.wireId]) {
          dsu.union(wireId, end.wireId);
        }
      }
    }
  }

  const groups = new Map();
  for (const wireId of wireIds) {
    const root = dsu.find(wireId);
    if (!groups.has(root)) {
      groups.set(root, { wireIds: [], pins: [] });
    }
    const group = groups.get(root);
    group.wireIds.push(wireId);
    const pins = pinsOnWire.get(wireId);
    for (const pin of pins) {
      group.pins.push(pin);
    }
  }

  const nets = [];
  const netIdOfWire = {};
  const netIdOfPin = {};

  for (const group of groups.values()) {
    group.wireIds.sort(compareString);
    const id = group.wireIds[0];
    const seen = new Set();
    const pins = [];
    for (const pin of group.pins) {
      const key = pin.componentId + ':' + pin.pinId;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pins.push(pin);
    }
    pins.sort(comparePin);

    const driverPins = [];
    for (const pin of pins) {
      if (pin.dir === 'out') {
        driverPins.push({ componentId: pin.componentId, pinId: pin.pinId });
      }
    }

    for (const wireId of group.wireIds) {
      netIdOfWire[wireId] = id;
    }
    for (const pin of pins) {
      netIdOfPin[pin.componentId + ':' + pin.pinId] = id;
    }

    nets.push({
      id,
      wireIds: group.wireIds,
      pins,
      driverPins
    });
  }

  // 封装内部端口可能直接标注在未接线的裸 pin 上。只有调用方显式要求时
  // 才为裸 pin 建立 singleton net；Meta-only 顶层行为保持原样。
  if (includeBarePins) {
    const wireIdSet = new Set(wireIds);
    const netIdSet = new Set(nets.map(function (net) { return net.id; }));
    const componentIds = Object.keys(state.components).sort(compareString);
    for (const componentId of componentIds) {
      const component = state.components[componentId];
      const defs = componentPins(component, definitions);
      if (!defs) {
        continue;
      }
      for (const def of defs) {
        const key = componentId + ':' + def.id;
        if (Object.prototype.hasOwnProperty.call(netIdOfPin, key)) {
          continue;
        }
        let id = 'pin:' + key;
        while (wireIdSet.has(id) || netIdSet.has(id)) {
          id = '@' + id;
        }
        netIdSet.add(id);
        const pin = { componentId, pinId: def.id, dir: def.dir };
        nets.push({
          id,
          wireIds: [],
          pins: [pin],
          driverPins: def.dir === 'out' ? [{ componentId, pinId: def.id }] : []
        });
        netIdOfPin[key] = id;
      }
    }
  }

  nets.sort(function (a, b) {
    return compareString(a.id, b.id);
  });

  return { nets, netIdOfWire, netIdOfPin };
}
