export function safeSerialize(val: any, depth = 3, seen = new WeakSet()): any {
  if (depth === 0) return '[Depth Limit Reached]';

  if (val === null) return null;
  if (val === undefined) return undefined;

  const t = typeof val;
  if (t === 'string' || t === 'number' || t === 'boolean') return val;
  if (t === 'function') return `[Function: ${val.name || 'anonymous'}]`;
  if (val instanceof Error) {
    return {
      name: val.name,
      message: val.message,
      stack: val.stack,
    };
  }

  // Circular reference tracking
  if (typeof val === 'object') {
    if (seen.has(val)) return '[Circular Reference]';
    seen.add(val);

    if (Array.isArray(val)) {
      return val.map(item => safeSerialize(item, depth - 1, seen));
    }

    const output: Record<string, any> = {};
    for (const k of Object.keys(val)) {
      try {
        output[k] = safeSerialize(val[k], depth - 1, seen);
      } catch {
        output[k] = '[Unserializable]';
      }
    }
    return output;
  }

  return String(val);
}
