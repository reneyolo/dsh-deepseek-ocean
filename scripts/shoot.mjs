#!/usr/bin/env node
/**
 * Screenshot pipeline for dsh-deepseek-ocean.
 *
 * Default engine: software (the same lib/client.js renderer, rasterized with
 * sharp). Pass --engine chrome / --chrome for a real headless-Chrome capture;
 * captain runs those at t5/t6/t8 checkpoints under danger-full-access.
 *
 *   node scripts/shoot.mjs --size 1440x900 --preset default \\
 *     --out shots/baseline-1440x900.png [--panel]
 *
 * The preview page (preview/index.html) fakes the DSH module loader, imports
 * lib/client.js, renders a deterministic frame into a full-viewport canvas and
 * then Chrome captures it. No dev server, no npm dependencies.
 *
 * Options
 *   --size WxH             viewport / screenshot size (default 1440x900)
 *   --preset NAME          preset from preview/presets.js or lib/client.js
 *                          (also accepts an inline JSON settings object)
 *   --out PATH             output PNG (default shots/shot-<size>-<preset>.png)
 *   --panel                show the preview HUD / panel hook in the capture
 *   --seed N               deterministic simulation seed (default 20260101)
 *   --frames N             simulated 1/60 s frames before capture (default 240)
 *   --dpr N                device pixel ratio (default 1)
 *   --chrome PATH          Chrome executable (default: known Windows paths,
 *                          or $CHROME_PATH / $DSH_OCEAN_CHROME)
 *   --timeout MS           per-shot timeout (default 60000)
 *   --virtual-time-budget MS  Chrome's virtual time budget (default 5000)
 *   --engine NAME          software (default) or chrome
 *   --software             alias for --engine software
 *   --chrome               alias for --engine chrome (key-node captures)
 *   --tech 0|1             force the C tech overlay off/on (default: preset meta)
 *   --no-tech              alias for --tech 0
 *   --dry-run              print the resolved invocation/URL without rendering
 *   --help
 *
 * --engine software uses scripts/render-software.mjs, a sharp-based renderer
 * for the DSH Windows sandbox (child processes run at Low integrity, so
 * Chromium cannot create its Mojo named pipes). Chrome remains available for
 * the captain's danger-full-access checkpoints.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW = join(ROOT, "preview", "index.html");
const DEFAULT_CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
];

function usage() {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const header = text.slice(0, text.indexOf("*/") + 2);
  console.log(header.replace(/^\/\*\*?|\s*\*\/?$/gm, "").trim());
}

function die(message) {
  console.error("[shoot] " + message);
  process.exitCode = 1;
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    size: "1440x900",
    preset: "default",
    out: "",
    panel: false,
    seed: "20260101",
    frames: "240",
    dpr: "1",
    chrome: "",
    timeout: "60000",
    virtualTimeBudget: "5000",
    engine: "software",
    tech: undefined,
    dryRun: false,
  };

  const booleans = {
    panel: (value) => opts.panel = value !== "0" && value !== "false",
    "no-panel": () => opts.panel = false,
    "no-tech": () => opts.tech = false,
    software: () => opts.engine = "software",
    chrome: () => opts.engine = "chrome",
    "dry-run": () => opts.dryRun = true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (Object.prototype.hasOwnProperty.call(booleans, arg.slice(2)) && arg.startsWith("--")) {
      booleans[arg.slice(2)]();
      continue;
    }

    let key;
    let value;
    const eq = /^--([a-z][a-z0-9-]*)=(.*)$/i.exec(arg);
    if (eq) {
      key = eq[1];
      value = eq[2];
    } else if (arg.startsWith("--")) {
      key = arg.slice(2);
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) die("missing value for --" + key);
      i += 1;
    } else {
      die("unexpected argument: " + arg);
    }

    switch (key.toLowerCase()) {
      case "size": opts.size = value; break;
      case "preset": opts.preset = value; break;
      case "out": opts.out = value; break;
      case "panel": booleans.panel(value); break;
      case "seed": opts.seed = value; break;
      case "frames": opts.frames = value; break;
      case "dpr": opts.dpr = value; break;
      case "chrome": opts.chrome = value; break;
      case "timeout": opts.timeout = value; break;
      case "virtual-time-budget": opts.virtualTimeBudget = value; break;
      case "engine": opts.engine = value; break;
      case "tech": opts.tech = value !== "0" && value !== "false"; break;
      default: die("unknown option --" + key);
    }
  }
  return opts;
}

function parseSize(raw) {
  const match = /^(\d+)\s*[x\u00d7]\s*(\d+)$/i.exec(String(raw).trim());
  if (!match) die("--size must look like 1440x900, got " + JSON.stringify(raw));
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 2 || height < 2 || width > 16384 || height > 16384) die("--size out of range: " + raw);
  return { width: width, height: height };
}

function positiveInt(raw, name, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) die("--" + name + " must be a positive number, got " + JSON.stringify(raw));
  return Math.round(value);
}

function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_OCEAN_CHROME,
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    ...DEFAULT_CHROME_PATHS,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  die(
    "Chrome not found. Pass --chrome <path> or set CHROME_PATH.\n" +
      "Tried:\n  " + candidates.join("\n  ")
  );
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Wait until Chrome has finished writing the PNG (size stable across polls). */
async function waitForPng(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size === lastSize) {
        stable += 1;
        if (stable >= 2) return size;
      } else {
        stable = 0;
      }
      lastSize = size;
    }
    await sleep(120);
  }
  if (existsSync(path)) return statSync(path).size;
  return -1;
}

/** Minimal PNG probe: signature + IHDR dimensions. */
function inspectPng(path) {
  const buf = readFileSync(path);
  const signature = "89504e470d0a1a0a";
  if (buf.length < 33 || buf.subarray(0, 8).toString("hex") !== signature) {
    return { ok: false, reason: "not a PNG (bad signature)", bytes: buf.length };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  return { ok: true, width: width, height: height, bitDepth: bitDepth, colorType: colorType, bytes: buf.length };
}

function safeSlug(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "preset";
}

function chromeVersion(chrome) {
  const res = spawnSync(chrome, ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
  return ((res.stdout || "") + (res.stderr || "")).trim() || "unknown";
}

/** One source of truth for Chrome's flags (dry-run uses a placeholder profile). */
function chromeArgsFor(options) {
  return [
    "--headless=new",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--user-data-dir=" + options.profileDir,
    "--force-device-scale-factor=" + options.dpr,
    "--window-size=" + options.size.width + "," + options.size.height,
    "--virtual-time-budget=" + options.virtualTimeBudget,
    "--run-all-compositor-stages-before-draw",
    "--disable-new-content-rendering-timeout",
    "--screenshot=" + options.outPath,
    options.url.toString(),
  ];
}

export async function run(argv) {
  const opts = parseArgs(argv);
  const size = parseSize(opts.size);
  const seed = positiveInt(opts.seed, "seed", 20260101);
  const frames = Number(opts.frames);
  if (!Number.isFinite(frames) || frames < 0) die("--frames must be a non-negative number");
  const dpr = Number(opts.dpr);
  if (!Number.isFinite(dpr) || dpr <= 0 || dpr > 4) die("--dpr must be between 0 and 4");
  const timeout = positiveInt(opts.timeout, "timeout", 60000);
  const virtualTimeBudget = positiveInt(opts.virtualTimeBudget, "virtual-time-budget", 5000);

  if (!existsSync(PREVIEW)) die("preview page not found: " + PREVIEW);
  if (!existsSync(join(ROOT, "lib", "client.js"))) die("lib/client.js not found under " + ROOT);

  const outPath = opts.out
    ? resolve(process.cwd(), opts.out)
    : join(ROOT, "shots", "shot-" + size.width + "x" + size.height + "-" + safeSlug(opts.preset) + ".png");
  mkdirSync(dirname(outPath), { recursive: true });

  if (opts.engine === "software") {
    if (opts.dryRun) {
      console.log(JSON.stringify({
        dryRun: true,
        engine: "software",
        out: outPath,
        width: size.width,
        height: size.height,
        preset: opts.preset,
        seed: seed,
        frames: frames,
        panel: opts.panel,
        tech: opts.tech,
      }, null, 2));
      return;
    }
    const { renderSoftware } = await import("./render-software.mjs");
    const result = await renderSoftware({
      width: size.width,
      height: size.height,
      preset: opts.preset,
      out: outPath,
      panel: opts.panel,
      tech: opts.tech,
      seed: seed,
      frames: frames,
    });
    console.log("[shoot] software " + result.width + "x" + result.height + " " + Math.round(result.bytes / 1024) + " KB -> " + result.out);
    console.log(JSON.stringify(result));
    return;
  }
  if (opts.engine !== "chrome") die("unknown --engine " + JSON.stringify(opts.engine) + " (expected chrome or software)");

  const chrome = findChrome(opts.chrome);

  const url = pathToFileURL(PREVIEW);
  url.search = new URLSearchParams({
    size: size.width + "x" + size.height,
    preset: opts.preset,
    seed: String(seed),
    frames: String(frames),
    dpr: String(dpr),
    panel: opts.panel ? "1" : "0",
  }).toString();
  if (opts.tech !== undefined) url.searchParams.set("tech", opts.tech ? "1" : "0");
  url.search = url.searchParams.toString();

  if (opts.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      engine: "chrome",
      chrome: chrome,
      out: outPath,
      width: size.width,
      height: size.height,
      preset: opts.preset,
      seed: seed,
      frames: frames,
      dpr: dpr,
      panel: opts.panel,
      tech: opts.tech,
      url: url.toString(),
      args: chromeArgsFor({
        profileDir: "<temp-profile>",
        outPath: outPath,
        url: url,
        size: size,
        dpr: dpr,
        virtualTimeBudget: virtualTimeBudget,
      }),
    }, null, 2));
    return;
  }

  rmSync(outPath, { force: true });
  const profileDir = mkdtempSync(join(tmpdir(), "dsh-ocean-chrome-"));
  const chromeArgs = chromeArgsFor({
    profileDir: profileDir,
    outPath: outPath,
    url: url,
    size: size,
    dpr: dpr,
    virtualTimeBudget: virtualTimeBudget,
  });

  console.log("[shoot] chrome " + chromeVersion(chrome));
  console.log("[shoot] " + size.width + "x" + size.height + " preset=" + opts.preset + " seed=" + seed + " frames=" + frames + (opts.panel ? " panel" : ""));
  console.log("[shoot] -> " + outPath);

  const started = Date.now();
  const result = spawnSync(chrome, chromeArgs, {
    encoding: "utf8",
    timeout: timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });

  const bytes = await waitForPng(outPath, Math.max(5000, Math.min(timeout, 30000)));
  const elapsed = Date.now() - started;

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    /* Chrome may still hold a handle; a temp profile is harmless. */
  }

  if (bytes < 0) {
    if (stdout) console.error("[shoot] chrome stdout:\n" + stdout);
    if (stderr) console.error("[shoot] chrome stderr:\n" + stderr);
    die(
      "Chrome did not write a screenshot (exit=" + result.status + ", signal=" + result.signal + ", elapsed=" + elapsed + "ms).\n" +
      "If this environment blocks Chromium (e.g. the DSH Windows sandbox raises child processes at Low integrity), retry with --engine software."
    );
  }

  const png = inspectPng(outPath);
  if (!png.ok) die("invalid screenshot: " + png.reason);

  if (png.width !== size.width || png.height !== size.height) {
    die(
      "screenshot size mismatch: expected " + size.width + "x" + size.height +
      ", got " + png.width + "x" + png.height +
      " (Chrome may have clamped --window-size)"
    );
  }

  if (result.status !== 0 && result.status !== null) {
    console.warn("[shoot] chrome exited with code " + result.status + " but a valid PNG was written");
    if (stderr) console.warn("[shoot] chrome stderr:\n" + stderr);
  }

  const kb = (png.bytes / 1024).toFixed(0);
  console.log("[shoot] ok " + png.width + "x" + png.height + " " + kb + " KB in " + elapsed + " ms");
  console.log(JSON.stringify({
    out: outPath,
    width: png.width,
    height: png.height,
    bytes: png.bytes,
    preset: opts.preset,
    seed: seed,
    frames: frames,
    panel: opts.panel,
    elapsedMs: elapsed,
    chrome: chrome,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((err) => die(err && err.stack ? err.stack : String(err)));
}
