#!/usr/bin/env node
/**
 * Full-window UI composite for visual review.
 *
 * Renders the chosen ocean preset with the software engine, then composites
 * preview/glass-fixture.svg (t3's 252/876/312 dark-glass geometry and token
 * alphas) over it. This is the software path for shots/glass-b-1440x900.png;
 * the same SVG can be opened over the real app fixture in Chrome.
 *
 *   node scripts/glass-composite.mjs --preset b --size 1440x900 \
 *     --out shots/glass-b-1440x900.png
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSoftware } from "./render-software.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadSharp() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch (err) {
    /* fall through to DSH's bundled copy */
  }
  const candidates = [
    process.env.DSH_ASAR,
    process.env.DSH_ASAR_PACKAGE,
    process.resourcesPath ? join(process.resourcesPath, "app.asar", "dsh", "package.json") : "",
    "D:\\Users\\Rene\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\package.json",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return createRequire(candidate)("sharp");
    } catch (err) {
      /* try the next candidate */
    }
  }
  throw new Error("glass composite needs sharp (npm i sharp or run in DSH's Electron Node runtime)");
}

function parseSize(raw) {
  const match = /^(\d+)\s*[x\u00d7]\s*(\d+)$/i.exec(String(raw || "").trim());
  if (!match) throw new Error("--size must look like 1440x900");
  return { width: Number(match[1]), height: Number(match[2]) };
}

function inspectPng(path) {
  const buf = readFileSync(path);
  const signature = "89504e470d0a1a0a";
  if (buf.length < 33 || buf.subarray(0, 8).toString("hex") !== signature) {
    return { ok: false, reason: "not a PNG", bytes: buf.length };
  }
  return { ok: true, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { preset: "b", seed: 20260101, frames: 240, oceanOpacity: 0.62, blur: 1.2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/glass-composite.mjs --preset b --size 1440x900 [--out shots/glass-b-1440x900.png] [--seed N] [--frames N] [--ocean-opacity 0.62] [--blur 1.2] [--fixture preview/glass-fixture.svg]");
      return;
    }
    const eq = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!eq && (!arg.startsWith("--") || i + 1 >= argv.length)) throw new Error("bad argument: " + arg);
    const key = eq ? eq[1] : arg.slice(2);
    const value = eq ? eq[2] : argv[++i];
    switch (key) {
      case "preset": opts.preset = value; break;
      case "size": Object.assign(opts, parseSize(value)); break;
      case "out": opts.out = value; break;
      case "seed": opts.seed = Number(value); break;
      case "frames": opts.frames = Number(value); break;
      case "fixture": opts.fixture = value; break;
      case "ocean-opacity": opts.oceanOpacity = Number(value); break;
      case "blur": opts.blur = Number(value); break;
      default: throw new Error("unknown option --" + key);
    }
  }
  if (!opts.width || !opts.height) Object.assign(opts, parseSize("1440x900"));
  const size = { width: opts.width, height: opts.height };
  const out = opts.out ? resolve(process.cwd(), opts.out) : join(ROOT, "shots", "glass-" + opts.preset + "-" + size.width + "x" + size.height + ".png");
  const fixture = opts.fixture ? resolve(process.cwd(), opts.fixture) : join(ROOT, "preview", "glass-fixture.svg");
  if (!existsSync(fixture)) throw new Error("fixture not found: " + fixture);
  mkdirSync(dirname(out), { recursive: true });

  const sharp = await loadSharp();
  const oceanPath = join(ROOT, "shots", ".glass-ocean-" + size.width + "x" + size.height + "-" + opts.preset + ".png");
  try {
    const ocean = await renderSoftware({
      width: size.width,
      height: size.height,
      preset: opts.preset,
      out: oceanPath,
      panel: false,
      seed: opts.seed,
      frames: opts.frames,
    });
    const svg = readFileSync(fixture);
    // The live plugin renders the field at idleOpacity 0.6 behind a transcript;
    // t3 measured canvas opacity 0.61. A small blur simulates backdrop-filter.
    await sharp(oceanPath)
      .linear(opts.oceanOpacity, 0)
      .blur(opts.blur)
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toFile(out);
    const png = inspectPng(out);
    if (!png.ok) throw new Error("composite did not produce a PNG");
    console.log("[glass] " + png.width + "x" + png.height + " " + Math.round(png.bytes / 1024) + " KB -> " + out);
    console.log(JSON.stringify({
      out: out,
      width: png.width,
      height: png.height,
      bytes: png.bytes,
      preset: opts.preset,
      seed: opts.seed,
      frames: opts.frames,
      oceanOpacity: opts.oceanOpacity,
      blur: opts.blur,
      fixture: fixture,
      oceanBytes: ocean.bytes,
      engine: "software+svg-fixture",
    }));
  } finally {
    rmSync(oceanPath, { force: true });
  }
}

main().catch(function (err) {
  console.error("[glass] " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
