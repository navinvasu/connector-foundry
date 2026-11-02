// Spec-driven sample arguments (D-90). The eval harness, the smoke run and
// the agent task generator all need a realistic call for any API, so the
// values come from the spec (examples, defaults, enums, formats, bounds)
// and never from knowledge of one particular API.


export interface PropSchema {
  type?: string;
  default?: unknown;
  examples?: unknown[];
  example?: unknown;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  items?: PropSchema;
  properties?: Record<string, PropSchema>;
  required?: string[];
}

/**
 * A realistic value for one argument, taken from the spec itself: an
 * example, then the default, then the first enum member, then a value that
 * fits the declared format or bounds, then a plain value of the declared
 * type. Nothing here knows about any particular API.
 */
export function sampleValue(def: PropSchema = {}): unknown {
  if (Array.isArray(def.examples) && def.examples.length > 0) return def.examples[0];
  if (def.example !== undefined) return def.example;
  if (def.default !== undefined) return def.default;
  if (Array.isArray(def.enum) && def.enum.length > 0) return def.enum[0];
  switch (def.format) {
    case 'date': return new Date().toISOString().slice(0, 10);
    case 'date-time': return new Date().toISOString();
    case 'email': return 'user@example.com';
    case 'uuid': return '00000000-0000-4000-8000-000000000000';
    case 'uri': case 'url': return 'https://example.com';
    default: break;
  }
  const type = def.type ?? (def.properties ? 'object' : def.items ? 'array' : 'string');
  if (type === 'integer' || type === 'number') {
    if (typeof def.minimum === 'number') return def.minimum;
    if (typeof def.maximum === 'number') return Math.min(1, def.maximum);
    return 1;
  }
  if (type === 'boolean') return true;
  // An empty list is rarely a valid value (`tags=` → 400); send one item.
  if (type === 'array') return [sampleValue(def.items ?? { type: 'string' })];
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    for (const name of def.required ?? []) out[name] = sampleValue(def.properties?.[name]);
    return out;
  }
  const minLength = typeof def.minLength === 'number' ? def.minLength : 0;
  return 'test'.padEnd(minLength, 'x');
}

/**
 * Happy-path arguments: every required argument, plus any optional one the
 * spec gives an explicit example or default for (the spec author's own
 * picture of a realistic call).
 */
export function buildArgs(tool: { input_schema: unknown }): Record<string, unknown> {
  const raw = typeof tool.input_schema === 'string' ? safeJson(tool.input_schema) : tool.input_schema;
  const schema = (raw && typeof raw === 'object' ? raw : {}) as {
    properties?: Record<string, PropSchema>; required?: string[];
  };
  const args: Record<string, unknown> = {};
  for (const name of schema.required ?? []) {
    args[name] = sampleValue(schema.properties?.[name]);
  }
  for (const [name, def] of Object.entries(schema.properties ?? {})) {
    if (name in args) continue;
    const hasExample = (Array.isArray(def.examples) && def.examples.length > 0) || def.example !== undefined;
    if (hasExample) args[name] = sampleValue(def);
  }
  return args;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
