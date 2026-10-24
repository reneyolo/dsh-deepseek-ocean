/**
 * Software rasterization fallback for the preview.
 *
 * The primary screenshot path is scripts/shoot.mjs (headless Chrome). Some
 * environments cannot start Chromium at all -- notably the DSH Windows sandbox,
 * whose confined child processes run at Low integrity, where Chromium's Mojo
 * named pipes are denied. This module executes the same lib/client.js renderer
 * with a minimal Canvas2D recorder, serializes the frame to SVG and rasterizes
 * it with sharp.
 *
 * It is intentionally a fallback: text metrics and anti-aliasing differ a
 * little from Chrome, and any canvas API used by future renderer changes must
 * be mirrored by the recorder (unsupported calls are reported).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Canvas colour string -> SVG paint + opacity. */
function parseColor(value) {
  if (value && typeof value === "object" && value.__gradient) {
    return { paint: "url(#" + value.id + ")", opacity: 1 };
  }
  const raw = String(value == null ? "#000" : value).trim();
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(raw);
  if (match) {
    const hex = "#" + [match[1], match[2], match[3]]
      .map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, "0"))
      .join("");
    return { paint: hex, opacity: match[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(match[4]))) };
  }
  return { paint: raw, opacity: 1 };
}

function parseFont(font) {
  const match = /^\s*(?:(normal|bold|[1-9]00)\s+)?([\d.]+)px\s+(.+)$/.exec(font || "");
  if (!match) return { weight: 400, size: 12, family: "Consolas, monospace" };
  let weight = match[1] || 400;
  if (weight === "normal") weight = 400;
  if (weight === "bold") weight = 700;
  let family = match[3].trim();
  // ui-monospace is a CSS generic family that fontconfig may not know.
  if (/ui-monospace/i.test(family)) family = family.replace(/ui-monospace/gi, "Consolas");
  return { weight: weight, size: Number(match[2]), family: family };
}

const WARNED = new Set();
function warnUnsupported(api) {
  if (WARNED.has(api)) return;
  WARNED.add(api);
  console.warn("[render-software] unsupported canvas API: " + api);
}

class Recorder {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.capture = true;
    this.parts = [];
    this.defs = [];
    this.gradientSeq = 0;
    this.registeredGradients = new Set();
    this.stack = [];
    this.path = [];
    this.frame = 0;
    this._state = {
      fillStyle: "#000000",
      strokeStyle: "#ffffff",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      font: "12px monospace",
      textAlign: "start",
      textBaseline: "alphabetic",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      shadowBlur: 0,
      shadowColor: "rgba(0,0,0,0)",
      filter: "none",
      sx: 1,
      sy: 1,
      tx: 0,
      ty: 0,
    };
  }

  get fillStyle() { return this._state.fillStyle; }
  set fillStyle(v) { this._state.fillStyle = v; }
  get strokeStyle() { return this._state.strokeStyle; }
  set strokeStyle(v) { this._state.strokeStyle = v; }
  get lineWidth() { return this._state.lineWidth; }
  set lineWidth(v) { this._state.lineWidth = v; }
  get lineCap() { return this._state.lineCap; }
  set lineCap(v) { this._state.lineCap = v; }
  get lineJoin() { return this._state.lineJoin; }
  set lineJoin(v) { this._state.lineJoin = v; }
  get font() { return this._state.font; }
  set font(v) { this._state.font = v; }
  get textAlign() { return this._state.textAlign; }
  set textAlign(v) { this._state.textAlign = v; }
  get textBaseline() { return this._state.textBaseline; }
  set textBaseline(v) { this._state.textBaseline = v; }
  get globalAlpha() { return this._state.globalAlpha; }
  set globalAlpha(v) { this._state.globalAlpha = v; }
  get globalCompositeOperation() { return this._state.globalCompositeOperation; }
  set globalCompositeOperation(v) {
    if (v && v !== "source-over") warnUnsupported("globalCompositeOperation=" + v);
    this._state.globalCompositeOperation = v;
  }
  get shadowBlur() { return this._state.shadowBlur; }
  set shadowBlur(v) {
    if (Number(v) > 0) warnUnsupported("shadowBlur");
    this._state.shadowBlur = v;
  }
  get shadowColor() { return this._state.shadowColor; }
  set shadowColor(v) { this._state.shadowColor = v; }
  get filter() { return this._state.filter; }
  set filter(v) {
    if (v && v !== "none") warnUnsupported("filter=" + v);
    this._state.filter = v;
  }

  beginFrame() {
    this.parts = [];
    this.defs = [];
    this.registeredGradients.clear();
    this.path = [];
    this.frame += 1;
  }

  save() { this.stack.push(Object.assign({}, this._state)); }
  restore() { if (this.stack.length) this._state = this.stack.pop(); }

  setTransform(a, b, c, d, e, f) {
    this._state.sx = a;
    this._state.sy = d;
    this._state.tx = e;
    this._state.ty = f;
  }
  resetTransform() { this.setTransform(1, 0, 0, 1, 0, 0); }
  translate(x, y) { this._state.tx += x; this._state.ty += y; }
  scale(x, y) { this._state.sx *= x; this._state.sy *= y; }
  rotate() { warnUnsupported("rotate"); }

  createLinearGradient(x0, y0, x1, y1) {
    const id = "g" + (++this.gradientSeq);
    const stops = [];
    return {
      __gradient: true, id: id, type: "linear",
      x0: x0, y0: y0, x1: x1, y1: y1, stops: stops,
      addColorStop: function (offset, color) { stops.push({ offset: offset, color: color }); },
    };
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    const id = "g" + (++this.gradientSeq);
    const stops = [];
    return {
      __gradient: true, id: id, type: "radial",
      x0: x0, y0: y0, r0: r0, x1: x1, y1: y1, r1: r1, stops: stops,
      addColorStop: function (offset, color) { stops.push({ offset: offset, color: color }); },
    };
  }
  createPattern() { warnUnsupported("createPattern"); return null; }

  registerGradient(gradient) {
    if (this.registeredGradients.has(gradient.id)) return;
    this.registeredGradients.add(gradient.id);
    const stops = gradient.stops.map(function (stop) {
      const colour = parseColor(stop.color);
      return '<stop offset="' + stop.offset + '" stop-color="' + colour.paint + '" stop-opacity="' + colour.opacity + '"/>';
    }).join("");
    if (gradient.type === "linear") {
      this.defs.push(
        '<linearGradient id="' + gradient.id + '" x1="' + gradient.x0 + '" y1="' + gradient.y0 +
        '" x2="' + gradient.x1 + '" y2="' + gradient.y1 + '" gradientUnits="userSpaceOnUse">' + stops + "</linearGradient>"
      );
    } else {
      this.defs.push(
        '<radialGradient id="' + gradient.id + '" cx="' + gradient.x1 + '" cy="' + gradient.y1 +
        '" r="' + gradient.r1 + '" fx="' + gradient.x0 + '" fy="' + gradient.y0 +
        '" gradientUnits="userSpaceOnUse">' + stops + "</radialGradient>"
      );
    }
  }

  paint(value) {
    if (value && value.__gradient) this.registerGradient(value);
    return parseColor(value);
  }

  alpha(colour) {
    return Math.max(0, Math.min(1, colour.opacity * this._state.globalAlpha));
  }

  rect(x, y, w, h, mode) {
    if (!this.capture) return;
    const state = this._state;
    const colour = this.paint(mode === "stroke" ? state.strokeStyle : state.fillStyle);
    const paint = mode === "stroke"
      ? 'fill="none" stroke="' + colour.paint + '" stroke-width="' + state.lineWidth + '"'
      : 'fill="' + colour.paint + '"';
    this.parts.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" ' + paint + ' opacity="' + this.alpha(colour) + '"/>');
  }
  fillRect(x, y, w, h) { this.rect(x, y, w, h, "fill"); }
  strokeRect(x, y, w, h) { this.rect(x, y, w, h, "stroke"); }
  clearRect(x, y, w, h) {
    if (!this.capture) return;
    this.parts.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="#000000"/>');
  }

  beginPath() { this.path = []; }
  closePath() { this.path.push("Z"); }
  moveTo(x, y) { this.path.push("M" + x + " " + y); }
  lineTo(x, y) { this.path.push("L" + x + " " + y); }
  quadraticCurveTo(cx, cy, x, y) { this.path.push("Q" + cx + " " + cy + " " + x + " " + y); }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { this.path.push("C" + c1x + " " + c1y + " " + c2x + " " + c2y + " " + x + " " + y); }
  rectPath(x, y, w, h) { this.path.push("M" + x + " " + y + "H" + (x + w) + "V" + (y + h) + "H" + x + "Z"); }
  arc(x, y, r, a0, a1, ccw) {
    const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    const sweep = ccw ? 0 : 1;
    const x0 = x + Math.cos(a0) * r;
    const y0 = y + Math.sin(a0) * r;
    const x1 = x + Math.cos(a1) * r;
    const y1 = y + Math.sin(a1) * r;
    this.path.push("M" + x0 + " " + y0 + "A" + r + " " + r + " 0 " + large + " " + sweep + " " + x1 + " " + y1);
  }
  ellipse(x, y, rx, ry, rotation, a0, a1, ccw) {
    if (rotation) warnUnsupported("ellipse(rotation)");
    const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    const sweep = ccw ? 0 : 1;
    const x0 = x + Math.cos(a0) * rx;
    const y0 = y + Math.sin(a0) * ry;
    const x1 = x + Math.cos(a1) * rx;
    const y1 = y + Math.sin(a1) * ry;
    this.path.push("M" + x0 + " " + y0 + "A" + rx + " " + ry + " 0 " + large + " " + sweep + " " + x1 + " " + y1);
  }
  clip() { warnUnsupported("clip"); }
  stroke() {
    if (!this.capture || !this.path.length) return;
    const state = this._state;
    const colour = this.paint(state.strokeStyle);
    this.parts.push(
      '<path d="' + this.path.join(" ") + '" fill="none" stroke="' + colour.paint +
      '" stroke-width="' + state.lineWidth + '" stroke-linecap="' + state.lineCap +
      '" stroke-linejoin="' + state.lineJoin + '" opacity="' + this.alpha(colour) + '"/>'
    );
  }
  fill() {
    if (!this.capture || !this.path.length) return;
    const state = this._state;
    const colour = this.paint(state.fillStyle);
    this.parts.push('<path d="' + this.path.join(" ") + '" fill="' + colour.paint + '" opacity="' + this.alpha(colour) + '"/>');
  }
  fillText(text, x, y) {
    if (!this.capture) return;
    const state = this._state;
    const colour = this.paint(state.fillStyle);
    const font = parseFont(state.font);
    const anchor = state.textAlign === "center" ? "middle" : state.textAlign === "right" || state.textAlign === "end" ? "end" : "start";
    const baseline = state.textBaseline === "middle" ? "central" : state.textBaseline === "top" ? "hanging" : "auto";
    this.parts.push(
      '<text x="' + x + '" y="' + y + '" font-family="' + escapeXml(font.family) +
      '" font-size="' + font.size + '" font-weight="' + font.weight +
      '" text-anchor="' + anchor + '" dominant-baseline="' + baseline +
      '" fill="' + colour.paint + '" opacity="' + this.alpha(colour) +
      '" xml:space="preserve">' + escapeXml(text) + "</text>"
    );
  }
  strokeText(text, x, y) {
    if (!this.capture) return;
    const state = this._state;
    const colour = this.paint(state.strokeStyle);
    const font = parseFont(state.font);
    const anchor = state.textAlign === "center" ? "middle" : "start";
    this.parts.push(
      '<text x="' + x + '" y="' + y + '" font-family="' + escapeXml(font.family) +
      '" font-size="' + font.size + '" font-weight="' + font.weight +
      '" text-anchor="' + anchor + '" fill="none" stroke="' + colour.paint +
      '" stroke-width="' + state.lineWidth + '" opacity="' + this.alpha(colour) +
      '">' + escapeXml(text) + "</text>"
    );
  }
  measureText(text) {
    const font = parseFont(this._state.font);
    return { width: String(text).length * font.size * 0.6 };
  }

  drawImage() { warnUnsupported("drawImage"); }
  getImageData() { warnUnsupported("getImageData"); return null; }
  putImageData() { warnUnsupported("putImageData"); }
  createImageData() { warnUnsupported("createImageData"); return null; }
  setLineDash() {}
  getLineDash() { return []; }

  toSvg() {
    const defs = this.defs.length ? "<defs>" + this.defs.join("") + "</defs>" : "";
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + this.width + '" height="' + this.height +
      '" viewBox="0 0 ' + this.width + " " + this.height + '">' + defs + this.parts.join("") + "</svg>"
    );
  }
}

function fakeCanvas(width, height) {
  const ctx = new Recorder(width, height);
  const canvas = {
    width: width,
    height: height,
    style: {},
    clientWidth: width,
    clientHeight: height,
    dataset: {},
    getContext: function () { return ctx; },
    getBoundingClientRect: function () {
      return { left: 0, top: 0, right: width, bottom: height, width: width, height: height };
    },
    setAttribute: function () {},
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  return { canvas: canvas, ctx: ctx };
}

/** Same roster presets as the renderer's internal specsFor(). */
function specsFor(species) {
  if (species === "koi") {
    return [{ kind: "koi", size: 1 }, { kind: "koi", size: 0.72 }, { kind: "koi", size: 0.86 }];
  }
  if (species === "goldfish") {
    return [{ kind: "goldfish", size: 1 }, { kind: "goldfish", size: 0.7 }, { kind: "goldfish", size: 0.85 }];
  }
  if (species === "shark") {
    return [{ kind: "shark", size: 1 }, { kind: "shark", size: 0.7 }, { kind: "shark", size: 0.84 }];
  }
  return undefined;
}

async function loadSharp() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch (err) {
    /* not installed next to the script: try DSH's bundled copy */
  }
  const candidates = [
    process.env.DSH_ASAR,
    process.env.DSH_ASAR_PACKAGE,
    process.resourcesPath ? join(process.resourcesPath, "app.asar", "dsh", "package.json") : "",
    "D:\\Users\\Rene\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\package.json",
  ].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const req = createRequire(candidate);
      return req("sharp");
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    "software renderer needs sharp. Install it (npm i sharp) or run inside DSH's Electron Node runtime." +
      (lastError ? "\nLast error: " + lastError.message : "")
  );
}

function inspectPng(path) {
  const buf = readFileSync(path);
  const signature = "89504e470d0a1a0a";
  if (buf.length < 33 || buf.subarray(0, 8).toString("hex") !== signature) {
    return { ok: false, reason: "not a PNG", bytes: buf.length };
  }
  return { ok: true, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

function hudSvg(info) {
  const pad = 14;
  const lines = [
    ["DEEPSEEK-OCEAN / PREVIEW", true],
    ["viewport " + info.width + "x" + info.height, false],
    ["preset " + info.preset, false],
    ["seed " + info.seed + " / frames " + info.frames, false],
    ["module " + (info.moduleId || "?"), false],
    ["grid " + info.cols + "x" + info.rows + " cells", false],
    ["sharks " + info.sharks + " / fish " + info.fish, false],
    ["render " + info.elapsedMs + " ms", false],
  ];
  const lineHeight = 18;
  const boxWidth = 300;
  const boxHeight = pad * 2 + lines.length * lineHeight;
  const parts = [
    '<rect x="16" y="16" width="' + boxWidth + '" height="' + boxHeight +
      '" fill="#040609" fill-opacity="0.78" stroke="#ffffff" stroke-opacity="0.22"/>',
  ];
  lines.forEach(function (line, index) {
    const title = line[1];
    parts.push(
      '<text x="' + (16 + pad) + '" y="' + (16 + pad + 13 + index * lineHeight) +
      '" font-family="Consolas, monospace" font-size="11" font-weight="' + (title ? 700 : 400) +
      '" fill="' + (title ? "#ffffff" : "#8a929c") + '" xml:space="preserve">' +
      escapeXml(line[0]) + "</text>"
    );
  });
  return parts.join("");
}

export async function renderSoftware(options) {
  const width = options.width;
  const height = options.height;
  const presetName = options.preset || "default";
  const seed = options.seed === undefined ? 20260101 : Number(options.seed);
  const frames = options.frames === undefined ? 240 : Number(options.frames);
  const panel = !!options.panel;
  const out = options.out
    ? resolve(process.cwd(), options.out)
    : join(ROOT, "shots", "shot-" + width + "x" + height + "-" + String(presetName).replace(/[^a-z0-9._-]+/gi, "-") + ".png");

  const sharp = await loadSharp();
  mkdirSync(dirname(out), { recursive: true });

  const presetSource = readFileSync(join(ROOT, "preview", "presets.js"), "utf8");
  const overlaySource = readFileSync(join(ROOT, "preview", "overlay.js"), "utf8");
  const clientSource = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

  const stage = fakeCanvas(width, height);
  const canvas = stage.canvas;
  const ctx = stage.ctx;
  const browserWindow = {
    __OCEAN_PRESETS__: {},
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    devicePixelRatio: 1,
    matchMedia: function () { return { matches: false, addEventListener: function () {}, removeEventListener: function () {} }; },
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  globalThis.window = browserWindow;
  globalThis.document = {
    createElement: function () { return fakeCanvas(1, 1).canvas; },
    body: { appendChild: function () {} },
    addEventListener: function () {},
    documentElement: { dataset: {} },
  };
  globalThis.performance = globalThis.performance || { now: function () { return Date.now(); } };

  let moduleExports = null;
  let moduleId = null;
  browserWindow.__ModuleLoader__ = {
    load: function (entry) {
      moduleId = entry.id || null;
      moduleExports = entry.factory(function (name) {
        if (name === "react") {
          return {
            Fragment: Symbol.for("react.fragment"),
            createElement: function () { return null; },
            useEffect: function () {},
            useLayoutEffect: function () {},
            useMemo: function (factory) { return factory(); },
            useCallback: function (fn) { return fn; },
            useRef: function (value) { return { current: value === undefined ? null : value }; },
            useState: function (initial) { return [typeof initial === "function" ? initial() : initial, function () {}]; },
          };
        }
        throw new Error('software renderer: unsupported require("' + name + '")');
      });
      return moduleExports;
    },
  };

  vm.runInThisContext(presetSource, { filename: "preview/presets.js" });
  vm.runInThisContext(overlaySource, { filename: "preview/overlay.js" });
  vm.runInThisContext(clientSource, { filename: "lib/client.js" });

  if (!moduleExports || typeof moduleExports.World !== "function" || typeof moduleExports.AsciiRenderer !== "function") {
    throw new Error("lib/client.js did not export World / AsciiRenderer");
  }

  const presetTable = Object.assign({}, browserWindow.__OCEAN_PRESETS__ || {});
  if (moduleExports.PRESETS && typeof moduleExports.PRESETS === "object") Object.assign(presetTable, moduleExports.PRESETS);
  const metaTable = browserWindow.__OCEAN_PRESET_META__ || {};
  const meta = metaTable[presetName] || {};
  const techOn = options.tech === undefined ? !!meta.tech : !!options.tech;
  let patch = {};
  const trimmed = String(presetName || "").trim();
  if (trimmed && trimmed !== "default" && trimmed !== "none") {
    if (trimmed.charAt(0) === "{") {
      patch = JSON.parse(trimmed);
    } else if (Object.prototype.hasOwnProperty.call(presetTable, trimmed)) {
      patch = typeof presetTable[trimmed] === "function" ? presetTable[trimmed]() : presetTable[trimmed];
    } else {
      throw new Error('unknown preset "' + trimmed + '". known: ' + Object.keys(presetTable).join(", "));
    }
  }

  const nativeRandom = Math.random;
  Math.random = mulberry32(seed);
  let info;
  try {
    let world = new moduleExports.World(patch.sharks);
    const renderer = new moduleExports.AsciiRenderer(canvas);
    const beforeSpecies = renderer.settings.species;
    const settingsPatch = Object.assign({}, patch);
    delete settingsPatch.sharks;
    renderer.updateSettings(settingsPatch);
    if (patch.species && patch.species !== beforeSpecies) world = new moduleExports.World(specsFor(patch.species));
    renderer.resize(width, height, 1);
    world.resize(width, height, renderer.cellWidth, renderer.cellHeight);
    renderer.world = world;

    const dt = 1 / 60;
    const started = Date.now();
    ctx.capture = false;
    for (let i = 0; i < frames; i += 1) {
      world.step(dt);
      renderer.world = world;
      renderer.render(world, dt);
    }
    ctx.beginFrame();
    ctx.capture = true;
    renderer.render(world, dt);
    if (browserWindow.__OCEAN_OVERLAY__) {
      browserWindow.__OCEAN_OVERLAY__.draw(ctx, width, height, meta, { tech: techOn });
    }
    const elapsedMs = Date.now() - started;

    info = {
      width: width,
      height: height,
      preset: presetName,
      seed: seed,
      frames: frames,
      tech: techOn,
      moduleId: moduleId || "local",
      cols: renderer.cols,
      rows: renderer.rows,
      sharks: world.sharks.length,
      fish: world.fish.length,
      elapsedMs: elapsedMs,
    };

    let svg = ctx.toSvg();
    if (panel) svg = svg.replace("</svg>", hudSvg(info) + "</svg>");
    await sharp(Buffer.from(svg), { density: 72, limitInputPixels: false }).png().toFile(out);
  } finally {
    Math.random = nativeRandom;
  }

  const png = inspectPng(out);
  if (!png.ok) throw new Error("software renderer produced no PNG at " + out);
  return {
    out: out,
    width: png.width,
    height: png.height,
    bytes: png.bytes,
    preset: presetName,
    seed: seed,
    frames: frames,
    panel: panel,
    tech: info.tech,
    elapsedMs: info.elapsedMs,
    engine: "software",
  };
}

function parseSize(raw) {
  const match = /^(\d+)\s*[x\u00d7]\s*(\d+)$/i.exec(String(raw || "").trim());
  if (!match) throw new Error("--size must look like 1440x900");
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { preset: "default", panel: false, seed: 20260101, frames: 240 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/render-software.mjs --size 1440x900 [--preset default] [--out shots/x.png] [--panel] [--seed N] [--frames N]");
      return;
    }
    if (arg === "--panel") { opts.panel = true; continue; }
    const eq = /^--([a-z-]+)=(.*)$/i.exec(arg);
    if (!eq && (!arg.startsWith("--") || i + 1 >= argv.length)) throw new Error("bad argument: " + arg);
    const key = eq ? eq[1] : arg.slice(2);
    const value = eq ? eq[2] : argv[++i];
    switch (key.toLowerCase()) {
      case "size": Object.assign(opts, parseSize(value)); break;
      case "preset": opts.preset = value; break;
      case "out": opts.out = value; break;
      case "seed": opts.seed = Number(value); break;
      case "frames": opts.frames = Number(value); break;
      default: throw new Error("unknown option --" + key);
    }
  }
  if (!opts.width) Object.assign(opts, parseSize("1440x900"));
  const result = await renderSoftware(opts);
  console.log("[render-software] ok " + result.width + "x" + result.height + " " + Math.round(result.bytes / 1024) + " KB -> " + result.out);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(function (err) {
    console.error("[render-software] " + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}
