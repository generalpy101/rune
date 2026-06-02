/**
 * Import third-party terminal color schemes into RustTerm's theme shape.
 *
 * Supported formats (auto-detected from content, with a filename hint):
 *   - Apple Terminal `.terminal`   — XML plist whose color values are
 *     NSKeyedArchiver *binary* plists (base64 <data>); we decode the bplist to
 *     pull the NSColor components.
 *   - iTerm2 `.itermcolors`        — XML plist with `Red/Green/Blue Component`
 *     reals per color.
 *   - Windows Terminal scheme JSON — `{ background, foreground, black, ... }`.
 *   - VS Code theme JSON           — `colors["terminal.ansiRed"]`, etc.
 *   - RustTerm's own export        — `{ ui, terminal }` (passes through).
 *
 * Only terminal colors live in these files, so we synthesize the app-chrome
 * `UIColors` palette from the terminal background/foreground/accent.
 */
import type { ITheme } from "@xterm/xterm";
import type { ThemeDef, UIColors } from "./settings";

// ───────────────────────────── color math ─────────────────────────────

type RGB = { r: number; g: number; b: number };

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex({ r, g, b }: RGB): string {
  const h = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hexToRgb(hex: string): RGB {
  let s = hex.replace(/^#/, "").trim();
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length === 8) s = s.slice(0, 6); // drop alpha
  const n = parseInt(s || "000000", 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Linear blend between two colors. t=0 → a, t=1 → b. */
function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

/** Perceived luminance 0..1. */
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Pick black or white for legible text on top of `bg`. */
function contrastText(bg: string): string {
  return luminance(bg) > 0.5 ? "#000000" : "#ffffff";
}

// ─────────────────────── derive app-chrome palette ────────────────────

/** Build a full `UIColors` chrome palette from the terminal colors. */
function deriveUI(term: ITheme, dark: boolean): UIColors {
  const bg = term.background ?? (dark ? "#1e1e2e" : "#eff1f5");
  const fg = term.foreground ?? (dark ? "#cdd6f4" : "#4c4f69");
  const accent = term.blue ?? term.cyan ?? (dark ? "#89b4fa" : "#1e66f5");
  // Shift surfaces toward black (dark) or white (light) for layering.
  const toward = dark ? "#000000" : "#ffffff";
  const away = dark ? "#ffffff" : "#000000";
  return {
    bg: mix(bg, toward, 0.35),
    panel: bg,
    panel2: mix(bg, toward, 0.18),
    panel3: mix(bg, away, 0.12),
    border: mix(bg, fg, 0.18),
    text: fg,
    muted: mix(fg, bg, 0.45),
    accent,
    accentFg: contrastText(accent),
    danger: term.red ?? "#f38ba8",
    success: term.green ?? "#a6e3a1",
    warning: term.yellow ?? "#f9e2af",
    purple: term.magenta ?? "#cba6f7",
  };
}

// ───────────────────────────── base64 ─────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asciiDecode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ─────────────────────────── XML plist ────────────────────────────────

type PlistValue =
  | string
  | number
  | boolean
  | Uint8Array
  | PlistValue[]
  | { [k: string]: PlistValue };

/** Convert an XML-plist element into a JS value. `<data>` → bytes. */
function xmlPlistToJs(el: Element): PlistValue {
  switch (el.tagName) {
    case "dict": {
      const out: { [k: string]: PlistValue } = {};
      const kids = Array.from(el.children);
      for (let i = 0; i + 1 < kids.length; i += 2) {
        out[kids[i].textContent ?? ""] = xmlPlistToJs(kids[i + 1]);
      }
      return out;
    }
    case "array":
      return Array.from(el.children).map(xmlPlistToJs);
    case "real":
      return parseFloat(el.textContent ?? "0");
    case "integer":
      return parseInt(el.textContent ?? "0", 10);
    case "true":
      return true;
    case "false":
      return false;
    case "data":
      return base64ToBytes(el.textContent ?? "");
    default:
      return el.textContent ?? "";
  }
}

function parseXmlPlist(text: string): PlistValue {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid XML plist.");
  const root = doc.querySelector("plist > *");
  if (!root) throw new Error("No <plist> root element found.");
  return xmlPlistToJs(root);
}

// ─────────────────── Apple binary plist (NSColor) ─────────────────────

interface UidRef {
  __uid: number;
}
function isUid(v: unknown): v is UidRef {
  return typeof v === "object" && v !== null && "__uid" in v;
}

/** Decode just enough of a bplist00 archive to walk its object graph. */
function parseBinaryPlist(buf: Uint8Array): PlistValue {
  if (asciiDecode(buf.slice(0, 8)) !== "bplist00")
    throw new Error("Not a binary plist.");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const readUInt = (off: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + dv.getUint8(off + i);
    return v;
  };

  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const numObjects = readUInt(trailer + 8, 8);
  const topObject = readUInt(trailer + 16, 8);
  const offsetTableOffset = readUInt(trailer + 24, 8);
  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++)
    offsets.push(readUInt(offsetTableOffset + i * offsetSize, offsetSize));

  const readLen = (info: number, pos: number): [number, number] => {
    if (info !== 0x0f) return [info, pos];
    const m = buf[pos];
    const len = 1 << (m & 0x0f);
    return [readUInt(pos + 1, len), pos + 1 + len];
  };

  const parse = (index: number): PlistValue => {
    let pos = offsets[index];
    const marker = buf[pos];
    const type = marker >> 4;
    const info = marker & 0x0f;
    pos++;
    switch (type) {
      case 0x0:
        return info === 9 ? true : info === 8 ? false : "";
      case 0x1:
        return readUInt(pos, 1 << info);
      case 0x2: {
        const len = 1 << info;
        return len === 4 ? dv.getFloat32(pos) : dv.getFloat64(pos);
      }
      case 0x4: {
        const [len, p] = readLen(info, pos);
        return buf.slice(p, p + len);
      }
      case 0x5: {
        const [len, p] = readLen(info, pos);
        return asciiDecode(buf.slice(p, p + len));
      }
      case 0x6: {
        const [len, p] = readLen(info, pos);
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(p + i * 2));
        return s;
      }
      case 0x8:
        return { __uid: readUInt(pos, info + 1) } as PlistValue;
      case 0xa: {
        const [len, p] = readLen(info, pos);
        const arr: PlistValue[] = [];
        for (let i = 0; i < len; i++) arr.push(parse(readUInt(p + i * refSize, refSize)));
        return arr;
      }
      case 0xd: {
        const [len, p] = readLen(info, pos);
        const keys: number[] = [];
        for (let i = 0; i < len; i++) keys.push(readUInt(p + i * refSize, refSize));
        const valsAt = p + len * refSize;
        const out: { [k: string]: PlistValue } = {};
        for (let i = 0; i < len; i++) {
          const k = parse(keys[i]);
          out[String(k)] = parse(readUInt(valsAt + i * refSize, refSize));
        }
        return out;
      }
      default:
        return "";
    }
  };

  return parse(topObject);
}

/** Extract a hex color from an NSColor stored in a `.terminal` <data> blob. */
function parseAppleColor(bytes: Uint8Array): string | undefined {
  let pl: PlistValue;
  try {
    pl = parseBinaryPlist(bytes);
  } catch {
    return undefined;
  }
  const dict = pl as { [k: string]: PlistValue };
  const objects = dict["$objects"];
  const top = dict["$top"] as { root?: PlistValue } | undefined;
  const objArr = Array.isArray(objects) ? objects : [];
  const deref = (v: PlistValue | undefined): PlistValue | undefined =>
    isUid(v) ? objArr[v.__uid] : v;

  // Preferred path: root NSColor object → NSRGB / NSWhite component string.
  const root = deref(top?.root) as { [k: string]: PlistValue } | undefined;
  const fromComponents = (raw: PlistValue | undefined): string | undefined => {
    const data = deref(raw);
    if (!(data instanceof Uint8Array)) return undefined;
    const nums = asciiDecode(data)
      .replace(/\0/g, " ")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    if (nums.length >= 3)
      return rgbToHex({ r: nums[0] * 255, g: nums[1] * 255, b: nums[2] * 255 });
    if (nums.length >= 1)
      return rgbToHex({ r: nums[0] * 255, g: nums[0] * 255, b: nums[0] * 255 });
    return undefined;
  };
  if (root) {
    const rgb = fromComponents(root["NSRGB"]) ?? fromComponents(root["NSWhite"]);
    if (rgb) return rgb;
  }
  // Fallback: scan every object for a component-string data blob.
  for (const o of objArr) {
    const hex = fromComponents(o);
    if (hex) return hex;
  }
  return undefined;
}

// ──────────────────────── per-format parsers ──────────────────────────

/** Keys we collect, mapped onto xterm's ITheme. */
type TermKey = keyof ITheme;

const APPLE_MAP: Record<string, TermKey> = {
  BackgroundColor: "background",
  TextColor: "foreground",
  CursorColor: "cursor",
  SelectionColor: "selectionBackground",
  ANSIBlackColor: "black",
  ANSIRedColor: "red",
  ANSIGreenColor: "green",
  ANSIYellowColor: "yellow",
  ANSIBlueColor: "blue",
  ANSIMagentaColor: "magenta",
  ANSICyanColor: "cyan",
  ANSIWhiteColor: "white",
  ANSIBrightBlackColor: "brightBlack",
  ANSIBrightRedColor: "brightRed",
  ANSIBrightGreenColor: "brightGreen",
  ANSIBrightYellowColor: "brightYellow",
  ANSIBrightBlueColor: "brightBlue",
  ANSIBrightMagentaColor: "brightMagenta",
  ANSIBrightCyanColor: "brightCyan",
  ANSIBrightWhiteColor: "brightWhite",
};

function parseAppleTerminal(pl: PlistValue): { term: ITheme; label?: string } {
  const dict = pl as { [k: string]: PlistValue };
  const term: ITheme = {};
  for (const [k, target] of Object.entries(APPLE_MAP)) {
    const v = dict[k];
    if (v instanceof Uint8Array) {
      const hex = parseAppleColor(v);
      if (hex) (term as Record<string, string>)[target] = hex;
    }
  }
  const label = typeof dict["name"] === "string" ? (dict["name"] as string) : undefined;
  return { term, label };
}

const ITERM_MAP: Record<string, TermKey> = {
  "Background Color": "background",
  "Foreground Color": "foreground",
  "Cursor Color": "cursor",
  "Selection Color": "selectionBackground",
  "Ansi 0 Color": "black",
  "Ansi 1 Color": "red",
  "Ansi 2 Color": "green",
  "Ansi 3 Color": "yellow",
  "Ansi 4 Color": "blue",
  "Ansi 5 Color": "magenta",
  "Ansi 6 Color": "cyan",
  "Ansi 7 Color": "white",
  "Ansi 8 Color": "brightBlack",
  "Ansi 9 Color": "brightRed",
  "Ansi 10 Color": "brightGreen",
  "Ansi 11 Color": "brightYellow",
  "Ansi 12 Color": "brightBlue",
  "Ansi 13 Color": "brightMagenta",
  "Ansi 14 Color": "brightCyan",
  "Ansi 15 Color": "brightWhite",
};

function itermComponent(v: PlistValue | undefined): string | undefined {
  if (!v || typeof v !== "object" || v instanceof Uint8Array || Array.isArray(v))
    return undefined;
  const c = v as Record<string, PlistValue>;
  const r = c["Red Component"];
  const g = c["Green Component"];
  const b = c["Blue Component"];
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number")
    return undefined;
  return rgbToHex({ r: r * 255, g: g * 255, b: b * 255 });
}

function parseIterm(pl: PlistValue): { term: ITheme } {
  const dict = pl as { [k: string]: PlistValue };
  const term: ITheme = {};
  for (const [k, target] of Object.entries(ITERM_MAP)) {
    const hex = itermComponent(dict[k]);
    if (hex) (term as Record<string, string>)[target] = hex;
  }
  return { term };
}

const WT_MAP: Record<string, TermKey> = {
  background: "background",
  foreground: "foreground",
  cursorColor: "cursor",
  selectionBackground: "selectionBackground",
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  purple: "magenta",
  cyan: "cyan",
  white: "white",
  brightBlack: "brightBlack",
  brightRed: "brightRed",
  brightGreen: "brightGreen",
  brightYellow: "brightYellow",
  brightBlue: "brightBlue",
  brightPurple: "brightMagenta",
  brightCyan: "brightCyan",
  brightWhite: "brightWhite",
};

function parseWindowsTerminal(obj: Record<string, unknown>): {
  term: ITheme;
  label?: string;
} {
  const term: ITheme = {};
  for (const [k, target] of Object.entries(WT_MAP)) {
    const v = obj[k];
    if (typeof v === "string" && v.startsWith("#"))
      (term as Record<string, string>)[target] = v.slice(0, 7);
  }
  const label = typeof obj.name === "string" ? obj.name : undefined;
  return { term, label };
}

const VSCODE_MAP: Record<string, TermKey> = {
  "terminal.background": "background",
  "terminal.foreground": "foreground",
  "terminalCursor.foreground": "cursor",
  "terminal.selectionBackground": "selectionBackground",
  "terminal.ansiBlack": "black",
  "terminal.ansiRed": "red",
  "terminal.ansiGreen": "green",
  "terminal.ansiYellow": "yellow",
  "terminal.ansiBlue": "blue",
  "terminal.ansiMagenta": "magenta",
  "terminal.ansiCyan": "cyan",
  "terminal.ansiWhite": "white",
  "terminal.ansiBrightBlack": "brightBlack",
  "terminal.ansiBrightRed": "brightRed",
  "terminal.ansiBrightGreen": "brightGreen",
  "terminal.ansiBrightYellow": "brightYellow",
  "terminal.ansiBrightBlue": "brightBlue",
  "terminal.ansiBrightMagenta": "brightMagenta",
  "terminal.ansiBrightCyan": "brightCyan",
  "terminal.ansiBrightWhite": "brightWhite",
};

function parseVscode(obj: Record<string, unknown>): {
  term: ITheme;
  label?: string;
  dark?: boolean;
} {
  const colors = (obj.colors ?? {}) as Record<string, unknown>;
  const term: ITheme = {};
  for (const [k, target] of Object.entries(VSCODE_MAP)) {
    const v = colors[k];
    if (typeof v === "string" && v.startsWith("#"))
      (term as Record<string, string>)[target] = v.slice(0, 7);
  }
  // Fall back to editor bg/fg if the terminal-specific ones are absent.
  if (!term.background && typeof colors["editor.background"] === "string")
    term.background = (colors["editor.background"] as string).slice(0, 7);
  if (!term.foreground && typeof colors["editor.foreground"] === "string")
    term.foreground = (colors["editor.foreground"] as string).slice(0, 7);
  const label = typeof obj.name === "string" ? obj.name : undefined;
  const dark =
    typeof obj.type === "string" ? obj.type.toLowerCase() !== "light" : undefined;
  return { term, label, dark };
}

// ───────────────────────────── entry point ────────────────────────────

/** A parsed theme ready to be given an id and stored. */
export type ParsedTheme = Omit<ThemeDef, "label"> & { label: string };

/**
 * Parse any supported theme file/blob into a RustTerm ThemeDef. Throws with a
 * human-readable message if the format can't be recognized or has no colors.
 */
export function parseThemeText(text: string, filename?: string): ParsedTheme {
  const trimmed = text.trim();
  const ext = (filename ?? "").toLowerCase();

  let term: ITheme = {};
  let label: string | undefined;
  let darkHint: boolean | undefined;

  if (trimmed.startsWith("{") || ext.endsWith(".json")) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new Error("Invalid JSON.");
    }
    // RustTerm's own export shape — pass through unchanged.
    if (obj.ui && obj.terminal) {
      return {
        label: typeof obj.label === "string" ? obj.label : "Imported",
        dark: obj.dark !== false,
        terminal: obj.terminal as ITheme,
        ui: obj.ui as UIColors,
      };
    }
    if (obj.colors || obj.tokenColors || obj.type) {
      const r = parseVscode(obj);
      term = r.term;
      label = r.label;
      darkHint = r.dark;
    } else {
      const r = parseWindowsTerminal(obj);
      term = r.term;
      label = r.label;
    }
  } else if (trimmed.startsWith("<")) {
    const pl = parseXmlPlist(trimmed);
    // iTerm2 stores color *dicts*; Apple stores *data* blobs.
    const isIterm =
      ext.endsWith(".itermcolors") ||
      /Ansi \d+ Color/.test(trimmed) ||
      /Red Component/.test(trimmed);
    if (isIterm) {
      term = parseIterm(pl).term;
    } else {
      const r = parseAppleTerminal(pl);
      term = r.term;
      label = r.label;
    }
  } else {
    throw new Error(
      "Unrecognized theme format. Expected a .terminal, .itermcolors, Windows Terminal, or VS Code theme.",
    );
  }

  if (!term.background && !term.foreground && !term.black) {
    throw new Error("No colors found in this file.");
  }

  // Fill the small set of required terminal slots if the source omitted them.
  const dark = darkHint ?? luminance(term.background ?? "#1e1e2e") < 0.5;
  term.background ??= dark ? "#1e1e2e" : "#ffffff";
  term.foreground ??= dark ? "#cdd6f4" : "#1e1e2e";
  term.cursor ??= term.foreground;
  term.selectionBackground ??= mix(term.background, term.foreground, 0.3);

  return {
    label: label || nameFromFile(filename) || "Imported theme",
    dark,
    terminal: term,
    ui: deriveUI(term, dark),
  };
}

function nameFromFile(filename?: string): string | undefined {
  if (!filename) return undefined;
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base || undefined;
}
