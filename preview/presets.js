/**
 * Preview-only style presets for preview/index.html and scripts/shoot.mjs.
 *
 * Data only. The preview merges this table with the plugin's own export:
 *   1. window.__OCEAN_PRESETS__ (this file)
 *   2. module.exports.PRESETS (lib/client.js, wins on name clashes)
 *
 * A preset is a settings patch passed to renderer.updateSettings(). The
 * presentation experiments that the renderer does not own yet live in
 * window.__OCEAN_PRESET_META__ and are drawn by preview/overlay.js:
 *
 *   grade  top haze / exposure lift (A subtle, B/C fog)
 *   tech   scanlines, ticks and guides, every alpha <= 0.05 (C)
 *
 * Candidate A, B and C keep cellSize, speed, paused and species identical.
 */
window.__OCEAN_PRESETS__ = {
  // Original t2/t3 field, kept for regression comparisons.
  default: {},

  // Kept for the old preview docs; not a candidate.
  shark: { species: "shark" },
  mono: { background: "#050607", grid: 0.026, ink: 1.05, density: 0.6 },

  // A - baseline lift: a touch of exposure, same depth and school density as
  // the tuned field. Target: mean 20-24, p90 35-45.
  a: {
    ink: 1.4,
    background: "#0b0d10",
    grid: 0.04,
    density: 0.7,
    depth: 0.5,
  },

  // B - fog depth: brighter background, higher depth (far/mid blur), a little
  // less mid-school ink, plus a visible top haze. Target: mean 24-30, p90 45-55.
  b: {
    ink: 1.6,
    background: "#0c0e12",
    grid: 0.045,
    density: 0.6,
    depth: 0.85,
  },

  // C - B plus the tech layer: identical field settings, only the overlay differs.
  c: {
    ink: 1.6,
    background: "#0c0e12",
    grid: 0.045,
    density: 0.6,
    depth: 0.85,
  },
};

window.__OCEAN_PRESET_META__ = {
  a: {
    grade: { top: 0.052, fade: 0.5 },
  },
  b: {
    grade: { top: 0.14, fade: 0.55, bottom: 0.03 },
  },
  c: {
    grade: { top: 0.14, fade: 0.55, bottom: 0.03 },
    tech: { scanline: 0.018, ticks: 0.05, guides: 0.025 },
  },
};
