/**
 * Minimal YAML emitter for the managed config.yaml. Hermes reads its config
 * with PyYAML/ruamel, which accept this subset (block mappings, block
 * sequences, double-quoted strings, numbers, booleans, null). Keeping the
 * emitter here avoids a dependency and keeps the rendered file readable by
 * operators, unlike JSON-as-YAML.
 */
export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v); // double-quoted, escapes are YAML-compatible
}

function isPlain(v: YamlValue): v is { [key: string]: YamlValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function toYaml(value: YamlValue, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (isPlain(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}\n`;
    let out = '';
    for (const key of keys) {
      const v = value[key];
      const k = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
      if (isPlain(v)) {
        out += Object.keys(v).length === 0 ? `${pad}${k}: {}\n` : `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      } else if (Array.isArray(v)) {
        out += v.length === 0 ? `${pad}${k}: []\n` : `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      } else {
        out += `${pad}${k}: ${scalar(v)}\n`;
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    let out = '';
    for (const item of value) {
      if (isPlain(item) || Array.isArray(item)) {
        const nested = toYaml(item, indent + 1);
        // "- " replaces the first two spaces of the nested block's first line.
        out += `${pad}- ${nested.slice(pad.length + 2)}`;
      } else {
        out += `${pad}- ${scalar(item)}\n`;
      }
    }
    return out;
  }
  return `${pad}${scalar(value)}\n`;
}
