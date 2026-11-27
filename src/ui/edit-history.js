// 有界内存编辑历史；调用方负责快照校验与工作区恢复。
function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function createEditHistory(limit = 10) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('history limit must be a positive integer');
  }
  const undo = [];
  const redo = [];

  function append(stack, snapshot) {
    stack.push(snapshot);
    if (stack.length > limit) stack.shift();
  }

  return {
    record(snapshot) {
      const saved = clone(snapshot);
      append(undo, saved);
      redo.length = 0;
    },
    move(direction, current, restore) {
      if (direction !== 'undo' && direction !== 'redo') return false;
      const source = direction === 'undo' ? undo : redo;
      const destination = direction === 'undo' ? redo : undo;
      if (!source.length) return false;
      try {
        // 在恢复前完成两份深拷贝，避免恢复成功后才发现当前快照不可复制。
        const target = clone(source[source.length - 1]);
        const savedCurrent = clone(current);
        const result = restore(target);
        if (result === false || (result && result.ok === false)) return false;
        source.pop();
        append(destination, savedCurrent);
        return true;
      } catch {
        return false;
      }
    },
    canUndo() { return undo.length > 0; },
    canRedo() { return redo.length > 0; },
    clear() {
      undo.length = 0;
      redo.length = 0;
    }
  };
}

const DRAFT_FIELDS = Object.freeze([
  'state', 'evaluation', 'name', 'icon', 'rows', 'cols',
  'ports', 'inputs', 'nextPortNumber', 'portPlacementCursors'
]);

export function captureDraftHistory(draft) {
  const snapshot = {};
  for (const field of DRAFT_FIELDS) snapshot[field] = draft[field];
  return clone(snapshot);
}

export function restoreDraftHistory(draft, snapshot) {
  const restored = captureDraftHistory(snapshot);
  for (const field of DRAFT_FIELDS) draft[field] = restored[field];
}
