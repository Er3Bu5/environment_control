/* What the host sends the frame, checked before use. The host is trusted, but a message that isn't the right shape is
   dropped rather than half-used, so a host bug shows as nothing happening instead of a broken page. */

export interface Theme {
  appearance: "ha" | "light" | "dark";
  mode: "light" | "dark";
  colors: Record<string, string>;
}
export interface Stored {
  revision: number;
  zones: unknown[];
  devices: unknown[];
}
export type HostMessage =
  | ({ type: "init"; states: Record<string, unknown>; theme: Theme } & Stored)
  | ({ type: "config" } & Stored)
  | { type: "states"; states: Record<string, unknown> }
  | { type: "theme"; theme: Theme }
  | { type: "result"; req: number; ok: boolean; error?: string };

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;
const COLOR_KEYS = ["primary", "bg", "card", "tile", "fg", "muted", "line"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readTheme(t: unknown): Theme | null {
  if (!isObj(t) || !["ha", "light", "dark"].includes(t.appearance as string) || !["light", "dark"].includes(t.mode as string)) return null;
  const colors: Record<string, string> = {};
  /* Checked again here: a colour lands in a style property, so only a plain colour gets through. */
  if (isObj(t.colors)) for (const k of COLOR_KEYS) if (typeof t.colors[k] === "string" && COLOR.test(t.colors[k] as string)) colors[k] = t.colors[k] as string;
  return { appearance: t.appearance as Theme["appearance"], mode: t.mode as Theme["mode"], colors };
}

function readStored(m: Record<string, unknown>): Stored | null {
  if (!Number.isInteger(m.revision) || !Array.isArray(m.zones) || !Array.isArray(m.devices)) return null;
  return { revision: m.revision as number, zones: m.zones, devices: m.devices };
}

export function readHostMessage(data: unknown): HostMessage | null {
  if (!isObj(data) || data.v !== 1 || typeof data.type !== "string") return null;
  switch (data.type) {
    case "init": {
      const stored = readStored(data), theme = readTheme(data.theme);
      return stored && theme && isObj(data.states) ? { type: "init", ...stored, states: data.states, theme } : null;
    }
    case "config": {
      const stored = readStored(data);
      return stored ? { type: "config", ...stored } : null;
    }
    case "states":
      return isObj(data.states) ? { type: "states", states: data.states } : null;
    case "theme": {
      const theme = readTheme(data.theme);
      return theme ? { type: "theme", theme } : null;
    }
    case "result":
      return Number.isInteger(data.req) && typeof data.ok === "boolean"
        ? { type: "result", req: data.req as number, ok: data.ok, ...(typeof data.error === "string" ? { error: data.error } : {}) }
        : null;
    default:
      return null;
  }
}
