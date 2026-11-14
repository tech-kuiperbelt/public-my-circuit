// 主图纸 / 自定义元件文件导入导出的纯数据层。
// 本模块不依赖 DOM、Canvas、Session 或元件箱；主图纸求值仍复用 L2 evaluateDynamic。
import { CELL, boundsOverlap, componentBounds } from './geometry.js';
import { evaluateDynamic } from './dynamic.js';
import { validateDefinitionSave } from './definition.js';
import { validateSnapshot } from './snapshot.js';
import { previewCopySelection } from './commands.js';
import { copyAnchorAt, copyGrid, copySourceOrigin } from './copy-layout.js';

export const BUNDLE_FORMAT = 'my-circuit.bundle';
export const BUNDLE_VERSION = 1;
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PLACEMENT_GAP = CELL * 2;
const PLACEMENT_TRIES = 8;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && !RESERVED_KEYS.has(value);
}

function fail(reason, detail, extra) {
  return Object.assign({ ok: false, reason, detail }, extra || {});
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = stableValue(value[key]);
    }
    return result;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function circuitStructure(circuit) {
  if (!isObject(circuit)) {
    return circuit;
  }
  // nextId 是编辑历史产物，不属于可观察逻辑结构；相同逻辑定义不应因此冲突。
  return {
    components: circuit.components,
    wires: circuit.wires,
    frames: circuit.frames
  };
}

function definitionStructure(definition) {
  return {
    id: definition && definition.id,
    name: definition && definition.name,
    circuit: circuitStructure(definition && definition.circuit),
    ports: definition && definition.ports,
    size: definition && (definition.size || { rows: 1, cols: 1 })
  };
}

export function definitionSemanticEqual(left, right) {
  if (!isObject(left) || !isObject(right)) {
    return false;
  }
  return stableStringify(definitionStructure(left)) === stableStringify(definitionStructure(right));
}

export function definitionDependencies(definition) {
  const ids = new Set();
  const components = definition && definition.circuit && definition.circuit.components;
  if (!isObject(components)) {
    return [];
  }
  for (const component of Object.values(components)) {
    if (component && component.type === 'CUSTOM' && isId(component.definitionId)) {
      ids.add(component.definitionId);
    }
  }
  return Array.from(ids).sort();
}

function componentsOf(state) {
  return state && isObject(state.components) ? state.components : {};
}

function wiresOf(state) {
  return state && isObject(state.wires) ? state.wires : {};
}

function framesOf(state) {
  return state && isObject(state.frames) ? state.frames : {};
}

function stateHasContent(state) {
  return Object.keys(componentsOf(state)).length > 0 ||
    Object.keys(wiresOf(state)).length > 0 ||
    Object.keys(framesOf(state)).length > 0;
}

export function countState(state) {
  return {
    components: Object.keys(componentsOf(state)).length,
    wires: Object.keys(wiresOf(state)).length,
    frames: Object.keys(framesOf(state)).length
  };
}

export function collectDefinitionClosure(state, definitions) {
  const source = definitions && definitions.definitions ? definitions.definitions : (definitions || {});
  const used = new Set();
  const stack = [];

  for (const component of Object.values(componentsOf(state))) {
    if (component && component.type === 'CUSTOM') {
      stack.push({ id: component.definitionId, referrer: null });
    }
  }

  while (stack.length > 0) {
    const item = stack.pop();
    const id = item && item.id;
    if (!isId(id)) {
      return fail('MISSING_DEFINITION', 'invalid-definition-id', { referrer: item && item.referrer });
    }
    if (used.has(id)) {
      continue;
    }
    const definition = source[id];
    if (!definition) {
      return fail('MISSING_DEFINITION', id, { referrer: item.referrer });
    }
    used.add(id);
    for (const dependency of definitionDependencies(definition)) {
      stack.push({ id: dependency, referrer: { kind: 'definition', id, name: definition.name || id } });
    }
  }

  return { ok: true, ids: Array.from(used).sort() };
}

export function buildExportBundle(options) {
  const opts = options || {};
  const library = opts.library || { definitions: {} };
  const definitions = library.definitions && typeof library.definitions === 'object'
    ? library.definitions
    : {};
  const includeDrawing = Boolean(opts.includeDrawing);
  const includeDefinitions = Boolean(opts.includeDefinitions);
  if (!includeDrawing && !includeDefinitions) {
    return fail('NOTHING_SELECTED');
  }
  if (includeDrawing && (!isObject(opts.state) ||
      !isObject(opts.state.components) || !isObject(opts.state.wires) || !isObject(opts.state.frames))) {
    return fail('INVALID_DRAWING', 'state');
  }

  let selectedIds = [];
  if (includeDrawing) {
    const closure = collectDefinitionClosure(opts.state, { definitions });
    if (!closure.ok) {
      return closure;
    }
    selectedIds = closure.ids;
  }
  if (includeDefinitions) {
    selectedIds = Object.keys(definitions);
  }

  const exportedDefinitions = {};
  for (const id of selectedIds) {
    const definition = definitions[id];
    if (!definition) {
      return fail('MISSING_DEFINITION', id);
    }
    exportedDefinitions[id] = cloneValue(definition);
  }

  const now = typeof opts.now === 'function' ? opts.now() : (opts.now || new Date().toISOString());
  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: now,
    includes: {
      drawing: includeDrawing,
      definitions: includeDefinitions ? 'all' : (includeDrawing ? 'used' : null)
    },
    drawing: includeDrawing ? { state: cloneValue(opts.state) } : null,
    definitions: exportedDefinitions
  };
  if (isObject(opts.schema)) {
    bundle.schema = {
      session: opts.schema.session,
      library: opts.schema.library
    };
  }
  return { ok: true, bundle };
}

function inspectDrawing(drawing) {
  if (drawing === null || drawing === undefined) {
    return { ok: true, present: false };
  }
  if (!isObject(drawing) || !isObject(drawing.state)) {
    return fail('INVALID_DRAWING', 'drawing.state');
  }
  const state = drawing.state;
  if (!isObject(state.components) || !isObject(state.wires) || !isObject(state.frames)) {
    return fail('INVALID_DRAWING', 'collections');
  }
  if (!Number.isSafeInteger(state.nextId) || state.nextId < 1) {
    return fail('INVALID_DRAWING', 'nextId');
  }
  return { ok: true, present: true };
}

function inspectDefinitions(definitions) {
  if (definitions === null || definitions === undefined) {
    return { ok: true, present: false, definitions: {} };
  }
  if (!isObject(definitions)) {
    return fail('INVALID_DEFINITIONS', 'definitions');
  }
  const names = new Set();
  for (const [id, definition] of Object.entries(definitions)) {
    if (!isId(id)) {
      return fail('INVALID_DEFINITIONS', id);
    }
    if (!isObject(definition) || definition.id !== id) {
      return fail('INVALID_DEFINITIONS', id + '.id');
    }
    if (typeof definition.name !== 'string' || definition.name.length === 0) {
      return fail('INVALID_DEFINITIONS', id + '.name');
    }
    if (names.has(definition.name)) {
      return fail('INVALID_DEFINITIONS', 'duplicate-name:' + definition.name);
    }
    names.add(definition.name);
  }
  return { ok: true, present: true, definitions };
}

export function inspectBundle(value) {
  if (!isObject(value)) {
    return fail('INVALID_BUNDLE', 'root');
  }
  if (value.format !== BUNDLE_FORMAT) {
    return fail('INVALID_FORMAT', value.format);
  }
  if (value.version !== BUNDLE_VERSION) {
    return fail('UNSUPPORTED_VERSION', value.version);
  }
  const drawing = inspectDrawing(value.drawing);
  if (!drawing.ok) {
    return drawing;
  }
  const definitions = inspectDefinitions(value.definitions);
  if (!definitions.ok) {
    return definitions;
  }
  return {
    ok: true,
    bundle: {
      format: value.format,
      version: value.version,
      exportedAt: value.exportedAt,
      schema: value.schema,
      includes: value.includes || {},
      drawing: value.drawing === undefined ? null : value.drawing,
      definitions: definitions.definitions
    },
    hasDrawing: drawing.present,
    hasDefinitions: definitions.present && Object.keys(definitions.definitions).length > 0
  };
}

export function parseBundle(text) {
  if (typeof text !== 'string') {
    return inspectBundle(text);
  }
  let parsed;
  try {
    const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    parsed = JSON.parse(source);
  } catch (error) {
    return fail('INVALID_JSON', String(error && error.message || error));
  }
  return inspectBundle(parsed);
}

function emptySelection() {
  return { drawing: false, definitions: false };
}

function normalizeSelection(selection) {
  const input = selection || emptySelection();
  return {
    drawing: input.drawing === true,
    definitions: input.definitions === true
  };
}

function targetDefinitions(library) {
  return library && isObject(library.definitions) ? library.definitions : {};
}

function statusFor(bundleDefinitions, targetDefs, nameToId, id) {
  const definition = bundleDefinitions[id];
  const existing = targetDefs[id];
  if (existing) {
    return {
      status: definitionSemanticEqual(existing, definition) ? 'identical' : 'conflict',
      reason: 'ID',
      existingId: id
    };
  }
  if (definition && nameToId.has(definition.name)) {
    return {
      status: 'conflict',
      reason: 'NAME',
      existingId: nameToId.get(definition.name)
    };
  }
  return { status: 'new' };
}

function referrerText(referrer) {
  if (!referrer) {
    return '导入内容';
  }
  if (referrer.kind === 'drawing') {
    return '主图纸';
  }
  if (referrer.kind === 'definition') {
    return '定义「' + (referrer.name || referrer.id || '?') + '」';
  }
  return '导入内容';
}

function conflictError(id, definition, referrer, status) {
  return fail('CONFLICT_REQUIRED', {
    id,
    name: definition && definition.name || id,
    existingId: status && status.existingId || id,
    reason: status && status.reason || 'ID'
  }, { conflict: {
    id,
    name: definition && definition.name || id,
    existingId: status && status.existingId || id,
    conflictKind: status && status.reason || 'ID'
  }, referrer });
}

function missingError(id, referrer) {
  return fail('MISSING_DEFINITION', id, { referrer });
}

function pairwiseOverlap(state, definitions) {
  const entries = Object.entries(componentsOf(state));
  const bounds = entries.map(function (entry) {
    return { id: entry[0], bounds: componentBounds(entry[1], definitions) };
  });
  for (let i = 0; i < bounds.length; i += 1) {
    for (let j = i + 1; j < bounds.length; j += 1) {
      if (boundsOverlap(bounds[i].bounds, bounds[j].bounds)) {
        return { ok: false, first: bounds[i].id, second: bounds[j].id };
      }
    }
  }
  return { ok: true };
}

function extentsOfState(state, definitions) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  function add(rect) {
    if (!rect) return;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  for (const component of Object.values(componentsOf(state))) {
    add(componentBounds(component, definitions));
  }
  for (const wire of Object.values(wiresOf(state))) {
    for (const point of wire.points || []) {
      add({ x: point.x, y: point.y, w: 0, h: 0 });
    }
  }
  for (const frame of Object.values(framesOf(state))) {
    add({ x: frame.x, y: frame.y, w: frame.w, h: frame.h });
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

function extentsOfSnapshot(snapshot, definitions) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  function addRect(rect) {
    if (!rect) return;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  for (const component of snapshot.components || []) {
    addRect(componentBounds(component, definitions));
  }
  for (const wire of snapshot.wires || []) {
    for (const point of wire.points || []) {
      addRect({ x: point.x, y: point.y, w: 0, h: 0 });
    }
  }
  for (const frame of snapshot.frames || []) {
    addRect({ x: frame.x, y: frame.y, w: frame.w, h: frame.h });
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

function snapshotFromState(state) {
  return {
    components: Object.values(componentsOf(state)),
    wires: Object.values(wiresOf(state)),
    frames: Object.values(framesOf(state))
  };
}

function planDrawingPlacement(options) {
  const currentState = options.currentState;
  const importedSnapshot = options.importedSnapshot;
  const definitions = options.definitions;
  const limits = options.limits;
  const importedExtents = extentsOfSnapshot(importedSnapshot, definitions);
  if (!importedExtents) {
    return { ok: true, empty: true };
  }

  const currentExtents = extentsOfState(currentState, definitions);
  const anchors = [];
  if (!currentExtents) {
    const origin = copySourceOrigin(importedSnapshot);
    if (!origin) {
      return { ok: true, empty: true };
    }
    anchors.push(copyAnchorAt(importedSnapshot, origin));
  } else {
    const grid = copyGrid(importedSnapshot);
    const baseX = Math.ceil((currentExtents.maxX + PLACEMENT_GAP) / grid) * grid;
    const baseY = Math.floor(currentExtents.minY / grid) * grid;
    const width = Math.max(grid, Math.ceil((importedExtents.maxX - importedExtents.minX) / grid) * grid);
    const height = Math.max(grid, Math.ceil((importedExtents.maxY - importedExtents.minY) / grid) * grid);
    const stepX = width + PLACEMENT_GAP;
    const stepY = height + PLACEMENT_GAP;
    for (let row = 0; row < PLACEMENT_TRIES; row += 1) {
      for (let column = 0; column < PLACEMENT_TRIES; column += 1) {
        anchors.push(copyAnchorAt(importedSnapshot, {
          x: baseX + column * stepX,
          y: baseY + row * stepY
        }));
      }
    }
  }

  for (const anchor of anchors) {
    const preview = previewCopySelection(currentState, importedSnapshot, anchor.cx, anchor.cy, {
      definitions
    });
    if (!preview.ok) {
      continue;
    }
    let evaluation;
    try {
      evaluation = evaluateDynamic(preview.state, options.currentEvaluation, limits, { definitions });
    } catch (error) {
      continue;
    }
    if (!evaluation || evaluation.ok !== true) {
      continue;
    }
    const checked = validateSnapshot({ state: preview.state, evaluation }, { definitions });
    if (!checked.ok) {
      continue;
    }
    const bounds = extentsOfSnapshot({
      components: preview.components || [],
      wires: (preview.wires || []).map(function (points) { return { points }; }),
      frames: preview.frames || []
    }, definitions);
    return {
      ok: true,
      state: preview.state,
      evaluation,
      bounds,
      anchor
    };
  }
  return fail('NO_FREE_AREA');
}

function validateDefinitionsInOrder(options) {
  const bundleDefinitions = options.bundleDefinitions;
  const targetDefs = options.targetDefs;
  const toAdd = options.toAdd;
  const statusById = options.statusById;
  const validated = Object.assign({}, targetDefs);
  const visiting = new Set();
  const visited = new Set();

  function conflictFor(id, referrer) {
    return conflictError(id, bundleDefinitions[id], referrer, statusById[id]);
  }

  function validate(id) {
    if (visited.has(id)) {
      return null;
    }
    if (visiting.has(id)) {
      return fail('RECURSIVE_DEFINITION', id);
    }
    const definition = bundleDefinitions[id];
    if (!definition) {
      return missingError(id, { kind: 'definition', id });
    }
    visiting.add(id);
    for (const dependency of definitionDependencies(definition)) {
      const referrer = { kind: 'definition', id, name: definition.name || id };
      const dependencyStatus = statusById[dependency];
      if (dependencyStatus && dependencyStatus.status === 'conflict') {
        visiting.delete(id);
        return conflictFor(dependency, referrer);
      }
      if (toAdd.has(dependency)) {
        const nested = validate(dependency);
        if (nested) {
          visiting.delete(id);
          return nested;
        }
      } else if (!validated[dependency]) {
        visiting.delete(id);
        return missingError(dependency, referrer);
      }
    }

    let checked;
    try {
      checked = validateDefinitionSave(definition, { definitions: validated }, options.limits);
    } catch (error) {
      checked = { ok: false, reason: 'INVALID_DEFINITION', detail: String(error && error.message || error) };
    }
    visiting.delete(id);
    if (!checked.ok) {
      return fail('DEFINITION_INVALID', checked.reason, {
        definition: { id, name: definition.name || id },
        validation: checked
      });
    }
    validated[id] = definition;
    visited.add(id);
    return null;
  }

  for (const id of Array.from(toAdd).sort()) {
    const error = validate(id);
    if (error) {
      return error;
    }
  }
  return { ok: true, definitions: validated };
}

export function planImport(options) {
  const opts = options || {};
  const bundle = opts.bundle;
  if (!bundle || bundle.format !== BUNDLE_FORMAT || bundle.version !== BUNDLE_VERSION) {
    return fail('INVALID_BUNDLE');
  }
  const selection = normalizeSelection(opts.selection);
  if (!selection.drawing && !selection.definitions) {
    return fail('NOTHING_SELECTED');
  }
  const bundleDefinitions = isObject(bundle.definitions) ? bundle.definitions : {};
  const targetDefs = targetDefinitions(opts.library);
  const nameToId = new Map();
  for (const [id, definition] of Object.entries(targetDefs)) {
    if (definition && typeof definition.name === 'string') {
      nameToId.set(definition.name, id);
    }
  }

  const statusById = {};
  for (const id of Object.keys(bundleDefinitions)) {
    statusById[id] = statusFor(bundleDefinitions, targetDefs, nameToId, id);
  }

  const scope = new Set();
  const toAdd = new Set();
  const expanded = new Set();

  function requireDependency(id, referrer) {
    if (!isId(id)) {
      return missingError(String(id), referrer);
    }
    scope.add(id);
    const status = statusById[id];
    const target = targetDefs[id];
    if (target) {
      if (status && status.status === 'conflict') {
        return conflictError(id, bundleDefinitions[id], referrer, status);
      }
      if (status && status.status === 'new') {
        toAdd.add(id);
        return expandNew(id);
      }
      return null;
    }
    if (bundleDefinitions[id]) {
      if (status && status.status === 'conflict') {
        return conflictError(id, bundleDefinitions[id], referrer, status);
      }
      if (status && status.status === 'new') {
        toAdd.add(id);
        return expandNew(id);
      }
      return missingError(id, referrer);
    }
    return missingError(id, referrer);
  }

  function expandNew(id) {
    if (expanded.has(id)) {
      return null;
    }
    expanded.add(id);
    const definition = bundleDefinitions[id];
    for (const dependency of definitionDependencies(definition)) {
      const error = requireDependency(dependency, {
        kind: 'definition',
        id,
        name: definition && definition.name || id
      });
      if (error) {
        return error;
      }
    }
    return null;
  }

  if (selection.drawing) {
    const drawingState = bundle.drawing && bundle.drawing.state;
    for (const component of Object.values(componentsOf(drawingState))) {
      if (!component || component.type !== 'CUSTOM') {
        continue;
      }
      const id = component.definitionId;
      scope.add(id);
      const target = targetDefs[id];
      const status = statusById[id];
      if (target) {
        if (status && status.status === 'conflict') {
          return conflictError(id, bundleDefinitions[id], { kind: 'drawing' }, status);
        }
        if (status && status.status === 'new') {
          toAdd.add(id);
          const error = expandNew(id);
          if (error) return error;
        }
      } else if (bundleDefinitions[id]) {
        if (status && status.status === 'conflict') {
          return conflictError(id, bundleDefinitions[id], { kind: 'drawing' }, status);
        }
        if (status && status.status === 'new') {
          toAdd.add(id);
          const error = expandNew(id);
          if (error) return error;
        } else {
          return missingError(id, { kind: 'drawing' });
        }
      } else {
        return missingError(id, { kind: 'drawing' });
      }
    }
  }

  if (selection.definitions) {
    for (const id of Object.keys(bundleDefinitions)) {
      scope.add(id);
      if (statusById[id] && statusById[id].status === 'new') {
        toAdd.add(id);
        const error = expandNew(id);
        if (error) return error;
      }
    }
  }

  const validated = validateDefinitionsInOrder({
    bundleDefinitions,
    targetDefs,
    toAdd,
    statusById,
    limits: opts.limits
  });
  if (!validated.ok) {
    return validated;
  }
  const mergedDefinitions = validated.definitions;

  let drawingPlan = null;
  let drawingEmpty = false;
  let focusBounds = null;
  if (selection.drawing) {
    const rawState = bundle.drawing && bundle.drawing.state;
    if (!rawState) {
      drawingEmpty = true;
    } else {
      let importedEvaluation;
      try {
        importedEvaluation = evaluateDynamic(rawState, undefined, opts.limits, {
          definitions: mergedDefinitions
        });
      } catch (error) {
        return fail('DRAWING_INVALID', String(error && error.message || error));
      }
      if (!importedEvaluation || importedEvaluation.ok !== true) {
        return fail('DRAWING_INVALID', importedEvaluation && importedEvaluation.reason || 'evaluation');
      }
      const checked = validateSnapshot({ state: rawState, evaluation: importedEvaluation }, {
        definitions: mergedDefinitions
      });
      if (!checked.ok) {
        return fail('DRAWING_INVALID', checked.reason + (checked.detail ? ':' + checked.detail : ''));
      }
      const overlap = pairwiseOverlap(rawState, mergedDefinitions);
      if (!overlap.ok) {
        return fail('DRAWING_COMPONENTS_OVERLAP', overlap.first + '/' + overlap.second);
      }
      if (!stateHasContent(rawState)) {
        drawingEmpty = true;
      } else {
        const snapshot = snapshotFromState(rawState);
        const placement = planDrawingPlacement({
          currentState: opts.state,
          currentEvaluation: opts.evaluation,
          importedSnapshot: snapshot,
          definitions: mergedDefinitions,
          limits: opts.limits
        });
        if (!placement.ok) {
          return placement;
        }
        if (!placement.empty) {
          drawingPlan = {
            state: placement.state,
            evaluation: placement.evaluation,
            view: cloneValue(opts.view || { scale: 2, pan: { x: 0, y: 0 } }),
            bounds: placement.bounds,
            anchor: placement.anchor
          };
          focusBounds = placement.bounds;
        } else {
          drawingEmpty = true;
        }
      }
    }
  }

  const addedDefinitionIds = Array.from(toAdd).sort();
  const skippedDefinitions = Array.from(scope)
    .filter(function (id) {
      return statusById[id] && statusById[id].status === 'conflict';
    })
    .sort()
    .map(function (id) {
      return {
        id,
        name: bundleDefinitions[id] && bundleDefinitions[id].name || id,
        existingId: statusById[id].existingId || id,
        reason: 'CONFLICT_UNUSED'
      };
    });
  const identicalDefinitionIds = Array.from(scope)
    .filter(function (id) {
      return statusById[id] && statusById[id].status === 'identical';
    })
    .sort();

  return {
    ok: true,
    plan: {
      definitions: addedDefinitionIds.length > 0 ? mergedDefinitions : null,
      addedDefinitionIds,
      skippedDefinitions,
      identicalDefinitionIds,
      drawing: drawingPlan,
      drawingEmpty,
      focusBounds,
      noop: addedDefinitionIds.length === 0 && !drawingPlan
    }
  };
}

export function describeReferrer(referrer) {
  return referrerText(referrer);
}
