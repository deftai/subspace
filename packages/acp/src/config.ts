/**
 * Session config options (model, reasoning effort, mode, on/off switches),
 * one shape for v1 and v2.
 *
 * v1 names an option `id`, v2 `configId`; both offer `select` options (with
 * choices, possibly grouped) and `boolean` ones. Choices are flattened here,
 * keeping the group's name. Options of a type this client does not know are
 * listed with `type` as sent and cannot be set.
 *
 *   const model = session.configOption('model');      // or by category:
 *   const effort = session.configOptions.find((o) => o.category === 'thought_level');
 *   await session.setConfigOption('model', 'opus');
 *   await session.setConfigOption('fast', true);
 */

export interface ConfigChoice {
  value: string;
  name: string;
  description?: string;
  /** The name of the group the agent put this choice in, if any. */
  group?: string;
}

export type ConfigOption = {
  id: string;
  name: string;
  description?: string;
  /** `mode`, `model`, `model_config`, `thought_level`, or the agent's own. */
  category?: string;
} & (
  | { type: 'select'; currentValue?: string; choices: ConfigChoice[] }
  | { type: 'boolean'; currentValue?: boolean }
  | { type: string; currentValue?: unknown }
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function choice(entry: Record<string, unknown>, group?: string): ConfigChoice {
  const description = text(entry.description);
  return {
    value: String(entry.value),
    name: String(entry.name ?? entry.value),
    ...(description ? { description } : {}),
    ...(group ? { group } : {}),
  };
}

function option(raw: Record<string, unknown>): ConfigOption | undefined {
  const id = text(raw.configId) ?? text(raw.id);
  if (!id) return undefined;
  const description = text(raw.description);
  const category = text(raw.category);
  const base = {
    id,
    name: text(raw.name) ?? id,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
  };
  if (raw.type === 'select') {
    const choices: ConfigChoice[] = [];
    for (const entry of Array.isArray(raw.options) ? raw.options.filter(isRecord) : []) {
      if (Array.isArray(entry.options)) {
        const group = text(entry.name) ?? text(entry.groupId) ?? text(entry.group);
        for (const c of entry.options.filter(isRecord)) choices.push(choice(c, group));
      } else choices.push(choice(entry));
    }
    return { ...base, type: 'select', ...(typeof raw.currentValue === 'string' ? { currentValue: raw.currentValue } : {}), choices };
  }
  if (raw.type === 'boolean') {
    return { ...base, type: 'boolean', ...(typeof raw.currentValue === 'boolean' ? { currentValue: raw.currentValue } : {}) };
  }
  return { ...base, type: String(raw.type), ...('currentValue' in raw ? { currentValue: raw.currentValue } : {}) };
}

/** The config options in a session/new, load, resume or set_config_option answer, or a `config_option_update`. */
export function configOptionsFrom(options: unknown): ConfigOption[] | undefined {
  if (!Array.isArray(options)) return undefined;
  return options.filter(isRecord).map(option).filter((o): o is ConfigOption => o !== undefined);
}

/**
 * The `session/set_config_option` params to set `value`, or the reason it
 * cannot be set (an unknown choice, a value of the wrong type, an option type
 * this client does not know).
 */
export function configParams(
  protocol: 1 | 2,
  sessionId: string,
  option: ConfigOption,
  value: string | boolean
): { params: Record<string, unknown> } | { problem: string } {
  const base = { sessionId, configId: option.id };
  if (option.type === 'boolean') {
    if (typeof value !== 'boolean') return { problem: `${option.id} is on or off: set it to true or false` };
    return { params: { ...base, type: 'boolean', value } };
  }
  if (option.type === 'select') {
    const choices = (option as { choices: ConfigChoice[] }).choices;
    if (typeof value !== 'string' || !choices.some((c) => c.value === value)) {
      return { problem: `${option.id} has no choice ${JSON.stringify(value)} (choices: ${choices.map((c) => c.value).join(', ') || 'none'})` };
    }
    return { params: protocol === 2 ? { ...base, type: 'id', value } : { ...base, value } };
  }
  return { problem: `${option.id} is a "${option.type}" option, which this client cannot set` };
}
