/**
 * Checking a form answer against the form's `requestedSchema`.
 *
 * Form elicitation schemas are flat (the subset MCP elicitation uses too): an
 * object whose properties are strings (minLength, maxLength, format, enum,
 * oneOf of consts), numbers or integers (minimum, maximum), booleans, or
 * arrays of enum values (minItems, maxItems), plus `required`. Keywords
 * outside that subset are ignored rather than refused.
 *
 *   const problems = validateElicitation(request.requestedSchema, content);
 *   if (problems.length) askAgain(problems);
 */

type Schema = Record<string, unknown>;

const isRecord = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The values an enum-like schema allows: `enum`, or `oneOf`/`anyOf` of `{ const }`. */
function allowedValues(schema: Schema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  const options = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (!options) return undefined;
  const consts = options.filter(isRecord).filter((o) => 'const' in o).map((o) => o.const);
  return consts.length ? consts : undefined;
}

const FORMATS: Record<string, (value: string) => boolean> = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: (v) => {
    try {
      return Boolean(new URL(v).protocol);
    } catch {
      return false;
    }
  },
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)),
};

function checkValue(name: string, schema: Schema, value: unknown): string[] {
  const problems: string[] = [];
  const allowed = allowedValues(schema);
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return [`${name} must be a string`];
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) problems.push(`${name} must be at least ${schema.minLength} characters`);
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) problems.push(`${name} must be at most ${schema.maxLength} characters`);
      const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
      if (format && !format(value)) problems.push(`${name} must be a valid ${String(schema.format)}`);
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${name} must be a number`];
      if (schema.type === 'integer' && !Number.isInteger(value)) problems.push(`${name} must be an integer`);
      if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${name} must be at least ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${name} must be at most ${schema.maximum}`);
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') return [`${name} must be true or false`];
      break;
    case 'array': {
      if (!Array.isArray(value)) return [`${name} must be a list`];
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) problems.push(`${name} needs at least ${schema.minItems} choices`);
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) problems.push(`${name} allows at most ${schema.maxItems} choices`);
      const items = isRecord(schema.items) ? allowedValues(schema.items) : undefined;
      if (items) for (const v of value) if (!items.includes(v)) problems.push(`${name}: ${JSON.stringify(v)} is not one of the choices`);
      return problems;
    }
    default:
      // A type outside the subset (or none): only an enum is checked.
      break;
  }
  if (allowed && !allowed.includes(value)) problems.push(`${name} must be one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}`);
  return problems;
}

/**
 * What is wrong with `content` as an answer to a form with this schema; empty
 * when it fits. Missing required fields, unknown fields, wrong types and
 * out-of-range values are reported. No schema (or one that is not an object
 * schema) accepts any object.
 */
export function validateElicitation(schema: unknown, content: unknown): string[] {
  if (content !== undefined && !isRecord(content)) return ['the answer must be an object'];
  const answer = content ?? {};
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const properties = schema.properties;
  const problems: string[] = [];
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [];
  for (const name of required) if (answer[name] === undefined) problems.push(`${name} is required`);
  for (const [name, value] of Object.entries(answer)) {
    const property = properties[name];
    if (!isRecord(property)) {
      problems.push(`${name} is not a field of this form`);
      continue;
    }
    if (value === undefined) continue;
    problems.push(...checkValue(name, property, value));
  }
  return problems;
}
