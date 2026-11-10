/**
 * Session modes, one API over both ways agents offer them:
 *
 * - v1 `modes` (`session/set_mode`, `current_mode_update`), and
 * - config options with category `mode` (`session/set_config_option`,
 *   `config_option_update`), which v1 also has and v2 uses exclusively.
 */

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModes {
  current?: string;
  available: SessionMode[];
  /** How the agent offers them, and so how `setMode` switches. */
  via: 'modes' | 'config';
  /** For `via: 'config'`, the config option's id. */
  configId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Modes from a session/new (or set_config_option) answer. Config options win when both exist. */
export function modesFrom(source: Record<string, unknown>): SessionModes | undefined {
  return modesFromConfig(source.configOptions) ?? modesFromModeState(source.modes);
}

function modesFromModeState(state: unknown): SessionModes | undefined {
  if (!isRecord(state) || !Array.isArray(state.availableModes)) return undefined;
  return {
    via: 'modes',
    current: typeof state.currentModeId === 'string' ? state.currentModeId : undefined,
    available: state.availableModes.filter(isRecord).map((m) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
    })),
  };
}

export function modesFromConfig(options: unknown): SessionModes | undefined {
  if (!Array.isArray(options)) return undefined;
  const option = options.find((o) => isRecord(o) && o.category === 'mode' && o.type === 'select');
  if (!isRecord(option)) return undefined;
  const choices: SessionMode[] = [];
  for (const entry of Array.isArray(option.options) ? option.options : []) {
    // Options may be grouped.
    const list = isRecord(entry) && Array.isArray(entry.options) ? entry.options : [entry];
    for (const choice of list) {
      if (!isRecord(choice)) continue;
      choices.push({
        id: String(choice.value),
        name: String(choice.name ?? choice.value),
        ...(typeof choice.description === 'string' ? { description: choice.description } : {}),
      });
    }
  }
  return {
    via: 'config',
    configId: String(option.configId ?? option.id),
    current: typeof option.currentValue === 'string' ? option.currentValue : undefined,
    available: choices,
  };
}
