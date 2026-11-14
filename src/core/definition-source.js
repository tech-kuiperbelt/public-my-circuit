// Shared definition lookup without workspace or geometry state.
export function definitionMap(source) {
  if (!source) {
    return null;
  }
  if (source instanceof Map) {
    return source;
  }
  if (source.definitions) {
    return source.definitions;
  }
  return source;
}

export function getDefinition(source, id) {
  const definitions = definitionMap(source);
  if (!definitions || typeof id !== 'string') {
    return null;
  }
  if (definitions instanceof Map) {
    return definitions.get(id) || null;
  }
  if (typeof definitions.get === 'function') {
    return definitions.get(id) || null;
  }
  return Object.prototype.hasOwnProperty.call(definitions, id) ? definitions[id] : null;
}
