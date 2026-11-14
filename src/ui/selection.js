// 职责：选择上下文的能力判断（右键菜单等 UI 共用），纯函数。
// 复制：元件、导线、分组框单选/多选均可；纯导线复制时端点由复制命令脱开为 free。
export function canCopySelection(state, selection) {
  if (!selection) {
    return false;
  }
  if (selection.kind === 'component') {
    return Boolean(state.components[selection.id]);
  }
  if (selection.kind === 'wire') {
    return Boolean(state.wires && state.wires[selection.id]);
  }
  if (selection.kind === 'frame') {
    return Boolean(state.frames && state.frames[selection.id]);
  }
  if (selection.kind === 'multi') {
    const components = Array.isArray(selection.components) ? selection.components : [];
    const wires = Array.isArray(selection.wires) ? selection.wires : [];
    const frames = Array.isArray(selection.frames) ? selection.frames : [];
    if (components.length > 0) {
      return components.every(function (id) {
        return Boolean(state.components[id]);
      }) && frames.every(function (id) {
        return Boolean(state.frames && state.frames[id]);
      });
    }
    if (wires.length === 0 && frames.length === 0) {
      return false;
    }
    return wires.every(function (id) {
      return Boolean(state.wires && state.wires[id]);
    }) && frames.every(function (id) {
      return Boolean(state.frames && state.frames[id]);
    });
  }
  return false;
}

// 自动布线：选择里至少有一根导线，且导线仍然存在。
// 允许与元件/分组框混合多选，命令只重排导线几何，不改变其它对象。
export function canAutoRouteSelection(state, selection) {
  if (!state || !selection) {
    return false;
  }
  const wires = selectionObjects(selection).wires;
  if (wires.length === 0) {
    return false;
  }
  return wires.every(function (id) {
    return Boolean(state.wires && state.wires[id]);
  });
}

const ROTATABLE_TYPES = new Set(['CONST1', 'TOGGLE', 'BUTTON', 'CLOCK', 'NOT', 'DELAY', 'AND', 'OR', 'LAMP', 'CUSTOM']);

// 线不是元件实例；除线外所有元件都支持旋转（含已接线，旋转时导线端点先脱开再按重合自动接管）。
// 整体旋转仍要求选择里不含导线/分组框。
export function canRotateSelection(state, selection) {
  if (!selection) {
    return false;
  }
  if (selection.kind === 'component') {
    const component = state.components[selection.id];
    return Boolean(component) && ROTATABLE_TYPES.has(component.type);
  }
  if (selection.kind === 'multi') {
    if (!Array.isArray(selection.components) || selection.components.length === 0) {
      return false;
    }
    if (Array.isArray(selection.wires) && selection.wires.length > 0) {
      return false;
    }
    if (Array.isArray(selection.frames) && selection.frames.length > 0) {
      return false;
    }
    for (const id of selection.components) {
      const component = state.components[id];
      if (!component || !ROTATABLE_TYPES.has(component.type)) {
        return false;
      }
    }
    return true;
  }
  return false;
}


// 图纸右键「详细」：只对单个 CUSTOM 元件返回 definitionId。
// 多选、Meta 元件、缺失组件均返回 null，避免菜单指向不明确。
export function selectionCustomDefinitionId(state, selection) {
  if (!state || !selection || selection.kind !== 'component' || !selection.id) {
    return null;
  }
  const component = state.components[selection.id];
  if (!component || component.type !== 'CUSTOM' || typeof component.definitionId !== 'string' ||
      !component.definitionId) {
    return null;
  }
  return component.definitionId;
}

// 把单选/多选统一拆成元件与导线 id 列表。
export function selectionObjects(selection) {
  if (!selection) {
    return { components: [], wires: [], frames: [] };
  }
  if (selection.kind === 'component') {
    return { components: selection.id ? [selection.id] : [], wires: [], frames: [] };
  }
  if (selection.kind === 'wire') {
    return { components: [], wires: selection.id ? [selection.id] : [], frames: [] };
  }
  if (selection.kind === 'frame') {
    return { components: [], wires: [], frames: selection.id ? [selection.id] : [] };
  }
  if (selection.kind === 'multi') {
    return {
      components: Array.isArray(selection.components) ? selection.components.slice() : [],
      wires: Array.isArray(selection.wires) ? selection.wires.slice() : [],
      frames: Array.isArray(selection.frames) ? selection.frames.slice() : []
    };
  }
  return { components: [], wires: [], frames: [] };
}

// 由元件/导线/分组框 id 列表生成最简选择表示（0=空，1=单选，>1=multi）。
export function selectionFromObjects(components, wires, frames) {
  const componentIds = Array.isArray(components) ? components.slice() : [];
  const wireIds = Array.isArray(wires) ? wires.slice() : [];
  const frameIds = Array.isArray(frames) ? frames.slice() : [];
  const total = componentIds.length + wireIds.length + frameIds.length;
  if (total === 0) {
    return { kind: null, id: null };
  }
  if (total === 1) {
    if (componentIds.length === 1) {
      return { kind: 'component', id: componentIds[0] };
    }
    if (wireIds.length === 1) {
      return { kind: 'wire', id: wireIds[0] };
    }
    return { kind: 'frame', id: frameIds[0] };
  }
  return {
    kind: 'multi',
    components: componentIds,
    wires: wireIds,
    frames: frameIds
  };
}

// Ctrl+单击：对象在选中集合内则移除，否则加入。
export function toggleSelectionObject(selection, target) {
  const objects = selectionObjects(selection);
  if (!target) {
    return selectionFromObjects(objects.components, objects.wires, objects.frames);
  }
  if (target.kind === 'component') {
    const index = objects.components.indexOf(target.id);
    if (index === -1) {
      objects.components.push(target.id);
    } else {
      objects.components.splice(index, 1);
    }
  } else if (target.kind === 'wire') {
    const index = objects.wires.indexOf(target.id);
    if (index === -1) {
      objects.wires.push(target.id);
    } else {
      objects.wires.splice(index, 1);
    }
  } else if (target.kind === 'frame') {
    const index = objects.frames.indexOf(target.id);
    if (index === -1) {
      objects.frames.push(target.id);
    } else {
      objects.frames.splice(index, 1);
    }
  }
  return selectionFromObjects(objects.components, objects.wires, objects.frames);
}

// Ctrl+框选：把框中的对象并入原选择。
export function unionSelection(base, components, wires, frames) {
  const objects = selectionObjects(base);
  const componentSet = new Set(objects.components.concat(components || []));
  const wireSet = new Set(objects.wires.concat(wires || []));
  const frameSet = new Set(objects.frames.concat(frames || []));
  return selectionFromObjects(
    Array.from(componentSet),
    Array.from(wireSet),
    Array.from(frameSet)
  );
}
