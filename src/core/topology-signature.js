// Logical endpoint identity shared by runtime history and snapshot validation.
// Preserve wire order and encoding: persisted inputConnections use this string.
export function netConnectionSignature(state, net) {
  return JSON.stringify(net.wireIds.map(function (id) {
    const wire = state.wires[id];
    function end(value) {
      if (!value) return null;
      if (value.kind === 'pin') return [value.kind, value.componentId, value.pinId];
      if (value.kind === 'junction') return [value.kind, value.wireId];
      return [value.kind];
    }
    return [id, end(wire.endA), end(wire.endB)];
  }));
}
