// L3 元件库应用层：定义保存前的业务校验与引用检查。
// 持久化原子性由 session-store 的 IndexedDB 事务保证；本模块只做纯计算。
import {
  validateDefinitionLibrary,
  validateDefinitionSave
} from '../core/definition.js';

export function emptyLibrary() {
  return { definitions: {} };
}

export function definitionsOf(library) {
  return library && library.definitions && typeof library.definitions === 'object'
    ? library.definitions
    : {};
}

// 单一遍历入口，保留定义与实例的原始枚举顺序。
function visitReferences(library, sessionState, visit) {
  function componentsIn(components, source) {
    for (const [componentId, component] of Object.entries(components || {})) {
      if (component && component.type === 'CUSTOM') {
        visit(component.definitionId, Object.assign({}, source, { componentId }));
      }
    }
  }
  for (const [definitionId, definition] of Object.entries(definitionsOf(library))) {
    componentsIn(definition && definition.circuit && definition.circuit.components,
      { kind: 'definition', definitionId });
  }
  componentsIn(sessionState && sessionState.components, { kind: 'session' });
}

export function definitionReferences(library, sessionState, definitionId) {
  const references = [];
  visitReferences(library, sessionState, function (targetId, reference) {
    if (targetId === definitionId &&
        !(reference.kind === 'definition' && reference.definitionId === definitionId)) {
      references.push(reference);
    }
  });
  return references;
}

function referenceName(definitions, definitionId) {
  const definition = definitions[definitionId];
  return definition && definition.name ? definition.name : definitionId;
}

// 反向引用树：根为当前定义，子节点是直接引用它的封装定义或主图纸；
// 封装定义节点可继续展开，直到主图纸或没有上层引用。按路径去重，避免损坏库造成死循环。
export function definitionReferenceTree(library, sessionState, definitionId) {
  const definitions = definitionsOf(library);
  const reverse = new Map();

  function add(targetId, reference) {
    if (!targetId) return;
    let entry = reverse.get(targetId);
    if (!entry) {
      entry = { definitions: [], session: [] };
      reverse.set(targetId, entry);
    }
    if (reference.kind === 'session') {
      entry.session.push(reference);
    } else {
      entry.definitions.push(reference);
    }
  }

  visitReferences(library, sessionState, function (targetId, reference) {
    if (typeof targetId === 'string' && targetId) add(targetId, reference);
  });

  function childrenOf(id, ancestors) {
    const entry = reverse.get(id);
    if (!entry) return [];
    const groups = new Map();
    for (const reference of entry.definitions) {
      if (ancestors.has(reference.definitionId)) continue;
      let group = groups.get(reference.definitionId);
      if (!group) {
        group = { definitionId: reference.definitionId, count: 0 };
        groups.set(reference.definitionId, group);
      }
      group.count += 1;
    }
    const children = Array.from(groups.values())
      .sort(function (a, b) {
        const nameA = referenceName(definitions, a.definitionId);
        const nameB = referenceName(definitions, b.definitionId);
        return nameA.localeCompare(nameB) || a.definitionId.localeCompare(b.definitionId);
      })
      .map(function (group) {
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(group.definitionId);
        return {
          kind: 'definition',
          definitionId: group.definitionId,
          name: referenceName(definitions, group.definitionId),
          count: group.count,
          references: childrenOf(group.definitionId, nextAncestors)
        };
      });
    if (entry.session.length > 0) {
      children.push({
        kind: 'session',
        name: '主图纸',
        count: entry.session.length,
        references: []
      });
    }
    return children;
  }

  return {
    kind: 'current',
    definitionId,
    name: referenceName(definitions, definitionId),
    references: childrenOf(definitionId, new Set([definitionId]))
  };
}

export function definitionEditEligibility(library, sessionState, definitionId, canEdit) {
  const definitions = definitionsOf(library);
  const definition = definitions[definitionId];
  if (!definition) {
    return { allowed: false, reason: '定义不存在', references: [] };
  }
  const references = definitionReferences(library, sessionState, definitionId);
  if (references.length > 0) {
    const sources = references.map(function (reference) {
      if (reference.kind === 'session') {
        return '主图纸';
      }
      const source = definitions[reference.definitionId];
      const sourceName = source && source.name ? source.name : reference.definitionId;
      return sourceName;
    });
    return {
      allowed: false,
      reason: '正被引用：' + Array.from(new Set(sources)).join('、'),
      references
    };
  }
  if (!canEdit) {
    return { allowed: false, reason: '当前页面没有编辑权', references: [] };
  }
  return { allowed: true, reason: null, references: [] };
}

export function validateLibraryRecord(record, limits) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'INVALID_LIBRARY' };
  }
  if (!record.definitions || typeof record.definitions !== 'object' || Array.isArray(record.definitions)) {
    return { ok: false, reason: 'INVALID_LIBRARY', detail: 'definitions' };
  }
  return validateDefinitionLibrary({ definitions: record.definitions }, limits);
}

export function validateNewDefinition(candidate, library, limits) {
  const id = candidate && candidate.id;
  if (id && definitionsOf(library)[id]) {
    return { ok: false, status: 'unsat', reason: 'DUPLICATE_ID', detail: id };
  }
  return validateDefinitionSave(candidate, library, limits);
}

export function validateUpdatedDefinition(candidate, library, limits) {
  const current = definitionsOf(library)[candidate && candidate.id];
  if (!current) {
    return { ok: false, status: 'unsat', reason: 'NOT_FOUND', detail: candidate && candidate.id };
  }
  return validateDefinitionSave(candidate, library, limits);
}

// 保存前的昂贵语义校验；事务内仍须基于最新记录复核冲突。
export function precheckLibraryMutation(kind, payload, library, sessionState, limits) {
  let checked;
  if (kind === 'create') {
    checked = validateNewDefinition(payload, library, limits);
  } else if (kind === 'update' || kind === 'delete') {
    const id = kind === 'update' ? payload && payload.id : payload;
    if ((kind === 'update' && !id) || !definitionsOf(library)[id]) return { ok: false, reason: 'NOT_FOUND' };
    const state = typeof sessionState === 'function' ? sessionState() : sessionState;
    const references = definitionReferences(library, state, id);
    if (references.length) return { ok: false, reason: 'REFERENCED', references };
    checked = kind === 'update'
      ? validateUpdatedDefinition(payload, library, limits)
      : { ok: true };
  } else {
    return { ok: false, reason: 'INVALID_OPERATION' };
  }
  if (!checked.ok) {
    return { ok: false, status: checked.status, reason: checked.reason,
      detail: checked.detail, validation: checked };
  }
  return { ok: true };
}

// 必须在 IndexedDB 事务内执行：不读取 UI 状态、不进行异步校验。
export function applyLibraryMutation(kind, payload, library, sessionState) {
  const current = definitionsOf(library);
  if (!['create', 'update', 'delete'].includes(kind)) return { ok: false, reason: 'INVALID_OPERATION' };
  const id = kind === 'delete' ? payload : payload.id;
  if (kind === 'create') {
    if (current[id]) return { ok: false, reason: 'DUPLICATE_ID' };
  } else {
    if (!current[id]) return { ok: false, reason: 'NOT_FOUND' };
    const references = definitionReferences(library, sessionState, id);
    if (references.length) return { ok: false, reason: 'REFERENCED', references };
  }
  if (kind !== 'delete') {
    const nameTaken = Object.values(current).some(function (definition) {
      return (kind === 'create' || definition.id !== id) && definition.name === payload.name;
    });
    if (nameTaken) return { ok: false, reason: 'DUPLICATE_NAME' };
    return { ok: true, definitions: Object.assign({}, current, { [id]: payload }) };
  }
  const next = Object.assign({}, current);
  delete next[id];
  return { ok: true, definitions: next };
}
