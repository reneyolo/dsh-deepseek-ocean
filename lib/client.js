/**
 * DEEP OCEAN - a monochrome, full-bleed ASCII shark field.
 *
 * The backdrop draws sharks and nothing else organic. Four depth layers share
 * one character grid:
 *
 *   layer      content        speed  brightness  blur (px)  glyph scale  shades
 *   fog        abyss + haze      0       0.08        6.0          -        4
 *   distant    small fish + dust  9       0.22        0.65       0.46       6
 *   mid        shark school     24       0.60        1.8        0.84      14
 *   near       hero shark       46       1.00        0.0        1.12      32
 *
 * v0.10 look (blue neon):
 *   - A shark is a neon LED panel. Every covered cell keeps a dark navy
 *     tile and gains a double stroke: a wide low-alpha bloom (4/6 px), the
 *     neon halo rgba(70,140,255, 0.20/0.30) at 2/2.5 px, a 1-device-pixel
 *     bright line rgba(150,205,255, 0.45-0.85), and a letter in light
 *     blue-white #a8d8ff with a 2 px low-alpha glow. The halo, bloom and
 *     letter glow breathe radially; the bright line fades at the rim.
 *   - Two tiers, selected by settings.glow: A (0) is restrained, B (1) is
 *     stronger. Only the halo alpha (0.20 -> 0.30), its width (2 -> 2.5 px)
 *     and the bloom (4 -> 6 px, 0.05 -> 0.10) change.
 *   - Marine snow: 400-600 one-/two-pixel cold white-blue motes over the
 *     whole viewport at alpha 0.06-0.24; near motes are larger and faster.
 *   - Fins: one dorsal (0.16L, swept), one pectoral (0.15L, swept) and a
 *     forked caudal fin (upper tip 0.19L).
 *   - Grid: 131 columns at 1440 (cw 11 / ch 17); letters are at most 0.95 of
 *     the cell width, leaving a visible frame/letter gap.
 *   - Radial breath: a centre-outward wave (2.1 rad/s, 2.35 rings per body)
 *     modulates the halo, the bloom and the letter glow of every cell.
 *   - Background: deep navy #04060c. Every canvas colour is blue-family
 *     (B > G > R), so alpha blending can never introduce a second hue.
 *   - Tech: 3px scanlines at a 6px pitch (alpha <= 2.5%), edge ticks and two
 *     guides (alpha <= 6%) behind the sharks, scaled by tech (default 0.35;
 *     T toggles, no panel control).
 *
 * Invariants the visual review relies on:
 *
 *   - Skin alphabet: only the five letters of "deepsk" (d, e, p, s, k).
 *     Glyph density follows cell brightness (sparse s -> dense k), so the
 *     letter field itself carries the shading.
 *   - Every covered cell carries a letter: the fish has no punctuation glyph
 *     of its own, so the LED wall stays a pure "deepsk" field. The legacy
 *     contour alphabet is still exported for older previews.
 *   - Every canvas colour comes from NEON through rgbCss(rgb, alpha) and is
 *     blue-family (B > G > R). The water keeps the configured hex RGB; the
 *     legacy grayCss helper survives for settings luma only and is no longer
 *     used by the renderer.
 *   - Cell coverage is continuous:
 *         coverage = clamp(0.5 + signedDistance / cellDiagonal, 0, 1)
 *     The stroke level and the letter shade stay continuous in coverage,
 *     and both fade together at the rim. There is no binary inside/outside
 *     cutoff anywhere on the silhouette.
 *
 * Mounting: the canvas is a fixed, viewport-sized child of <body>, so it sits
 * under every surface of the desktop shell (sidebar, conversation, right rail,
 * composer) instead of only behind the conversation column. A single injected
 * stylesheet re-tints the shell's background tokens to translucent glass while
 * preserving the light/dark luminance order, so the shark field shows through
 * the UI. Unmounting removes the canvas, the stylesheet and the tuner, and
 * touches no host inline styles or layout properties.
 */

window.__ModuleLoader__.load({
  id: "dsh-deepseek-ocean",
  factory: (require) => {
    "use strict";

    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ---------------------------------------------------------------- math

    const TAU = Math.PI * 2;
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const lerp = (a, b, t) => a + (b - a) * t;
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);

    function smoothstep(e0, e1, x) {
      const t = clamp((x - e0) / (e1 - e0), 0, 1);
      return t * t * (3 - 2 * t);
    }

    /** Shortest signed angle from a to b, in (-PI, PI]. */
    function angleDiff(a, b) {
      let d = (b - a) % TAU;
      if (d > Math.PI) d -= TAU;
      if (d < -Math.PI) d += TAU;
      return d;
    }

    /** Cheap deterministic hash. Returns [0, 1). */
    function hash3(x, y, z) {
      let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }

    // --------------------------------------------------------------- colour

    /**
     * The renderer's only colour source. Both forms pass the same byte to all
     * three channels, which keeps the whole plugin strictly achromatic.
     */
    function grayCss(level, alpha) {
      const g = clamp(Math.round(level), 0, 255);
      if (alpha === undefined) return "rgb(" + g + "," + g + "," + g + ")";
      return "rgba(" + g + "," + g + "," + g + "," + clamp(alpha, 0, 1).toFixed(3) + ")";
    }

    /** Any (r, g, b) triple as a CSS colour; used by the blue neon palette. */
    function rgbCss(rgb, alpha) {
      const r = clamp(Math.round(rgb[0]), 0, 255);
      const g = clamp(Math.round(rgb[1]), 0, 255);
      const b = clamp(Math.round(rgb[2]), 0, 255);
      if (alpha === undefined) return "rgb(" + r + "," + g + "," + b + ")";
      return "rgba(" + r + "," + g + "," + b + "," + clamp(alpha, 0, 1).toFixed(3) + ")";
    }

    /**
     * v0.10 blue neon palette. Every entry is blue-family (B > G > R), so
     * alpha-blending any two of them can never introduce a second hue.
     */
    const NEON = {
      water: [10, 16, 30], // #0a101e
      fillLow: [7, 12, 24], // belly of the tile
      fillHigh: [15, 24, 44], // lit back of the tile
      glow: [70, 140, 255], // outer neon stroke
      line: [150, 205, 255], // inner 1 px stroke
      letter: [168, 216, 255], // #a8d8ff
      snow: [205, 228, 255], // cold white-blue motes
      grid: [62, 104, 176],
      dust: [140, 186, 245],
      tech: [150, 196, 255],
      ripple: [159, 216, 255], // #9fd8ff
    };

    // ------------------------------------------------ ASCII painting (v0.11)

    /**
     * Density ramp, sparse -> dense. A cell's glyph is chosen from this ramp
     * by its shade: a dark belly gets "." and a lit back gets "@". Ten tiers
     * (the contract asks for at least six).
     */
    const ASCII_RAMP = [" ", ".", ":", "-", "=", "+", "*", "#", "%", "@"];

    /**
     * Four colour stops: deep navy, blue, cyan-blue, bright white-blue. The
     * per-cell shade interpolates through them; each depth layer scales the
     * result darker/colder, and each shark adds a small hue offset.
     */
    const PAINT_STOPS = [
      [22, 42, 90], // shadow dissolves into the water
      [44, 96, 184], // saturated deep blue, the dominant body tone
      [78, 157, 230], // restrained cyan-blue on the lit flank
      [234, 244, 255], // small white-blue specular islands
    ];
    const PAINT_K_LEVELS = 12;
    const PAINT_TINTS = 5;

    /** Per-layer brightness and coolness (near = bright/neutral, far = dark/cold). */
    function paintLayerGain(layerIndex) {
      if (layerIndex === 3) return { depth: 1, cool: 0 };
      if (layerIndex === 2) return { depth: 0.82, cool: 0.16 };
      return { depth: 0.58, cool: 0.52 };
    }

    /** Interpolated paint colour for shade k (0..1), layer gain and hue tint. */
    function paintColor(k, depth, cool, tint) {
      // A soft gamma lifts the mid-tones so the ASCII body reads at 1:1
      // without blowing out the white-blue highlights.
      const x = Math.pow(clamp(k, 0, 1), 0.92) * (PAINT_STOPS.length - 1);
      const i0 = Math.min(PAINT_STOPS.length - 2, Math.floor(x));
      const f = x - i0;
      const a = PAINT_STOPS[i0];
      const b = PAINT_STOPS[i0 + 1];
      const t = Number.isFinite(tint) ? clamp(tint, -1, 1) : 0;
      const gain = 1;
      return [
        clamp((a[0] + (b[0] - a[0]) * f) * gain * depth * (1 - cool * 0.28) * (1 + 0.12 * t), 0, 255),
        clamp((a[1] + (b[1] - a[1]) * f) * gain * depth * (1 - cool * 0.12) * (1 + 0.04 * t), 0, 255),
        clamp((a[2] + (b[2] - a[2]) * f) * gain * depth * (1 - 0.06 * t), 0, 255),
      ];
    }

    function mixRgb(from, to, f) {
      return [
        from[0] + (to[0] - from[0]) * f,
        from[1] + (to[1] - from[1]) * f,
        from[2] + (to[2] - from[2]) * f,
      ];
    }

    function parseHex(value) {
      const raw = String(value == null ? "" : value).trim();
      const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
      if (!match) return null;
      const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }

    /** Any configured colour collapses to one Rec.709 grey level. */
    function grayOf(value, fallback) {
      const rgb = parseHex(value);
      if (!rgb) return fallback;
      return Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
    }

    // --------------------------------------------------------------- glyphs

    /**
     * The shark skin alphabet: the five distinct letters of "deepsk", ordered
     * from sparse to dense so the glyph itself encodes brightness.
     */
    const BODY_RAMP = ["s", "e", "p", "d", "k"];
    const BODY_LETTERS = "deepsk";

    /**
     * The silhouette alphabet: ASCII punctuation only. Sparse fringe first,
     * then the denser punctuation ring, then four direction-aware contour
     * glyphs that trace the outline.
     */
    const EDGE_SPARSE = [".", "'", "\u0060", ","];
    const EDGE_MID = [",", ";", ":", "-"];
    const EDGE_DENSE = [":", "+", "=", "*", "!"];
    const EDGE_VERTICAL = "|";
    const EDGE_HORIZONTAL = "_";
    const EDGE_SLASH = "/";
    const EDGE_BACKSLASH = "\\";

    // --------------------------------------------------------------- depth

    /**
     * Four depth layers, far to near. speed, brightness, glyphScale and
     * shadeLevels all rise towards the viewer while blurPx falls; the array
     * is exported as DEPTH_LAYERS so the ordering is testable.
     */
    const DEPTH_LAYERS = [
      { id: "fog", speed: 0, brightness: 0.08, blurPx: 6, glyphScale: 0, shadeLevels: 4 },
      { id: "distant", speed: 9, brightness: 0.22, blurPx: 0.65, glyphScale: 0.46, shadeLevels: 6 },
      { id: "mid", speed: 24, brightness: 0.6, blurPx: 1.8, glyphScale: 0.84, shadeLevels: 14 },
      { id: "near", speed: 46, brightness: 1, blurPx: 0, glyphScale: 1.12, shadeLevels: 32 },
    ];
    const LAYER_FOG = 0;
    const LAYER_DISTANT = 1;
    const LAYER_MID = 2;
    const LAYER_NEAR = 3;

    /** Field-blur passes that realise a layer's blurPx on the cell grid. */
    function blurPassesFor(blurPx) {
      return clamp(Math.round(blurPx / 1.2), 0, 3);
    }

    // --------------------------------------------------------------- shark

    const SHARK_NODES = 22;

    /**
     * Half-width of the body as a fraction of body length, nose -> tail.
     * Round-2 proportions: peak 0.082 at s = 0.29 (a 6.1 : 1 body ratio) and
     * a snout under 0.03 by s = 0.05, so the shark reads as a streamlined
     * blade instead of a lens.
     */
    const BODY_PROFILE = [
      [0.0, 0.002], [0.015, 0.009], [0.03, 0.018], [0.05, 0.032], [0.08, 0.049],
      [0.12, 0.065], [0.18, 0.076], [0.24, 0.081], [0.29, 0.082], [0.36, 0.079],
      [0.44, 0.073], [0.52, 0.065], [0.6, 0.056], [0.68, 0.046], [0.75, 0.037],
      [0.82, 0.028], [0.88, 0.02], [0.94, 0.014], [1.0, 0.007],
    ];

    function bodyHalfWidth(s) {
      const k = clamp(s, 0, 1);
      for (let i = 1; i < BODY_PROFILE.length; i++) {
        if (k <= BODY_PROFILE[i][0]) {
          const a = BODY_PROFILE[i - 1];
          const b = BODY_PROFILE[i];
          return lerp(a[1], b[1], (k - a[0]) / (b[0] - a[0] || 1));
        }
      }
      return BODY_PROFILE[BODY_PROFILE.length - 1][1];
    }

    /**
     * Round-3 fin set: exactly one dorsal, one pectoral and one forked
     * caudal fin (two lobes, read as a single tail). The second dorsal and
     * the pelvic fin were removed on user request. Coordinates are
     * body-local (along, up) as fractions of body length; up is the back.
     * Limits: dorsal height <= 0.16L, pectoral <= 0.15L, caudal tip 0.19L.
     */
    const FINS = [
      // Upright triangular dorsal, rather than a swept dolphin-like hook.
      [[0.27, 0.055], [0.32, 0.16], [0.46, 0.055]],
      // pectoral: 0.15L, swept back 0.14L
      [[0.19, -0.05], [0.38, -0.15], [0.29, -0.05]],
      // caudal upper lobe
      [[0.87, 0.012], [0.99, 0.19], [0.96, 0.012]],
      // caudal lower lobe
      [[0.88, -0.008], [0.97, -0.105], [0.96, -0.008]],
    ];
    const FIN_ROLES = ["dorsal", "pectoral", "caudal-upper", "caudal-lower"];

    /** Signed distance to a triangle: positive inside, in the input units. */
    function triangleSd(px, py, ax, ay, bx, by, cx, cy) {
      const d1 = edgeDistance(px, py, ax, ay, bx, by);
      const d2 = edgeDistance(px, py, bx, by, cx, cy);
      const d3 = edgeDistance(px, py, cx, cy, ax, ay);
      const orient = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const sign = orient >= 0 ? 1 : -1;
      return Math.min(d1 * sign, d2 * sign, d3 * sign);
    }

    /** Signed distance from p to the line a->b, positive on the left. */
    function edgeDistance(px, py, ax, ay, bx, by) {
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1e-6;
      return (dx * (py - ay) - dy * (px - ax)) / len;
    }

    /** Slow divergence-free drift shared by the motes. */
    function current(x, y, t, out) {
      const a = x * 0.0038 + t * 0.07;
      const b = y * 0.0032 - t * 0.05;
      out.x = Math.sin(a) * Math.cos(b) * 26;
      out.y = Math.cos(a * 0.8) * Math.sin(b) * 18;
      return out;
    }

    // --------------------------------------------------------------- world

    const DEFAULT_ROSTER = [{ kind: "shark", size: 1 }];

    /**
     * Sharks only. The roster is kept for host compatibility (the settings
     * panel used to swap species); every entry now sizes a shark.
     */
    class World {
      constructor(roster) {
        this.roster = Array.isArray(roster) && roster.length ? roster : DEFAULT_ROSTER;
        this.width = 0;
        this.height = 0;
        this.minSide = 800;
        this.time = 0;
        this.cellW = 12;
        this.cellH = 18;
        this.sharks = [];
        this.particles = [];
        this.snow = [];
        this.fish = [];
        this.ripples = [];
        this.pointer = { x: 0, y: 0, active: false };
        this.seeded = false;
        this.nextId = 1;
        this.tmp = { x: 0, y: 0 };
      }

      resize(width, height, cellW, cellH) {
        this.width = width;
        this.height = height;
        this.cellW = cellW;
        this.cellH = cellH;
        this.minSide = Math.max(1, Math.min(width, height));
        if (!this.seeded) {
          this.seed();
          return;
        }
        for (const sh of this.sharks) {
          sh.nodes[0] = clamp(sh.nodes[0], -sh.length, width + sh.length);
          sh.nodes[1] = clamp(sh.nodes[1], -sh.length, height + sh.length);
        }
        for (const p of this.particles) {
          p.x = clamp(p.x, 0, width);
          p.y = clamp(p.y, 0, height);
        }
        for (const p of this.snow) {
          p.x = clamp(p.x, 0, width);
          p.y = clamp(p.y, 0, height);
        }
      }

      seed() {
        this.seeded = true;
        const W = this.width;
        const H = this.height;
        const M = this.minSide;
        this.sharks.length = 0;
        this.particles.length = 0;
        this.snow.length = 0;
        this.ripples.length = 0;
        this.nextId = 1;

        const heroSpec = this.roster[0] || DEFAULT_ROSTER[0];
        const heroSize = clamp(Number(heroSpec.size) || 1, 0.3, 2);
        // v0.5: no giant hero. Two smaller near sharks + one mid main; every
        // length stays <= 0.55 x minSide, and sizes/headings are jittered so
        // the pair does not read as a repeated stamp.
        const heroBase = M * 0.45 * heroSize;
        const nearA = heroBase * rand(0.96, 1.0);
        const nearB = heroBase * rand(0.90, 0.95);
        this.addShark(LAYER_NEAR, nearA, W * 0.24, H * 0.54, -0.38 + rand(-0.12, 0.12));
        this.addShark(LAYER_NEAR, nearB, W * 0.76, H * 0.30, Math.PI + 0.26 + rand(-0.12, 0.12));
        // v0.6b: 8 distant small fish, randomly scattered with a 330px
        // placement floor so the pair distance in the rendered frame (after
        // 4s of drift) still stays >=250px; no grid, no corner symmetry. The
        // layer blur is 1 pass so letters/punctuation stay readable.
        const distantPlaced = [];
        for (let i = 0, guard = 0; i < 5 && guard < 2500; guard++) {
          const length = M * rand(0.18, 0.265);
          const heading = rand(-0.35, 0.35) + (i % 2 === 0 ? Math.PI : 0);
          const x = rand(W * 0.05, W * 0.95);
          const y = rand(H * 0.08, H * 0.92);
          const cx = x - Math.cos(heading) * length * 0.5;
          const cy = y - Math.sin(heading) * length * 0.5;
          let ok = true;
          for (let k = 0; k < distantPlaced.length; k++) {
            if (Math.hypot(distantPlaced[k].x - cx, distantPlaced[k].y - cy) < 380) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          let nearClear = true;
          for (const n of this.sharks) {
            if (n.layer !== LAYER_NEAR) continue;
            const ncx = n.nodes[0] - Math.cos(n.heading) * n.length * 0.5 + Math.cos(n.heading) * n.cruise * 4;
            const ncy = n.nodes[1] - Math.sin(n.heading) * n.length * 0.5 + Math.sin(n.heading) * n.cruise * 4;
            if (Math.hypot(ncx - cx, ncy - cy) < 300) { nearClear = false; break; }
          }
          if (!nearClear) continue;
          distantPlaced.push({ x: cx, y: cy });
          this.addShark(LAYER_DISTANT, length, x, y, heading);
          i++;
        }

        // Far motes: punctuation dust, drifting with the current.
        const count = clamp(Math.round((W * H) / 6500), 60, 260);
        for (let i = 0; i < count; i++) {
          this.particles.push({
            x: rand(0, W),
            y: rand(0, H),
            depth: rand(0.15, 1),
            phase: rand(0, TAU),
            twinkle: rand(0.2, 1.1),
            glyph: i,
            vx: rand(-3, 3),
            vy: rand(-2, 2),
          });
        }

        // v0.9 marine snow: 400-600 one-/two-pixel motes spread over the
        // whole viewport. Depth drives both the size (near = 2 px) and the
        // alpha (0.06 far -> 0.24 near), so the empty water is never blank.
        const snowCount = clamp(Math.round((W * H) / 2400), SNOW_MIN_COUNT, SNOW_MAX_COUNT);
        for (let i = 0; i < snowCount; i++) {
          const depth = rand(0.1, 1);
          this.snow.push({
            x: rand(0, W),
            y: rand(0, H),
            depth: depth,
            size: depth > 0.72 ? 2 : 1,
            alpha: SNOW_ALPHA_MIN + (SNOW_ALPHA_MAX - SNOW_ALPHA_MIN) * depth,
            vx: rand(-2.4, 2.4) * (0.4 + depth),
            vy: rand(-3.2, 3.2) * (0.4 + depth),
            phase: rand(0, TAU),
          });
        }
      }

      addShark(layer, length, x, y, heading) {
        const nodes = new Float32Array(SHARK_NODES * 2);
        const seg = length / (SHARK_NODES - 1);
        for (let n = 0; n < SHARK_NODES; n++) {
          nodes[n * 2] = x - Math.cos(heading) * seg * n;
          nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
        }
        const cruise = DEPTH_LAYERS[layer].speed;
        this.sharks.push({
          id: this.nextId++,
          layer: layer,
          length: length,
          nodes: nodes,
          heading: heading,
          baseHeading: heading,
          speed: cruise,
          cruise: cruise * rand(0.9, 1.1),
          phase: rand(0, TAU),
          wanderPhase: rand(0, TAU),
          wanderFreq: rand(0.18, 0.32),
          turn: 0,
          spook: 0,
          spookFrom: null,
          // v0.11: every shark owns a small hue offset so neighbouring fish
          // never share exactly the same blue.
          tint: rand(-1, 1),
        });
      }

      /**
       * Click on the water: three concentric neon rings leave the pointer at
       * 0 / 0.19 / 0.38 s. Nearby sharks spook and the motes scatter. At most
       * 12 rings live at once; older ones are dropped so a click storm cannot
       * grow without bound.
       */
      ripple(x, y) {
        const now = this.time;
        const size = rand(180, 290);
        const seed = rand(0, TAU);
        for (let k = 0; k < 3; k++) {
          this.ripples.push({
            x: x,
            y: y,
            born: now + k * 0.19,
            life: 2.1 + k * 0.16,
            radius: size * (1 - k * 0.12),
            seed: seed + k * 0.65,
          });
        }
        if (this.ripples.length > 12) {
          this.ripples.splice(0, this.ripples.length - 12);
        }
        for (const sh of this.sharks) {
          if (this.distanceToSpine(sh, x, y) < sh.length * 0.24) {
            sh.spook = 1;
            sh.spookFrom = { x: x, y: y };
          }
        }
        for (const p of this.particles) {
          const dx = p.x - x;
          const dy = p.y - y;
          const d = Math.hypot(dx, dy);
          if (d > 160 || d < 1e-3) continue;
          const w = Math.pow(1 - d / 160, 2) * 26;
          p.x += (dx / d) * w;
          p.y += (dy / d) * w;
        }
      }

      distanceToSpine(sh, x, y) {
        let best = Infinity;
        for (let k = 0; k < SHARK_NODES - 1; k++) {
          const ax = sh.nodes[k * 2];
          const ay = sh.nodes[k * 2 + 1];
          const sx = sh.nodes[(k + 1) * 2] - ax;
          const sy = sh.nodes[(k + 1) * 2 + 1] - ay;
          const len2 = sx * sx + sy * sy || 1;
          const u = clamp(((x - ax) * sx + (y - ay) * sy) / len2, 0, 1);
          const d = Math.hypot(x - (ax + sx * u), y - (ay + sy * u));
          if (d < best) best = d;
        }
        return best;
      }

      step(dt) {
        this.time += dt;
        this.stepSharks(dt);
        this.stepParticles(dt);
        this.stepSnow(dt);
        if (this.ripples.length) {
          this.ripples = this.ripples.filter((r) => this.time - r.born < r.life);
        }
      }

      stepSharks(dt) {
        const W = this.width;
        const H = this.height;
        for (const sh of this.sharks) {
          const L = sh.length;
          const t = this.time;

          sh.wanderPhase += dt * sh.wanderFreq;
          const weave = Math.sin(sh.wanderPhase) * 0.34 + Math.sin(sh.wanderPhase * 0.53 + sh.id) * 0.16;
          let desired = sh.baseHeading + weave;
          // Fish read best near horizontal: damp the vertical component.
          const flat = Math.round(desired / Math.PI) * Math.PI;
          desired = lerp(desired, flat, 0.35);

          const hx = sh.nodes[0];
          const hy = sh.nodes[1];
          const margin = L * 0.55 + 60;
          const overX = hx < margin ? 1 - hx / margin : hx > W - margin ? 1 - (W - hx) / margin : 0;
          const overY = hy < margin ? 1 - hy / margin : hy > H - margin ? 1 - (H - hy) / margin : 0;
          if (overX > 0) {
            const inward = hx < W * 0.5 ? 0 : Math.PI;
            desired = lerp(desired, inward, clamp(overX, 0, 1) * 0.85);
          }
          if (overY > 0) {
            const inward = hy < H * 0.5 ? 0.5 : -0.5;
            const currentDir = Math.cos(sh.heading) >= 0 ? 0 : Math.PI;
            desired = lerp(desired, currentDir + inward, clamp(overY, 0, 1) * 0.8);
          }
          if (sh.spook > 0 && sh.spookFrom) {
            const away = Math.atan2(hy - sh.spookFrom.y, hx - sh.spookFrom.x);
            desired = lerp(desired, away, sh.spook * 0.75);
            sh.spook = Math.max(0, sh.spook - dt * 1.2);
          }

          const turnLimit = (0.4 + 20 / L) * dt;
          const turn = clamp(angleDiff(sh.heading, desired), -turnLimit, turnLimit);
          sh.heading += turn;
          sh.turn += (turn / Math.max(dt, 1e-4) - sh.turn) * Math.min(1, dt * 2);

          const cruise = sh.cruise * (1 + 0.12 * Math.sin(t * 0.9 + sh.id * 1.7));
          sh.speed += (cruise - sh.speed) * Math.min(1, dt * 0.8);

          sh.phase += dt * (1.4 + sh.speed / 26);
          sh.nodes[0] += Math.cos(sh.heading) * sh.speed * dt;
          sh.nodes[1] += Math.sin(sh.heading) * sh.speed * dt;

          const seg = L / (SHARK_NODES - 1);
          const maxBend = 0.13;
          let prevAngle = sh.heading + Math.PI;
          for (let k = 1; k < SHARK_NODES; k++) {
            const px = sh.nodes[(k - 1) * 2];
            const py = sh.nodes[(k - 1) * 2 + 1];
            let angle = Math.atan2(sh.nodes[k * 2 + 1] - py, sh.nodes[k * 2] - px);
            angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
            sh.nodes[k * 2] = px + Math.cos(angle) * seg;
            sh.nodes[k * 2 + 1] = py + Math.sin(angle) * seg;
            prevAngle = angle;
          }

          // Re-enter from the far side once the whole body has left.
          const out = Math.max(-hx, hx - W, -hy, hy - H);
          if (out > L * 1.5) {
            const fromLeft = hx < 0;
            sh.nodes[1] = rand(H * 0.15, H * 0.85);
            sh.nodes[0] = fromLeft ? W + L * 0.7 : -L * 0.7;
            const heading = fromLeft ? Math.PI + rand(-0.25, 0.25) : rand(-0.25, 0.25);
            sh.heading = heading;
            sh.baseHeading = heading;
            sh.speed = sh.cruise;
            for (let k = 1; k < SHARK_NODES; k++) {
              sh.nodes[k * 2] = sh.nodes[0] - Math.cos(heading) * seg * k;
              sh.nodes[k * 2 + 1] = sh.nodes[1] - Math.sin(heading) * seg * k;
            }
          }
        }
      }

      stepParticles(dt) {
        const W = this.width;
        const H = this.height;
        const drift = this.tmp;
        for (const p of this.particles) {
          current(p.x, p.y, this.time, drift);
          p.x += (drift.x * 0.35 * p.depth + p.vx) * dt;
          p.y += (drift.y * 0.35 * p.depth + p.vy) * dt;
          if (p.x < -8) p.x = W + 8;
          else if (p.x > W + 8) p.x = -8;
          if (p.y < -8) p.y = H + 8;
          else if (p.y > H + 8) p.y = -8;
        }
      }

      /**
       * Marine snow drift. Every mote rides the same divergence-free current
       * as the dust, plus its own slow velocity and a small downward drift;
       * near motes (high depth) move up to twice as fast as far ones.
       */
      stepSnow(dt) {
        const W = this.width;
        const H = this.height;
        const drift = this.tmp;
        for (const p of this.snow) {
          current(p.x, p.y, this.time, drift);
          const near = 0.35 + 0.65 * p.depth;
          p.x += (drift.x * 0.22 + p.vx + Math.sin(this.time * 0.2 + p.phase) * 1.6) * near * dt;
          p.y += (drift.y * 0.22 + p.vy + 3.2 * p.depth) * near * dt;
          if (p.x < -2) p.x = W + 2;
          else if (p.x > W + 2) p.x = -2;
          if (p.y < -2) p.y = H + 2;
          else if (p.y > H + 2) p.y = -2;
        }
      }
    }

    // ------------------------------------------------------------ renderer

    const FLAG_NONE = 0;
    const FLAG_BODY = 1;
    const FLAG_FIN = 2;

    // The matrix is a grid, not a fill: cells stay dark and only the glyphs
    // and a 1-device-pixel low-alpha border are drawn. V2 can add a very dark
    // cell base through settings.cellBase; the default (0) leaves cells empty.
    const DEFAULT_BORDER_ALPHA = 0.05;

    // v0.9 LED matrix. Every covered cell is a dark tile framed by a bright
    // 1-device-pixel stroke; the letter inside fades with the skin shade.
    // Fill L 24-48, stroke L 110-220 in 16 levels, letters L 120-220 in 16.
    const LED_FILL_BASE = 24;
    const LED_FILL_RANGE = 24;
    const LED_FILL_TIERS = 13; // 24, 26 ... 48
    const LED_STROKE_BASE = 110;
    const LED_STROKE_RANGE = 110;
    const LED_STROKE_TIERS = 16; // 110, 117.3 ... 220
    const LED_LETTER_BASE = 120;
    const LED_LETTER_RANGE = 100;
    const LED_LETTER_TIERS = 16; // 120, 126.7 ... 220
    const LED_MIN_CONTRAST = LED_STROKE_BASE - (LED_FILL_BASE + LED_FILL_RANGE);

    // Marine snow: 1-2 px motes over the full viewport.
    const SNOW_ALPHA_MIN = 0.025;
    const SNOW_ALPHA_MAX = 0.13;
    const SNOW_MIN_COUNT = 70;
    const SNOW_MAX_COUNT = 400;

    // v0.10 neon quantisation: the halo, bloom, inner line and letter glow
    // each use 8 alpha steps, so one canvas call paints a whole level.
    const LED_GLOW_TIERS = 8;

    // Bucket tables. Fill, stroke and letters are quantised so that one
    // canvas call paints every cell of a level.
    const BASE_BUCKETS = LED_FILL_TIERS;
    const GLOW_BUCKETS = LED_LETTER_TIERS;
    const GLOW_GREY = 205;

    /**
     * Public settings. The panel exposes exactly four of these (speed,
     * density, depth, paused) and persists them under this key. The rest are
     * internal renderer defaults that presets may still override.
     */
    const STORAGE_KEY = "dsh-deepseek-ocean/settings/v2";

    const DEFAULT_SETTINGS = {
      // v0.10: deep navy water (#04060c). The blue neon lattice and the cold
      // snow are the only light in the frame.
      background: "#0a101e",
      // Neon strength: 0 = A (restrained), 1 = B (strong). Every other
      // parameter is shared, so the two tiers are directly comparable.
      glow: 0,
      ink: 1.6,
      grid: 0.035,
      cellSize: 0,
      density: 0.6,
      depth: 0.85,
      // fog drives the top haze + far-layer mist, tech the instrument layer.
      fog: 1,
      tech: 0,
      // V1 (default): border alpha 0.05, no cell base. V2 preset: 0.09 / 12.
      borderAlpha: DEFAULT_BORDER_ALPHA,
      cellBase: 0,
      speed: 1,
      paused: false,
      heroOpacity: 1,
      // F5: the transcript is the scrim, so the field sits lower than the
      // hero value while the glass tokens stay translucent.
      idleOpacity: 0.45,
      // v0.13: ASCII cell size multiplier (larger = fewer, bigger glyphs).
      charScale: 1.6,
      // v0.13: overall field opacity multiplier (applies to hero and chat).
      opacity: 1,
      species: "shark",
    };

    /** Read the four persisted controls, clamped to their live ranges. */
    function readSettings() {
      const settings = Object.assign({}, DEFAULT_SETTINGS);
      try {
        const raw = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved && typeof saved === "object") {
            const speed = Number(saved.speed);
            const density = Number(saved.density);
            const depth = Number(saved.depth);
            if (Number.isFinite(speed)) settings.speed = clamp(speed, 0.25, 2.5);
            if (Number.isFinite(density)) settings.density = clamp(density, 0, 1);
            else if (Number.isFinite(Number(saved.dust))) settings.density = clamp(Number(saved.dust), 0, 1);
            if (Number.isFinite(depth)) settings.depth = clamp(depth, 0, 1);
            // v0.12: the fifth control persists the session opacity.
            const idle = Number(saved.idleOpacity);
            if (Number.isFinite(idle)) settings.idleOpacity = clamp(idle, 0.1, 0.8);
            const charScale = Number(saved.charScale);
            if (Number.isFinite(charScale)) settings.charScale = clamp(charScale, 0.8, 2.6);
            const fieldOpacity = Number(saved.opacity);
            if (Number.isFinite(fieldOpacity)) settings.opacity = clamp(fieldOpacity, 0.05, 1);
            const fog = Number(saved.fog);
            const tech = Number(saved.tech);
            if (Number.isFinite(fog)) settings.fog = clamp(fog, 0, 1);
            if (Number.isFinite(tech)) settings.tech = clamp(tech, 0, 1);
            settings.paused = saved.paused === true;
          }
        }
      } catch (err) {
        /* storage is optional */
      }
      return settings;
    }

    /**
     * Persist the panel's four controls plus the two keyboard-only layers
     * (fog and tech), so a reload keeps the chosen atmosphere.
     */
    function writeSettings(settings) {
      try {
        if (!window.localStorage) return;
        const speed = Number(settings.speed);
        const density = Number(settings.density);
        const depth = Number(settings.depth);
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            speed: Number.isFinite(speed) ? clamp(speed, 0.25, 2.5) : DEFAULT_SETTINGS.speed,
            density: Number.isFinite(density) ? clamp(density, 0, 1) : DEFAULT_SETTINGS.density,
            depth: Number.isFinite(depth) ? clamp(depth, 0, 1) : DEFAULT_SETTINGS.depth,
            idleOpacity: Number.isFinite(Number(settings.idleOpacity))
              ? clamp(Number(settings.idleOpacity), 0.1, 0.8)
              : DEFAULT_SETTINGS.idleOpacity,
            charScale: Number.isFinite(Number(settings.charScale))
              ? clamp(Number(settings.charScale), 0.8, 2.6)
              : DEFAULT_SETTINGS.charScale,
            opacity: Number.isFinite(Number(settings.opacity))
              ? clamp(Number(settings.opacity), 0.05, 1)
              : DEFAULT_SETTINGS.opacity,
            fog: Number.isFinite(Number(settings.fog)) ? clamp(Number(settings.fog), 0, 1) : DEFAULT_SETTINGS.fog,
            tech: Number.isFinite(Number(settings.tech)) ? clamp(Number(settings.tech), 0, 1) : DEFAULT_SETTINGS.tech,
            paused: settings.paused === true,
          })
        );
      } catch (err) {
        /* storage is optional */
      }
    }

    class AsciiRenderer {
      constructor(canvas) {
        this.canvas = canvas;
        const ctx = canvas.getContext("2d", { alpha: true });
        if (!ctx) throw new Error("2D canvas unavailable");
        this.ctx = ctx;
        this.dpr = 1;
        this.width = 0;
        this.height = 0;
        this.cw = 12;
        this.ch = 18;
        this.cols = 0;
        this.rows = 0;
        this.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        this.settings = readSettings();
        this.world = null;
        this.ink = 1.6;
        this.bgGray = 6;
        this.bgRgb = NEON.water.slice();
        this.bgStyle = rgbCss(NEON.water);
        this.gridStyle = rgbCss(NEON.grid, 0.05);
        this.glow = 0;
        this.glowAlpha = 0.2;
        this.glowWidth = 2;
        this.bloomWidth = 4;
        this.bloomAlpha = 0.05;
        this.dustDensity = 0.6;
        this.depth = 0.85;
        this.fog = 1;
        this.tech = 0.35;
        this.clock = 0;
        this.eyeCell = -1;
        this.borderAlpha = DEFAULT_BORDER_ALPHA;
        this.cellBase = 0;
        this.baseBuckets = [];
        this.glowBuckets = [];
        // v0.9 quantisation buckets. Their lengths are fixed, so they are
        // allocated once instead of on every resize.
        this.strokeBuckets = [];
        this.letterBuckets = [];
        this.bloomBuckets = [];
        this.haloBuckets = [];
        this.lineBuckets = [];
        this.letterGlowBuckets = [];
        this.snowBuckets = [];
        for (let i = 0; i < LED_STROKE_TIERS; i++) this.strokeBuckets.push([]);
        for (let i = 0; i < LED_LETTER_TIERS; i++) this.letterBuckets.push([]);
        for (let i = 0; i < LED_GLOW_TIERS; i++) {
          this.bloomBuckets.push([]);
          this.haloBuckets.push([]);
          this.lineBuckets.push([]);
          this.letterGlowBuckets.push([]);
        }
        for (let i = 0; i < 10; i++) this.snowBuckets.push([]);
        // v0.11 ASCII painting buckets: fill/highlight indexed by k level and
        // hue tint, glyphs additionally by ramp tier.
        this.paintFillBuckets = [];
        this.paintGlyphBuckets = [];
        this.paintHlBuckets = [];
        for (let i = 0; i < PAINT_K_LEVELS * PAINT_TINTS; i++) {
          this.paintFillBuckets.push([]);
          this.paintHlBuckets.push([]);
        }
        for (let i = 0; i < ASCII_RAMP.length * PAINT_TINTS; i++) this.paintGlyphBuckets.push([]);
        // The deepsk letters survive as the very top highlight accent (the
        // contract allows letters as one of the highlight characters).
        this.paintLetterBuckets = [];
        for (let i = 0; i < PAINT_TINTS; i++) this.paintLetterBuckets.push([]);
        this.paintTable = [];
        this.dField = new Float32Array(0);
        // Per-cell hue jitter (-1..1) copied from the shark that stamped it:
        // every fish gets a slightly different blue (about +-8 degrees).
        this.tintField = new Float32Array(0);
        this.depthGradient = null;
        this.fogHaze = null;
        this.topGlow = null;
        this.vignette = null;
        this.topFade = null;
        this.bottomFade = null;

        this.cellCount = 0;
        this.cov = new Float32Array(0);
        this.inkField = new Float32Array(0);
        this.tmpCov = new Float32Array(0);
        this.tmpInk = new Float32Array(0);
        this.flagField = new Uint8Array(0);
        this.keyField = new Uint32Array(0);
        this.nxField = new Float32Array(0);
        this.nyField = new Float32Array(0);
        this.sField = new Float32Array(0);

        const segs = SHARK_NODES - 1;
        this.spine = new Float32Array(SHARK_NODES * 2);
        this.segAx = new Float32Array(segs);
        this.segAy = new Float32Array(segs);
        this.segDx = new Float32Array(segs);
        this.segDy = new Float32Array(segs);
        this.segLen = new Float32Array(segs);
        this.segInvLen2 = new Float32Array(segs);
        this.segArc = new Float32Array(segs);
        this.arcTotal = 1;
        this.activeLength = 1;
        this.finTris = new Float32Array(FINS.length * 6);
        this.activeUpSign = -1;
        this.activeShark = null;
        this.activeLayer = LAYER_NEAR;
        this.bbox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        this.hit = {
          sd: -1,
          flag: FLAG_NONE,
          shade: 0,
          nx: 0,
          ny: 0,
          s: 0,
        };
        this.applyPalette();
      }

      /** Rebuild every string derived from the settings (runs on each tweak). */
      applyPalette() {
        const s = this.settings;
        this.ink = clamp(Number(s.ink) || 1.6, 0.2, 2.2);
        // The water keeps its configured RGB (deep navy), not a luma grey.
        const bg = parseHex(s.background) || NEON.water;
        this.bgRgb = bg;
        this.bgGray = Math.round(0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]);
        this.bgStyle = rgbCss(bg);
        this.gridStyle = rgbCss(NEON.grid, clamp(Number(s.grid) || 0, 0, 0.2));
        // Two neon tiers: 0 = A (restrained), 1 = B (strong). The inner line
        // is unchanged; only the halo and its width move.
        const glow = Number(s.glow);
        this.glow = clamp(Number.isFinite(glow) ? glow : 0, 0, 1);
        this.glowAlpha = 0.2 + 0.1 * this.glow; // 0.20 (A) / 0.30 (B)
        this.glowWidth = 2 + 0.5 * this.glow; // 2.0 px (A) / 2.5 px (B)
        this.bloomWidth = 4 + 3 * this.glow; // 4 px (A) / 7 px (B)
        this.bloomAlpha = 0.05 + 0.07 * this.glow; // 0.05 (A) / 0.12 (B)
        this.midWidth = (this.bloomWidth + this.glowWidth) / 2;

        // v0.12: the depth slider now drives the far layers' brightness as
        // well as their blur, and the density slider scales the mid layer
        // continuously. 0.5 is neutral: gain = 1.4 - 0.5 * 0.8 = 1.0.
        const depthNow = clamp(Number.isFinite(Number(s.depth)) ? Number(s.depth) : 0.85, 0, 1);
        const densityNow = clamp(Number.isFinite(Number(s.density)) ? Number(s.density) : 0.6, 0, 1);
        this.depth = depthNow;
        this.dustDensity = densityNow;
        const depthGain = clamp(1.4 - depthNow * 0.8, 0.6, 1.4);
        this.depthGain = depthGain;

        // v0.11 paint tables: per layer, per shade level, per hue tint. The
        // strings are cached here so drawFields only does table lookups.
        this.paintTable = [];
        for (let li = 0; li < DEPTH_LAYERS.length; li++) {
          const gain = paintLayerGain(li);
          const far = li === LAYER_MID || li === LAYER_DISTANT;
          const slider = far ? depthGain : 1;
          const densityGain = li === LAYER_MID ? 0.4 + 0.6 * densityNow : 1;
          const layerDepth = gain.depth * slider * densityGain;
          const inkStops = [];
          const fillStops = [];
          const hlStops = [];
          const glowStops = [];
          for (let ki = 0; ki < PAINT_K_LEVELS; ki++) {
            const kk = ki / (PAINT_K_LEVELS - 1);
            for (let ti = 0; ti < PAINT_TINTS; ti++) {
              const tint = (ti / (PAINT_TINTS - 1)) * 2 - 1;
              const rgb = paintColor(kk, layerDepth, gain.cool, tint);
              fillStops.push(rgbCss(mixRgb(bg, rgb, 0.3)));
              hlStops.push(rgbCss(rgb, 0.22));
              glowStops.push(rgbCss(rgb, 0.07));
            }
          }
          for (let tier = 0; tier < ASCII_RAMP.length; tier++) {
            const kk = tier / (ASCII_RAMP.length - 1);
            for (let ti = 0; ti < PAINT_TINTS; ti++) {
              const tint = (ti / (PAINT_TINTS - 1)) * 2 - 1;
              inkStops.push(rgbCss(paintColor(kk, layerDepth, gain.cool, tint)));
            }
          }
          this.paintTable.push({ ink: inkStops, fill: fillStops, hl: hlStops, glow: glowStops });
        }
        const fog = Number(s.fog);
        this.fog = clamp(Number.isFinite(fog) ? fog : 1, 0, 1);
        const tech = Number(s.tech);
        this.tech = clamp(Number.isFinite(tech) ? tech : 0.35, 0, 1);
        const borderAlpha = Number(s.borderAlpha);
        this.borderAlpha = clamp(Number.isFinite(borderAlpha) ? borderAlpha : DEFAULT_BORDER_ALPHA, 0.02, 0.1);
        const cellBase = Number(s.cellBase);
        this.cellBase = clamp(Number.isFinite(cellBase) ? cellBase : 0, 0, 24);
        const density = Number(s.density);
        this.dustDensity = clamp(Number.isFinite(density) ? density : 0.6, 0, 1);
        const depth = Number(s.depth);
        this.depth = clamp(Number.isFinite(depth) ? depth : 0.85, 0, 1);
        this.rebuildGradients();
      }

      /**
       * Visual weight of the depth slider. 0.55 is neutral (the tuned look);
       * lower flattens the far/mid layers, higher pushes them back with more
       * blur and less body contrast. Near and fog are deliberately untouched.
       */
      layerDepthGain(index) {
        if (index === LAYER_NEAR || index === LAYER_FOG) return 1;
        // 0.5 is neutral. Lower depth flattens the field (far layers brighter,
        // sharper); higher pushes it back (dimmer, blurrier).
        return 1.4 - this.depth * 0.8;
      }

      /**
       * Density scales the mid school's ink and the motes together; 0.55 is
       * neutral. The near hero and the fog are never removed, so density 0 is
       * still a shark field, just a sparser one.
       */
      layerDensityGain(index) {
        if (index !== LAYER_MID) return 1;
        return clamp(this.dustDensity / 0.55, 0, 1.6);
      }

      updateSettings(patch) {
        const next = Object.assign({}, this.settings, patch || {});
        // "dust" was the old panel name for density; keep presets working.
        if (patch && patch.dust !== undefined && patch.density === undefined) next.density = patch.dust;
        delete next.dust;
        this.settings = next;
        this.applyPalette();
        return this.settings;
      }

      get cellWidth() {
        return this.cw;
      }

      get cellHeight() {
        return this.ch;
      }

      setFontFamily(family) {
        if (family) this.fontFamily = family;
      }

      /** Fog, glow and screen-edge gradients; rebuilt on resize. */
      rebuildGradients() {
        const w = this.width;
        const h = this.height;
        if (w < 1 || h < 1) return;
        const ctx = this.ctx;
        const bg = this.bgGray;

        // v0.10: the water sits at #04060c. The vertical gradient stays within
        // one or two levels of the base navy, so the neon lattice and the cold
        // snow carry the whole image.
        const bgRgb = this.bgRgb || NEON.water;
        const depth = ctx.createLinearGradient(0, 0, 0, h);
        depth.addColorStop(0, rgbCss([bgRgb[0] + 2, bgRgb[1] + 4, bgRgb[2] + 8]));
        depth.addColorStop(0.55, rgbCss(bgRgb));
        depth.addColorStop(1, rgbCss([Math.max(0, bgRgb[0] - 1), Math.max(0, bgRgb[1] - 2), Math.max(0, bgRgb[2] - 4)]));
        this.depthGradient = depth;

        // A whisper of blue top haze.
        const hazeAlpha = 0.008 + 0.006 * this.fog;
        const hazeFade = 0.45 + 0.2 * this.fog;
        const haze = ctx.createLinearGradient(0, 0, 0, h * hazeFade);
        haze.addColorStop(0, rgbCss([120, 170, 240], hazeAlpha));
        haze.addColorStop(1, rgbCss([120, 170, 240], 0));
        this.fogHaze = haze;

        const glow = ctx.createRadialGradient(w * 0.5, h * 0.02, 0, w * 0.5, h * 0.02, h * 0.9);
        glow.addColorStop(0, rgbCss([150, 200, 255], 0.012));
        glow.addColorStop(0.45, rgbCss([140, 190, 255], 0.006));
        glow.addColorStop(1, rgbCss([120, 170, 240], 0));
        this.topGlow = glow;

        // v0.9: no full-frame radial vignette. A radial gradient with an inner
        // radius is rasterised differently by the software preview (which
        // cannot express r0) and by Chrome, and either version dimmed a near
        // shark's stroke below the 110 contract. The water is already
        // #080b10, so the only screen-edge feather left is a short bottom
        // strip that never crosses a fish.
        this.vignette = null;
        this.topFade = null;
        this.bottomFade = ctx.createLinearGradient(0, h * 0.965, 0, h);
        this.bottomFade.addColorStop(0, rgbCss([2, 3, 7], 0));
        this.bottomFade.addColorStop(1, rgbCss([2, 3, 7], 0.35));
      }

      resize(width, height, dpr) {
        this.width = width;
        this.height = height;
        this.dpr = dpr;
        const fixed = Number(this.settings.cellSize) || 0;
        // 1440 px keeps 131 columns (cw 11). Small viewports shrink the cell
        // instead of coarsening the fish: at 400 px the sharks keep ~19 cells
        // of body length, which is what makes the thumbnail readable.
        this.cw = fixed > 0 ? clamp(Math.round(fixed), 4, 26) : clamp(Math.round(width / 131), 5, 11);
        this.ch = clamp(Math.round(this.cw * 1.55), 8, 40);
        this.cols = Math.max(1, Math.ceil(width / this.cw));
        this.rows = Math.max(1, Math.ceil(height / this.ch));
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);

        const n = this.cols * this.rows;
        this.cellCount = n;
        this.cov = new Float32Array(n);
        this.inkField = new Float32Array(n);
        this.tmpCov = new Float32Array(n);
        this.tmpInk = new Float32Array(n);
        this.flagField = new Uint8Array(n);
        this.keyField = new Uint32Array(n);
        this.nxField = new Float32Array(n);
        this.nyField = new Float32Array(n);
        this.sField = new Float32Array(n);
        this.dField = new Float32Array(n);
        this.tintField = new Float32Array(n);
        this.baseBuckets = [];
        for (let i = 0; i < BASE_BUCKETS; i++) this.baseBuckets.push([]);
        this.glowBuckets = [];
        for (let i = 0; i <= GLOW_BUCKETS; i++) this.glowBuckets.push([]);

        this.rebuildGradients();
      }

      // ------------------------------------------------------------- frame

      render(world, dt) {
        if (!this.cols || !world) return;
        const ctx = this.ctx;
        // The renderer clock drives the shimmer and the travelling wave; it
        // also advances on a frozen frame, so a paused field keeps its light.
        this.clock += Number.isFinite(dt) ? dt : 0;
        const t = this.clock;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.paintFog(t);
        this.paintGrid();
        this.paintDust(world, world.time);
        this.paintSnow(world, world.time);
        this.paintSharkLayer(world, LAYER_DISTANT, t);
        this.paintSharkLayer(world, LAYER_MID, t);
        this.paintSharkLayer(world, LAYER_NEAR, t);
        this.paintRipples(world, world.time);
        this.paintVignette();
        // v0.7: global breathing is only an overall transparency (+/-1.5%);
        // the fish themselves carry the centre-outward radial breathing.
        const gb = Math.sin(t * (TAU / 8) + 1.3);
        ctx.fillStyle = gb >= 0
          ? rgbCss([150, 200, 255], 0.0024 * gb)
          : rgbCss([2, 3, 7], 0.015 * -gb);
        ctx.fillRect(0, 0, this.width, this.height);
      }

      paintFog(t) {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        ctx.fillStyle = this.bgStyle;
        ctx.fillRect(0, 0, w, h);
        if (this.depthGradient) {
          ctx.fillStyle = this.depthGradient;
          ctx.fillRect(0, 0, w, h);
        }
        if (this.fogHaze) {
          ctx.fillStyle = this.fogHaze;
          ctx.fillRect(0, 0, w, h * (0.45 + 0.2 * this.fog));
        }
        if (this.topGlow) {
          ctx.fillStyle = this.topGlow;
          ctx.fillRect(0, 0, w, h);
        }
        // A thin whole-frame blue veil.
        const veil = 0.003 * this.fog;
        if (veil > 0) {
          ctx.fillStyle = rgbCss([120, 170, 240], veil);
          ctx.fillRect(0, 0, w, h);
        }
        // v0.7: no screen-space directional sweep; the water is static.
        this.paintTech();
      }

      /**
       * F2: the instrument layer lives in the fog, not on top of the letters.
       * Scanlines at a 7px pitch (no 4px moire), edge ruler ticks and two
       * guide lines. Everything is multiplied by settings.tech; tech = 0
       * draws nothing at all.
       */
      paintTech() {
        const tech = this.tech;
        if (!(tech > 0)) return;
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        // B-polish: 3px scanlines at a 6px pitch, alpha capped at 0.025.
        // The lower alpha removes the screen-door feel; the finer pitch
        // keeps the layer perceptible (final vs tech0 meanAbs >= 1.5).
        const scanAlpha = Math.min(0.025, 0.075 * tech);
        ctx.fillStyle = rgbCss(NEON.tech, scanAlpha);
        for (let y = 0; y < h; y += 6) ctx.fillRect(0, y, w, 3);
        // Edge ruler ticks (max 6% alpha).
        const tickAlpha = Math.min(0.06, 0.17 * tech);
        ctx.strokeStyle = rgbCss(NEON.tech, tickAlpha);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let y = 24; y < h; y += 64) {
          ctx.moveTo(12, y);
          ctx.lineTo(12, y + 6);
          ctx.moveTo(w - 12, y);
          ctx.lineTo(w - 12, y + 6);
        }
        ctx.stroke();
        // Two section guides (max 6% alpha).
        const guideAlpha = Math.min(0.06, 0.17 * tech);
        ctx.strokeStyle = rgbCss(NEON.tech, guideAlpha);
        ctx.beginPath();
        for (let i = 1; i <= 2; i++) {
          const y = Math.round((h * i) / 3) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
        }
        ctx.stroke();
      }

      paintGrid() {
        if (!(Number(this.settings.grid) > 0)) return;
        const ctx = this.ctx;
        const cols = this.cols;
        const rows = this.rows;
        const cw = this.cw;
        const ch = this.ch;
        ctx.strokeStyle = this.gridStyle;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let c = 0; c <= cols; c++) {
          const x = Math.round(c * cw) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, rows * ch);
        }
        for (let r = 0; r <= rows; r++) {
          const y = Math.round(r * ch) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(cols * cw, y);
        }
        ctx.stroke();
      }

      /** Layer 1: punctuation dust snapped to the character grid. */
      paintDust(world, t) {
        const particles = world.particles;
        if (!particles || !particles.length) return;
        const ctx = this.ctx;
        const cw = this.cw;
        const ch = this.ch;
        const layer = DEPTH_LAYERS[LAYER_DISTANT];
        const density = this.dustDensity;
        if (density <= 0) return;
        const depthGain = this.layerDepthGain(LAYER_DISTANT);
        const densityGain = 0.35 + 1.18 * density;
        ctx.font = "500 " + Math.max(8, Math.round(ch * 0.55)) + "px " + this.fontFamily;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const limit = Math.floor(particles.length * (0.35 + 0.65 * density));
        for (let i = 0; i < limit; i++) {
          const p = particles[i];
          const twinkle = 0.55 + 0.45 * Math.sin(t * p.twinkle + p.phase);
          const alpha = clamp(layer.brightness * depthGain * densityGain * (0.34 + 0.72 * p.depth) * twinkle, 0, 1);
          if (alpha < 0.02) continue;
          const glyph = EDGE_SPARSE[p.glyph % EDGE_SPARSE.length];
          const d = clamp(p.depth, 0, 1);
          ctx.fillStyle = rgbCss(
            [Math.round(96 + 54 * d), Math.round(140 + 46 * d), Math.round(200 + 42 * d)],
            alpha
          );
          const x = Math.floor(p.x / cw) * cw + cw * 0.5;
          const y = Math.floor(p.y / ch) * ch + ch * 0.5;
          ctx.fillText(glyph, x, y + 1);
        }
      }

      /**
       * v0.9 marine snow: 1-2 device-pixel motes over the whole viewport.
       * The ten alpha buckets keep the fillStyle changes cheap; near motes
       * (depth > 0.72) are 2 px and alpha 0.24, far ones 1 px and 0.06.
       * The snow is painted under the sharks, so fish cells stay opaque.
       */
      paintSnow(world, t) {
        const snow = world.snow;
        if (!snow || !snow.length) return;
        const ctx = this.ctx;
        const dpr = this.dpr;
        const buckets = this.snowBuckets;
        for (let b = 0; b < buckets.length; b++) buckets[b].length = 0;
        const span = SNOW_ALPHA_MAX - SNOW_ALPHA_MIN;
        for (let i = 0; i < snow.length; i++) {
          const p = snow[i];
          const b = clamp(Math.round(((p.alpha - SNOW_ALPHA_MIN) / span) * 9), 0, 9);
          buckets[b].push(p);
        }
        for (let b = 0; b < buckets.length; b++) {
          const list = buckets[b];
          if (!list.length) continue;
          const alpha = SNOW_ALPHA_MIN + span * (b / 9);
          ctx.fillStyle = rgbCss(NEON.snow, alpha);
          for (let j = 0; j < list.length; j++) {
            const p = list[j];
            // Size is expressed in device pixels: 1 px far, 2 px near.
            const size = p.size / dpr;
            ctx.fillRect(Math.floor(p.x), Math.floor(p.y), size, size);
          }
        }
      }

      // -------------------------------------------- shark rasterisation

      /** Rasterise one depth layer, blur its field and paint it. */
      paintSharkLayer(world, layerIndex, t) {
        const sharks = world.sharks;
        // v0.12: density is continuous. The far school fades in one fish at a
        // time; there is no binary on/off switch any more.
        let quota = Infinity;
        if (layerIndex === LAYER_DISTANT) {
          let total = 0;
          for (let i = 0; i < sharks.length; i++) if (sharks[i].layer === LAYER_DISTANT) total++;
          quota = total > 0 ? clamp(Math.round(1 + this.dustDensity * (total - 1)), 1, total) : 0;
        }
        let any = false;
        let index = 0;
        this.clearFields();
        for (let i = 0; i < sharks.length; i++) {
          const sh = sharks[i];
          if (sh.layer !== layerIndex) continue;
          if (layerIndex === LAYER_DISTANT) {
            if (index >= quota) break;
            index++;
          }
          this.stampShark(sh, layerIndex, t);
          any = true;
        }
        if (!any) return;
        // The depth slider drives the blur too: 0 / 0.5 / 1 give 0 / 1 / 2
        // blur passes for the distant layer (0 / 2 / 3 for the mid one).
        const blurScale = layerIndex === LAYER_NEAR ? 0 : this.depth * 3;
        const passes = blurPassesFor(DEPTH_LAYERS[layerIndex].blurPx * blurScale);
        for (let i = 0; i < passes; i++) this.blurFields();
        this.drawFields(layerIndex, t);
      }

      clearFields() {
        this.cov.fill(0);
        this.inkField.fill(0);
        this.flagField.fill(0);
        this.keyField.fill(0);
        this.nxField.fill(0);
        this.nyField.fill(0);
        this.dField.fill(0);
        this.tintField.fill(0);
      }

      blurFields() {
        const cols = this.cols;
        const rows = this.rows;
        const cov = this.cov;
        const ink = this.inkField;
        const tc = this.tmpCov;
        const ti = this.tmpInk;
        for (let r = 0; r < rows; r++) {
          const row = r * cols;
          for (let c = 0; c < cols; c++) {
            const i = row + c;
            const l = c > 0 ? i - 1 : i;
            const rr = c < cols - 1 ? i + 1 : i;
            const u = r > 0 ? i - cols : i;
            const d = r < rows - 1 ? i + cols : i;
            tc[i] = (cov[i] * 4 + cov[l] + cov[rr] + cov[u] + cov[d]) * 0.125;
            ti[i] = (ink[i] * 4 + ink[l] + ink[rr] + ink[u] + ink[d]) * 0.125;
          }
        }
        this.cov = tc;
        this.inkField = ti;
        this.tmpCov = cov;
        this.tmpInk = ink;
      }

      /** Bending spine, segment table and bounds for one shark. */
      prepareSpine(sh, layerIndex, t) {
        const nodes = sh.nodes;
        const N = SHARK_NODES;
        const spine = this.spine;
        const L = sh.length;
        const swim = clamp(sh.speed / 40, 0.5, 1.6);
        for (let k = 0; k < N; k++) {
          const s = k / (N - 1);
          const a = Math.max(0, k - 1);
          const b = Math.min(N - 1, k + 1);
          let tx = nodes[a * 2] - nodes[b * 2];
          let ty = nodes[a * 2 + 1] - nodes[b * 2 + 1];
          const tl = Math.hypot(tx, ty) || 1;
          tx /= tl;
          ty /= tl;
          const amp = L * 0.045 * (0.12 + 0.88 * Math.pow(s, 1.6)) * swim;
          const off = amp * Math.sin(sh.phase - s * 5.2);
          spine[k * 2] = nodes[k * 2] - ty * off;
          spine[k * 2 + 1] = nodes[k * 2 + 1] + tx * off;
        }

        let arc = 0;
        for (let k = 0; k < N - 1; k++) {
          const ax = spine[k * 2];
          const ay = spine[k * 2 + 1];
          const dx = spine[(k + 1) * 2] - ax;
          const dy = spine[(k + 1) * 2 + 1] - ay;
          const len = Math.hypot(dx, dy) || 1e-3;
          this.segAx[k] = ax;
          this.segAy[k] = ay;
          this.segDx[k] = dx;
          this.segDy[k] = dy;
          this.segLen[k] = len;
          this.segInvLen2[k] = 1 / (len * len);
          this.segArc[k] = arc;
          arc += len;
        }
        this.arcTotal = arc || 1;
        this.activeLength = L;
        this.activeShark = sh;
        this.activeLayer = layerIndex;
        // The spine runs head -> tail, so its tangent is opposite the heading.
        // upSign turns the signed normal distance into a coordinate where
        // positive is always the shark's back (screen-up side).
        const tx0 = this.segDx[0];
        this.activeUpSign =
          Math.abs(tx0) > 0.15 ? (tx0 > 0 ? -1 : 1) : Math.cos(sh.heading) >= 0 ? -1 : 1;

        // Exactly one eye cell: a hole in the letter field that tells the
        // head from the tail. Only the near layer is large enough to read.
        this.eyeCell = -1;
        if (layerIndex === LAYER_NEAR) {
          const eyeS = 0.08;
          const target = eyeS * this.arcTotal;
          let eyeK = 0;
          while (eyeK < N - 2 && this.segArc[eyeK + 1] < target) eyeK++;
          const eyeU = clamp((target - this.segArc[eyeK]) / (this.segLen[eyeK] || 1), 0, 1);
          const ex = this.segAx[eyeK] + this.segDx[eyeK] * eyeU;
          const ey = this.segAy[eyeK] + this.segDy[eyeK] * eyeU;
          const enx = -this.segDy[eyeK] / this.segLen[eyeK];
          const eny = this.segDx[eyeK] / this.segLen[eyeK];
          const eyeW = bodyHalfWidth(eyeS) * L;
          const px = ex + enx * this.activeUpSign * 0.55 * eyeW;
          const py = ey + eny * this.activeUpSign * 0.55 * eyeW;
          const col = Math.floor(px / this.cw);
          const row = Math.floor(py / this.ch);
          if (col >= 0 && row >= 0 && col < this.cols && row < this.rows) {
            this.eyeCell = row * this.cols + col;
          }
        }

        // Bake each fin triangle into world space once per frame. Testing
        // body-local (u, v) directly aliases near the tail and paints a halo,
        // so the fins are tested exactly where they are drawn.
        const tris = this.finTris;
        for (let f = 0; f < FINS.length; f++) {
          for (let vtx = 0; vtx < 3; vtx++) {
            const fu = FINS[f][vtx][0];
            const fv = FINS[f][vtx][1];
            const target = clamp(fu, 0, 1) * this.arcTotal;
            let fk = 0;
            while (fk < N - 2 && this.segArc[fk + 1] < target) fk++;
            const fu2 = clamp((target - this.segArc[fk]) / (this.segLen[fk] || 1), 0, 1);
            const qx = this.segAx[fk] + this.segDx[fk] * fu2;
            const qy = this.segAy[fk] + this.segDy[fk] * fu2;
            const fnx = -this.segDy[fk] / this.segLen[fk];
            const fny = this.segDx[fk] / this.segLen[fk];
            const off = fv * L * this.activeUpSign;
            const o = f * 6 + vtx * 2;
            tris[o] = qx + fnx * off;
            tris[o + 1] = qy + fny * off;
          }
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let k = 0; k < N; k++) {
          minX = Math.min(minX, spine[k * 2]);
          maxX = Math.max(maxX, spine[k * 2]);
          minY = Math.min(minY, spine[k * 2 + 1]);
          maxY = Math.max(maxY, spine[k * 2 + 1]);
        }
        const reach = L * 0.3 + Math.hypot(this.cw, this.ch);
        this.bbox.minX = minX - reach;
        this.bbox.maxX = maxX + reach;
        this.bbox.minY = minY - reach;
        this.bbox.maxY = maxY + reach;
      }

      /** Signed distance to the union of the world-space fin triangles. */
      finSd(px, py) {
        const tris = this.finTris;
        let best = -Infinity;
        let bestI = 0;
        for (let i = 0; i < tris.length; i += 6) {
          const d = triangleSd(px, py, tris[i], tris[i + 1], tris[i + 2], tris[i + 3], tris[i + 4], tris[i + 5]);
          if (d > best) { best = d; bestI = i; }
        }
        this.finBest = bestI / 6;
        return best;
      }

      /** Coverage plus shading for one cell centre. Reuses this.hit. */
      sampleShape(px, py) {
        const hit = this.hit;
        const n = SHARK_NODES - 1;
        const axs = this.segAx;
        const ays = this.segAy;
        const dxs = this.segDx;
        const dys = this.segDy;
        const invs = this.segInvLen2;
        let best = Infinity;
        let bestK = 0;
        let bestU = 0;
        for (let k = 0; k < n; k++) {
          const dx = px - axs[k];
          const dy = py - ays[k];
          const u = clamp((dx * dxs[k] + dy * dys[k]) * invs[k], 0, 1);
          const qx = dx - dxs[k] * u;
          const qy = dy - dys[k] * u;
          const d2 = qx * qx + qy * qy;
          if (d2 < best) {
            best = d2;
            bestK = k;
            bestU = u;
          }
        }

        const L = this.activeLength;
        const segLen = this.segLen[bestK];
        const s = clamp((this.segArc[bestK] + segLen * bestU) / this.arcTotal, 0, 1);
        const dist = Math.sqrt(best);
        const along = s * L;

        const qx = axs[bestK] + dxs[bestK] * bestU;
        const qy = ays[bestK] + dys[bestK] * bestU;
        let nx = -dys[bestK] / segLen;
        let ny = dxs[bestK] / segLen;
        const side = (px - qx) * nx + (py - qy) * ny;
        // side is already the signed distance (the unit normal times the
        // residual), so only its sign is needed here.
        const sideSign = side >= 0 ? 1 : -1;
        if (side < 0) {
          nx = -nx;
          ny = -ny;
        }
        const up = sideSign * dist * this.activeUpSign;

        const halfWidth = Math.max(0.4, bodyHalfWidth(s) * L);
        let sd = halfWidth - dist;
        let flag = sd > 0 ? FLAG_BODY : FLAG_NONE;

        if (sd < 0) {
          const finSd = this.finSd(px, py);
          if (finSd > sd) {
            sd = finSd;
            flag = sd > 0 ? FLAG_FIN : FLAG_NONE;
          }
        }

        const du = (s - 0.5) * 2;
        const dv = up / halfWidth;
        hit.d = Math.hypot(du, dv);
        hit.sd = sd;
        hit.flag = flag;
        hit.s = s;
        hit.nx = nx;
        hit.ny = ny;
        hit.shade = 0;
        if (sd <= 0) return hit;

        // Round 2 keeps the skin minimal: no mouth, no gills, no teeth, no
        // scales. The only marker is the one-cell eye handled in
        // prepareSpine(), so the silhouette and its shading do the work.
        if (flag === FLAG_BODY) {
          const across = up / halfWidth;
          const u = clamp(across, -1, 1);
          const wu = Math.abs(u);
          // Round section: back-side normal at the rim, world-up along the spine.
          const nUpX = up >= 0 ? nx : -nx;
          const nUpY = up >= 0 ? ny : -ny;
          const root = Math.sqrt(Math.max(0, 1 - u * u));
          const nxu = nUpX * u;
          const nyu = nUpY * u - root;
          const norm = 1 / Math.max(0.2, Math.hypot(nxu, nyu));
          // Light falls from above and slightly from the left.
          const lit = clamp((nxu * 0.3 - nyu * 0.95) * norm, 0, 1);
          const shaped = Math.pow(lit, 1.25);
          // The belly keeps a visible floor: at thumbnail scale a black lower
          // half would erase half the silhouette against the fog.
          let shade = 0.18 + 0.72 * shaped;
          // Rim light along the back: the contour reads before the letters do.
          if (wu > 0.7 && up > 0) shade += ((wu - 0.7) / 0.3) * shaped * 0.42;
          shade *= 0.78 + 0.26 * (1 - s);
          hit.shade = clamp(shade, 0, 1);
        } else {
          const fi = this.finBest || 0;
          const f0 = FINS[fi][0];
          const f1 = FINS[fi][1];
          const f2 = FINS[fi][2];
          const baseUp = Math.min(f0[1], f2[1]);
          const tipUp = f1[1];
          const ft = clamp((up / L - baseUp) / Math.max(1e-4, tipUp - baseUp), 0, 1);
          const grain = (hash3(Math.round(along), Math.round(up), this.activeShark.id) - 0.5) * 0.06;
          const edgeHi = sd < this.cw * 0.6 ? 0.22 : 0;
          hit.shade = clamp(1 - 0.45 * ft + edgeHi + grain, 0, 1.4);
        }
        hit.flag = flag;
        return hit;
      }

      stampShark(sh, layerIndex, t) {
        this.prepareSpine(sh, layerIndex, t);
        const b = this.bbox;
        const cw = this.cw;
        const ch = this.ch;
        const cols = this.cols;
        const rows = this.rows;
        const feather = Math.hypot(cw, ch);
        const c0 = Math.max(0, Math.floor(b.minX / cw));
        const c1 = Math.min(cols - 1, Math.floor(b.maxX / cw));
        const r0 = Math.max(0, Math.floor(b.minY / ch));
        const r1 = Math.min(rows - 1, Math.floor(b.maxY / ch));
        if (c0 > c1 || r0 > r1) return;

        const cov = this.cov;
        const ink = this.inkField;
        const flags = this.flagField;
        const keys = this.keyField;
        const nxF = this.nxField;
        const nyF = this.nyField;
        const sF = this.sField;
        const dF = this.dField;
        const tf = this.tintField;
        const tint = Number.isFinite(sh.tint) ? sh.tint : 0;

        for (let r = r0; r <= r1; r++) {
          const py = r * ch + ch * 0.5;
          const row = r * cols;
          for (let c = c0; c <= c1; c++) {
            const px = c * cw + cw * 0.5;
            const hit = this.sampleShape(px, py);
            const sd = hit.sd;
            if (sd <= -feather) continue;
            const coverage = clamp(0.5 + sd / feather, 0, 1);
            if (coverage <= 0.02) continue;
            const i = row + c;
            if (layerIndex === LAYER_NEAR && i === this.eyeCell) continue;
            if (coverage <= cov[i]) continue;
            cov[i] = coverage;
            ink[i] = coverage * hit.shade;
            flags[i] = hit.flag;
            keys[i] = (hash3(c, r, sh.id) * 4294967295) >>> 0;
            nxF[i] = hit.nx;
            nyF[i] = hit.ny;
            sF[i] = hit.s;
            dF[i] = hit.d;
            tf[i] = tint;
          }
        }
      }

      /** Pick the contour punctuation for a fringe cell. */
      edgeGlyph(coverage, key, nx, ny, flag) {
        if (coverage < 0.2) return EDGE_SPARSE[key % EDGE_SPARSE.length];
        if (coverage < 0.36 || flag === FLAG_FIN) return EDGE_MID[(key >>> 3) % EDGE_MID.length];
        if (coverage < 0.55) return EDGE_DENSE[(key >>> 6) % EDGE_DENSE.length];
        const tx = -ny;
        const ty = nx;
        // Every third cell keeps a direction-aware contour glyph; the rest
        // stay dense so the silhouette survives a thumbnail downscale.
        if ((key & 3) === 0) {
          if (Math.abs(ty) > Math.abs(tx) * 1.7) return EDGE_VERTICAL;
          if (Math.abs(tx) > Math.abs(ty) * 1.7) return EDGE_HORIZONTAL;
          return tx * ty > 0 ? EDGE_BACKSLASH : EDGE_SLASH;
        }
        return EDGE_DENSE[(key >>> 6) % EDGE_DENSE.length];
      }

      /** ASCII painting: fine square samples; the simulation/field grid stays intact. */
      drawFields(layerIndex, t) {
        this.drawSharks(layerIndex, t);
      }

      /** Cache geometry in fish coordinates, so grain and highlights swim with it. */
      buildPaintSamples(sh, cell) {
        const points = [];
        const step = cell / sh.length;
        const feather = step * 0.85;
        for (let u = step * 0.5; u < 1; u += step) {
          const width = bodyHalfWidth(u);
          for (let v = -0.16; v < 0.21; v += step) {
            const bodySd = width - Math.abs(v);
            let sd = bodySd;
            for (const tri of FINS) {
              sd = Math.max(sd, triangleSd(u, v, tri[0][0], tri[0][1], tri[1][0], tri[1][1], tri[2][0], tri[2][1]));
            }
            const coverage = clamp(0.5 + sd / feather, 0, 1);
            if (coverage < 0.06) continue;
            const seed = hash3(Math.round(u / step), Math.round(v / step), sh.id);
            // Partial cells fade by density as well as colour; no bright outer frame.
            if (seed > coverage) continue;
            const body = bodySd >= 0;
            const cross = v / Math.max(width, step);
            const round = Math.sqrt(Math.max(0, 1 - cross * cross));
            const patch = 0.5 + 0.5 * Math.sin(u * 24 + v * 47 + sh.id * 1.7)
              * Math.cos(u * 13 - v * 39 + sh.id);
            const spot = Math.exp(-((u - 0.24) ** 2 / 0.012 + (v - 0.015) ** 2 / 0.0012));
            const spot2 = Math.exp(-((u - 0.64) ** 2 / 0.018 + (v + 0.008) ** 2 / 0.0009));
            let shade = body
              ? 0.13 + 0.28 * round + 0.25 * patch + 0.44 * spot + 0.24 * spot2 + cross * 0.05
              : 0.22 + 0.36 * patch + 0.16 * Math.min(1, sd / step);
            shade += (seed - 0.5) * 0.24;
            shade *= 0.32 + 0.68 * coverage;
            // A small, dark eye separates the head from the tail at desktop scale.
            if (Math.abs(u - 0.075) < step * 0.6 && Math.abs(v - width * 0.4) < step * 0.55) shade *= 0.18;
            points.push({ u, v, shade: clamp(shade, 0.035, 1), seed, coverage });
          }
        }
        // Short, dark gill slits on the forward flank help distinguish a shark.
        for (const p of points) {
          if (p.u > 0.12 && p.u < 0.23 && p.v > -0.025 && p.v < 0.025 && Math.sin(p.u * 210) > 0.35) p.shade *= 0.48;
        }
        return { length: sh.length, cell, points, candidateCount: points.length, removedCount: 0 };
      }

      /** A tiny glyph atlas avoids thousands of fillText calls per animation frame. */
      paintAtlas(cell, layerIndex, tintIndex) {
        if (!this.asciiAtlases || this.asciiAtlasCell !== cell || this.asciiAtlasDpr !== this.dpr ||
            this.asciiAtlasTables !== this.paintTable || this.asciiAtlasDepth !== this.depthGain ||
            this.asciiAtlasDensity !== this.dustDensity) {
          this.asciiAtlases = new Map();
          this.asciiAtlasCell = cell;
          this.asciiAtlasDpr = this.dpr;
          this.asciiAtlasTables = this.paintTable;
          this.asciiAtlasDepth = this.depthGain;
          this.asciiAtlasDensity = this.dustDensity;
        }
        const key = layerIndex * PAINT_TINTS + tintIndex;
        if (this.asciiAtlases.has(key)) return this.asciiAtlases.get(key);
        const glyphs = ASCII_RAMP.concat(BODY_RAMP);
        const tile = Math.ceil(cell * 1.5 * this.dpr);
        const canvas = document.createElement("canvas");
        canvas.width = tile * glyphs.length;
        canvas.height = tile * PAINT_K_LEVELS;
        const ctx = canvas.getContext("2d");
        const gain = paintLayerGain(layerIndex);
        // v0.12: the depth slider scales the far layers' brightness here too
        // (the atlas is the live paint path), and density scales the mid one.
        const far = layerIndex === LAYER_MID || layerIndex === LAYER_DISTANT;
        const depthSlider = far ? (Number.isFinite(this.depthGain) ? this.depthGain : 1) : 1;
        const densityGain = layerIndex === LAYER_MID ? 0.4 + 0.6 * this.dustDensity : 1;
        const layerDepth = gain.depth * depthSlider * densityGain;
        const tint = tintIndex / (PAINT_TINTS - 1) * 2 - 1;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "600 " + (cell * 1.2 * this.dpr) + "px " + this.fontFamily;
        const colors = [];
        for (let k = 0; k < PAINT_K_LEVELS; k++) {
          const shade = k / (PAINT_K_LEVELS - 1);
          const rgb = paintColor(shade, layerDepth, gain.cool, tint);
          colors.push(rgbCss(rgb));
          for (let g = 1; g < glyphs.length; g++) {
            const x = g * tile, y = k * tile;
            // Minimal underpaint joins tones at thumbnail scale without solid tiles.
            ctx.fillStyle = rgbCss(rgb, (cell < 4 ? 0.2 : 0.05) + shade * 0.075);
            const pad = tile * 0.2;
            ctx.fillRect(x + pad, y + pad, tile - pad * 2, tile - pad * 2);
            ctx.fillStyle = rgbCss(rgb);
            ctx.fillText(glyphs[g], x + tile * 0.5, y + tile * 0.5);
            // Only rare specular cells receive an inset hairline and faint halo.
            if (shade > 0.8) {
              ctx.strokeStyle = rgbCss(rgb, 0.13);
              ctx.lineWidth = this.dpr * 0.5;
              ctx.strokeRect(x + pad, y + pad, tile - pad * 2, tile - pad * 2);
            }
          }
        }
        const atlas = { canvas, tile, size: tile / this.dpr, glyphs, colors };
        this.asciiAtlases.set(key, atlas);
        return atlas;
      }

      /** Paint cached local samples onto the existing live, bending spine. */
      drawSharks(layerIndex, t) {
        // Direct AsciiRenderer.render(world) callers need no engine side-channel.
        // The host and preview bind this.world; standalone callers keep the fields.
        if (!this.world) return this.drawPaintFields(layerIndex);
        const ctx = this.ctx;
        // Area density scales as 1 / cell²: larger glyphs, same fish dimensions.
        const charScale = clamp(Number(this.settings.charScale) || 1.6, 0.8, 2.6);
        const cell = (clamp(this.width / 210, 3, 7) / Math.sqrt(0.8)) * charScale;
        if (!this.asciiSamples) this.asciiSamples = new WeakMap();
        // v0.12: the far school fades in one fish at a time, so density is a
        // continuous count and not an on/off switch.
        let quota = Infinity;
        let seen = 0;
        if (layerIndex === LAYER_DISTANT) {
          let total = 0;
          for (const sh of this.world.sharks) if (sh.layer === LAYER_DISTANT) total++;
          quota = total > 0 ? clamp(Math.round(1 + this.dustDensity * (total - 1)), 1, total) : 0;
        }
        for (const sh of this.world.sharks) {
          if (sh.layer !== layerIndex) continue;
          if (layerIndex === LAYER_DISTANT) {
            if (seen >= quota) break;
            seen++;
          }
          let samples = this.asciiSamples.get(sh);
          if (!samples || samples.length !== sh.length || samples.cell !== cell) {
            samples = this.buildPaintSamples(sh, cell);
            this.asciiSamples.set(sh, samples);
          }
          this.prepareSpine(sh, layerIndex, t);
          const tintIndex = clamp(Math.round(((sh.tint || 0) + 1) * 0.5 * (PAINT_TINTS - 1)), 0, PAINT_TINTS - 1);
          const atlas = this.paintAtlas(cell, layerIndex, tintIndex);
          const tile = atlas.tile, size = atlas.size;
          const software = typeof atlas.canvas.toDataURL !== "function";
          if (software) {
            ctx.font = "600 " + (cell * 1.2) + "px " + this.fontFamily;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
          }
          const shimmer = Math.sin(t * 1.7 + sh.id) * 0.025;
          for (const p of samples.points) {
            const target = p.u * this.arcTotal;
            let seg = 0;
            while (seg < SHARK_NODES - 2 && this.segArc[seg + 1] < target) seg++;
            const f = clamp((target - this.segArc[seg]) / this.segLen[seg], 0, 1);
            const off = p.v * sh.length * this.activeUpSign / this.segLen[seg];
            const x = this.segAx[seg] + this.segDx[seg] * f - this.segDy[seg] * off;
            const y = this.segAy[seg] + this.segDy[seg] * f + this.segDx[seg] * off;
            if (x < -size || x > this.width + size || y < -size || y > this.height + size) continue;
            const pulse = Math.max(0, Math.sin(t * 1.4 - p.u * 8 + sh.id)) ** 8 * 0.055;
            const k = clamp(p.shade + shimmer + pulse + (cell < 4 ? 0.08 : 0), 0, 1);
            const ki = Math.round(k * (PAINT_K_LEVELS - 1));
            let glyph = Math.max(1, Math.round(k * (ASCII_RAMP.length - 1)));
            if (k > 0.84 && p.seed > 0.72) glyph = ASCII_RAMP.length + Math.floor(p.seed * 97) % BODY_RAMP.length;
            if (software) {
              ctx.fillStyle = atlas.colors[ki];
              ctx.fillText(atlas.glyphs[glyph], Math.round(x), Math.round(y));
            } else {
              ctx.drawImage(atlas.canvas, glyph * tile, ki * tile, tile, tile, Math.round(x - size * 0.5), Math.round(y - size * 0.5), size, size);
            }
          }
        }
      }

      /** Standalone renderer fallback using its public raster fields. */
      drawPaintFields(layerIndex) {
        const ctx = this.ctx;
        const table = this.paintTable[layerIndex];
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "600 " + Math.min(11, this.cw * 1.1) + "px " + this.fontFamily;
        for (let i = 0; i < this.cov.length; i++) {
          const coverage = this.cov[i];
          if (coverage < 0.06) continue;
          const k = clamp(this.inkField[i] / coverage, 0, 1) * Math.min(1, coverage * 1.4);
          const tier = Math.max(1, Math.round(k * (ASCII_RAMP.length - 1)));
          const tint = clamp(Math.round((this.tintField[i] + 1) * 0.5 * (PAINT_TINTS - 1)), 0, PAINT_TINTS - 1);
          ctx.fillStyle = table.ink[tier * PAINT_TINTS + tint];
          ctx.fillText(ASCII_RAMP[tier], (i % this.cols + 0.5) * this.cw, (Math.floor(i / this.cols) + 0.5) * this.ch);
        }
      }


      /** Soft, irregular wavelets with a smooth attack and a long dissipating tail. */
      paintRipples(world, t) {
        const ctx = this.ctx;
        ctx.lineCap = "round";
        for (const r of world.ripples || []) {
          const age = t - r.born;
          if (age <= 0 || age >= r.life) continue;
          const p = age / r.life;
          const attack = 1 - Math.exp(-age * 16);
          const fade = attack * Math.pow(1 - p, 1.8);
          if (fade < 0.006) continue;
          const radius = r.radius * (1 - Math.exp(-p * 2.5)) / (1 - Math.exp(-2.5));
          const driftX = Math.sin(r.seed) * age * 3;
          const driftY = Math.cos(r.seed * 1.3) * age * 1.5;
          // Short overlapping arcs have unequal brightness, rather than a hard neon ellipse.
          for (let arc = 0; arc < 24; arc++) {
            const a0 = arc / 24 * TAU;
            const strength = 0.32 + 0.68 * (0.5 + 0.5 * Math.sin(a0 * 3 + r.seed + age * 0.7));
            for (let pass = 0; pass < 3; pass++) {
              ctx.lineWidth = [9, 4, 0.9][pass];
              ctx.strokeStyle = rgbCss([65, 123, 213], fade * strength * [0.014, 0.035, 0.17][pass]);
              ctx.beginPath();
              for (let j = 0; j <= 6; j++) {
                const a = a0 + (j / 6) * TAU / 24;
                const wobble = Math.sin(a * 3 + r.seed + age * 0.8) * (1.1 + p * 2.1)
                  + Math.sin(a * 7 - age * 1.2 + r.seed) * 0.7;
                const rad = Math.max(0, radius + wobble * Math.min(1, age * 8));
                const x = r.x + driftX + Math.cos(a) * rad;
                const y = r.y + driftY + Math.sin(a) * rad * 0.88;
                if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
              }
              ctx.stroke();
            }
          }
          // A feathered band of punctuation, not rectangular grid flashes.
          const step = Math.max(8, this.cw);
          const band = 9 + p * 9;
          ctx.font = "500 " + Math.max(7, step * 0.8) + "px " + this.fontFamily;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const x0 = Math.max(0, Math.floor((r.x - radius - band) / step));
          const x1 = Math.min(Math.ceil(this.width / step), Math.ceil((r.x + radius + band) / step));
          const y0 = Math.max(0, Math.floor((r.y - radius - band) / step));
          const y1 = Math.min(Math.ceil(this.height / step), Math.ceil((r.y + radius + band) / step));
          for (let row = y0; row <= y1; row++) {
            for (let col = x0; col <= x1; col++) {
              const key = hash3(col, row, Math.floor(r.seed * 100));
              if (key > 0.24) continue;
              const x = col * step, y = row * step;
              const dx = x - r.x - driftX, dy = (y - r.y - driftY) / 0.88;
              const dist = Math.hypot(dx, dy) - radius;
              if (Math.abs(dist) > band * 2) continue;
              const weight = Math.exp(-dist * dist / (band * band * 0.65));
              ctx.fillStyle = rgbCss([100, 164, 239], fade * weight * (0.13 + key * 0.3));
              ctx.fillText(key < 0.08 ? "." : key < 0.17 ? ":" : "+", x + Math.sin(age * 3 + key * 12) * weight * 1.8, y - weight * Math.sin(age * 4 + key * 9));
            }
          }
        }
        ctx.lineCap = "butt";
      }

      /** Feathered screen edges: the canvas melts into the host chrome. */
      paintVignette() {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        if (this.vignette) {
          ctx.fillStyle = this.vignette;
          ctx.fillRect(0, 0, w, h);
        }
        if (this.topFade) {
          ctx.fillStyle = this.topFade;
          ctx.fillRect(0, 0, w, h * 0.2);
        }
        if (this.bottomFade) {
          ctx.fillStyle = this.bottomFade;
          ctx.fillRect(0, h * 0.82, w, h * 0.18);
        }
      }
    }

    // -------------------------------------------------------------- engine

    const STEP = 1 / 60;
    const MAX_STEPS = 4;

    class OceanEngine {
      constructor(canvas, options) {
        const opts = options || {};
        this.canvas = canvas;
        this.world = new World(opts.sharks);
        this.renderer = new AsciiRenderer(canvas);
        this.probe = opts.heroProbe || null;
        this.raf = 0;
        this.last = 0;
        this.acc = 0;
        this.opacity = opts.fadeIn === false ? 1 : 0;
        this.paintedOpacity = -1;
        this.settings = this.renderer.settings;
        this.paused = this.settings.paused === true;
        this.disposed = false;
        this.reduced =
          typeof window !== "undefined" && window.matchMedia
            ? window.matchMedia("(prefers-reduced-motion: reduce)")
            : { matches: false };
        this.resizeObserver =
          typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
        if (this.resizeObserver) this.resizeObserver.observe(canvas);
        this.onMotionPreference = () => {
          if (this.reduced.matches) {
            cancelAnimationFrame(this.raf);
            this.drawStill();
          } else {
            this.schedule();
          }
        };
        if (this.reduced.addEventListener) this.reduced.addEventListener("change", this.onMotionPreference);
        this.rafStep = (now) => this.tick(now);
      }

      start() {
        this.resize();
        this.bindPointer();
        if (this.paused || this.reduced.matches) {
          // A persisted pause (or reduced motion) must still show the field;
          // the fade-in driver is not running, so paint at its final opacity.
          this.opacity = this.stillOpacity();
          this.canvas.style.opacity = String(this.opacity);
          this.paintedOpacity = Math.round(this.opacity * 100) / 100;
          this.drawStill();
        } else {
          this.canvas.style.opacity = String(this.opacity);
          this.paintedOpacity = Math.round(this.opacity * 100) / 100;
          this.schedule();
        }
        return this;
      }

      /** Canvas opacity for a frozen frame. */
      stillOpacity() {
        const hero = Number(this.settings.heroOpacity);
        const idle = Number(this.settings.idleOpacity);
        const mult = clamp(Number(this.settings.opacity) || 1, 0.05, 1);
        const base = this.heroActive()
          ? (Number.isFinite(hero) ? hero : 1)
          : (Number.isFinite(idle) ? idle : 0.6);
        return clamp(base * mult, 0, 1);
      }

      /** Speed slider; 1 is the tuned cruise. */
      speedFactor() {
        const value = Number(this.settings.speed);
        return Number.isFinite(value) ? clamp(value, 0.25, 2.5) : 1;
      }

      /** Host controls keep their clicks; the water takes the rest. */
      isInteractive(target) {
        if (!target || typeof target.closest !== "function") return false;
        const selector =
          'button, a, input, textarea, select, option, label, summary, [contenteditable=""],' +
          '[contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"],' +
          '[role="slider"], [role="switch"], [role="checkbox"], [data-dsh-deep-ocean-tuner]';
        return target.closest(selector) !== null;
      }

      bindPointer() {
        this.onPointerDown = (event) => {
          if (event.button !== 0 || this.isInteractive(event.target)) return;
          const rect = this.canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
          this.world.ripple(x, y);
          if (this.reduced.matches) {
            this.renderer.world = this.world;
            this.drawStill();
          }
        };
        this.onPointerMove = (event) => {
          const rect = this.canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
          const p = this.world.pointer;
          p.x = x;
          p.y = y;
          p.active = inside && event.pointerType !== "touch" && !this.isInteractive(event.target);
        };
        window.addEventListener("pointerdown", this.onPointerDown, true);
        window.addEventListener("pointermove", this.onPointerMove, { passive: true });
      }

      destroy() {
        this.disposed = true;
        cancelAnimationFrame(this.raf);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.reduced.removeEventListener) this.reduced.removeEventListener("change", this.onMotionPreference);
        if (this.onPointerDown) window.removeEventListener("pointerdown", this.onPointerDown, true);
        if (this.onPointerMove) window.removeEventListener("pointermove", this.onPointerMove);
      }

      resize() {
        const rect = this.canvas.getBoundingClientRect();
        const width = rect.width || this.canvas.clientWidth;
        const height = rect.height || this.canvas.clientHeight;
        if (width < 1 || height < 1) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer.resize(width, height, dpr);
        this.world.resize(width, height, this.renderer.cellWidth, this.renderer.cellHeight);
        if (this.reduced.matches || this.paused) this.drawStill();
      }

      /** Apply a settings patch live: palette, grid, cell size, pause, speed. */
      setSettings(patch) {
        const before = Number(this.settings.cellSize) || 0;
        const wasPaused = this.paused;
        this.settings = this.renderer.updateSettings(patch);
        const after = Number(this.settings.cellSize) || 0;
        this.paused = this.settings.paused === true;
        if (before !== after) this.resize();
        this.paintedOpacity = -1;
        // The opacity slider must take effect even while the field is frozen
        // (paused) or before the next animation frame.
        if (patch && (patch.idleOpacity !== undefined || patch.opacity !== undefined)) {
          const mult = clamp(Number(this.settings.opacity) || 1, 0.05, 1);
          const baseTarget = this.heroActive()
            ? Number(this.settings.heroOpacity)
            : Number(this.settings.idleOpacity);
          const target = clamp(baseTarget * mult, 0, 1);
          if (Number.isFinite(target)) {
            this.opacity = target;
            const rounded = Math.round(target * 100) / 100;
            this.canvas.style.opacity = String(rounded);
            this.paintedOpacity = rounded;
          }
        }
        if (this.paused !== wasPaused) {
          this.acc = 0;
          if (this.paused) {
            cancelAnimationFrame(this.raf);
            this.raf = 0;
          } else if (!this.reduced.matches) {
            this.schedule();
          }
        }
        if (this.paused) {
          // Sliders must still redraw while the field is frozen.
          this.renderer.world = this.world;
          this.renderer.render(this.world, STEP);
        }
        return this.settings;
      }

      /** True while the New Session hero owns the composer. */
      heroActive() {
        const el = this.probe;
        if (!el || !el.closest) return true;
        try {
          const doc = el.ownerDocument || document;
          // A rendered chat turn is the ground truth: any turn means the
          // transcript is active, so the field drops to the idle opacity.
          if (doc.querySelector('[data-chat-turn]')) return false;
          // No turns yet: the new-session hero (or an empty session).
          if (el.closest('[class*="_composerHero"], [class*="composerHero" i]')) return true;
          if (doc.querySelector('[data-conversation-session]')) return true;
          return true;
        } catch (err) {
          return true;
        }
      }

      schedule() {
        cancelAnimationFrame(this.raf);
        if (this.disposed || this.paused || this.reduced.matches) return;
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.rafStep);
      }

      tick(now) {
        if (this.disposed || this.paused) return;
        const dt = Math.min(0.1, (now - this.last) / 1000);
        this.last = now;
        this.acc += dt;
        const speed = this.speedFactor();
        let steps = 0;
        while (this.acc >= STEP && steps < MAX_STEPS) {
          this.world.step(STEP * speed);
          this.acc -= STEP;
          steps++;
        }
        if (steps === MAX_STEPS) this.acc = 0;

        // Full strength on the hero, a whisper behind an active transcript.
        const heroTarget = Number(this.settings.heroOpacity);
        const idleTarget = Number(this.settings.idleOpacity);
        const mult = clamp(Number(this.settings.opacity) || 1, 0.05, 1);
        const baseTarget = this.heroActive()
          ? (Number.isFinite(heroTarget) ? heroTarget : 1)
          : (Number.isFinite(idleTarget) ? idleTarget : 0.6);
        const target = clamp(baseTarget * mult, 0, 1);
        this.opacity += (target - this.opacity) * Math.min(1, dt * 3);
        const rounded = Math.round(this.opacity * 100) / 100;
        if (rounded !== this.paintedOpacity) {
          this.paintedOpacity = rounded;
          this.canvas.style.opacity = String(rounded);
        }

        this.renderer.world = this.world;
        this.renderer.render(this.world, dt);
        this.raf = requestAnimationFrame(this.rafStep);
      }

      drawStill() {
        const speed = this.speedFactor();
        if (this.world.time < 4) {
          for (let i = 0; i < 240; i++) this.world.step(STEP * speed);
        }
        this.renderer.world = this.world;
        this.renderer.render(this.world, STEP);
      }
    }

    // ------------------------------------------------------ browser side

    const CANVAS_ID = "dsh-deep-ocean-canvas";
    const GLASS_STYLE_ID = "dsh-deep-ocean-glass";

    /**
     * Shell background tokens, re-declared as the same theme colour with alpha.
     * Keeping the original static palette as the source preserves hue and the
     * light/dark luminance order, while the alpha lets the shark field show
     * through every surface. "!important" protects the glass from third-party
     * themes that also set these aliases.
     *
     * Dark and light are selected with the same body[data-ds-dark-theme]
     * selector the DSH theme uses. The dark palette is the primary target; the
     * light values are deliberately denser so dark text keeps its contrast.
     */
    const GLASS_CSS = [
      "/* dsh-deep-ocean: full-window glass surfaces */",
      "/* Let the (opaque) body colour propagate to the document canvas, so the",
      "   fixed backdrop paints above it and below the app shell. */",
      "html { background: transparent !important; }",
      "html body {",
      "  --dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00, #fff) 80%, transparent) !important;",
      "  --dsw-alias-bg-document-preview: color-mix(in srgb, var(--dsw-static-neutral-bluish-100, #ebeef2) 82%, transparent) !important;",
      "  --dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00, #fff) 84%, transparent) !important;",
      "  --dsw-alias-bg-layer-2: color-mix(in srgb, var(--dsw-static-neutral-bluish-00, #fff) 87%, transparent) !important;",
      "  --dsw-alias-bg-layer-3: color-mix(in srgb, var(--dsw-static-neutral-bluish-00, #fff) 89%, transparent) !important;",
      "  --dsw-alias-bg-module-platform: color-mix(in srgb, var(--dsw-static-neutral-bluish-60, #f5f6f7) 68%, transparent) !important;",
      "  --dsw-alias-bg-multi-select: color-mix(in srgb, var(--dsw-static-neutral-bluish-60, #f5f6f7) 70%, transparent) !important;",
      "  --dsw-alias-bg-overlay: color-mix(in srgb, var(--dsw-static-neutral-bluish-150, #e9ecf2) 94%, transparent) !important;",
      "  --dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50, #f9fafb) 56%, transparent) !important;",
      "  --dsw-specific-menu: color-mix(in srgb, var(--dsw-static-neutral-bluish-00, #fff) 90%, transparent) !important;",
      "  --dsw-menu-surface-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-00, #fff) 88%, transparent) !important;",
      "  /* The body colour is the root behind the canvas. Keeping it opaque stops",
      "     the translucent token from washing the ocean out through its own alpha. */",
      "  background-color: #fff !important;",
      "}",
      "html body[data-ds-dark-theme],",
      "html[data-ds-dark-theme] body {",
      "  --dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-950, #151517) 20%, transparent) !important;",
      "  --dsw-alias-bg-document-preview: color-mix(in srgb, var(--dsw-static-neutral-bluish-950, #151517) 44%, transparent) !important;",
      "  --dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-875, #232324) 32%, transparent) !important;",
      "  --dsw-alias-bg-layer-2: color-mix(in srgb, var(--dsw-static-neutral-bluish-850, #2c2c2e) 82%, transparent) !important;",
      "  --dsw-alias-bg-layer-3: color-mix(in srgb, var(--dsw-static-neutral-bluish-800, #353638) 86%, transparent) !important;",
      "  --dsw-alias-bg-module-platform: color-mix(in srgb, var(--dsw-static-neutral-bluish-850, #2c2c2e) 64%, transparent) !important;",
      "  --dsw-alias-bg-multi-select: color-mix(in srgb, var(--dsw-static-neutral-bluish-850, #2c2c2e) 70%, transparent) !important;",
      "  --dsw-alias-bg-overlay: color-mix(in srgb, var(--dsw-static-neutral-bluish-800, #353638) 92%, transparent) !important;",
      "  --dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-900, #1b1b1c) 24%, transparent) !important;",
      "  --dsw-specific-menu: color-mix(in srgb, var(--dsw-static-neutral-bluish-850, #2c2c2e) 78%, transparent) !important;",
      "  --dsw-menu-surface-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-850, #2c2c2e) 78%, transparent) !important;",
      "  background-color: #050607 !important;",
      "}",
      "/* Frosting for real dialogs only: role/aria-modal never match the app shell. */",
      "html body [role='dialog'], html body [role='alertdialog'], html body [aria-modal='true'] {",
      "  -webkit-backdrop-filter: blur(18px) saturate(1.08) !important;",
      "  backdrop-filter: blur(18px) saturate(1.08) !important;",
      "}",

    ].join("\n");

    let activeBackdrop = null;

    /**
     * Mount one viewport-sized canvas directly under <body>. It is fixed and
     * negative-index, so it paints above the document canvas (the propagated
     * body background) and below the app's positioned shell. All shell colours
     * stay theme-owned; the only mutation is the injected token stylesheet.
     */
    function mountFullWindowBackdrop(options) {
      if (typeof document === "undefined" || !document.body) return null;
      const opts = options || {};

      // React StrictMode, HMR and plugin reloads must never stack backdrops.
      if (activeBackdrop) activeBackdrop.destroy();
      const orphanCanvas = document.getElementById(CANVAS_ID);
      if (orphanCanvas) orphanCanvas.remove();
      const orphanStyle = document.getElementById(GLASS_STYLE_ID);
      if (orphanStyle) orphanStyle.remove();

      const style = document.createElement("style");
      style.id = GLASS_STYLE_ID;
      style.setAttribute("data-dsh-deep-ocean-style", "");
      style.textContent = GLASS_CSS;
      (document.head || document.documentElement).appendChild(style);

      const canvas = document.createElement("canvas");
      canvas.id = CANVAS_ID;
      canvas.setAttribute("aria-hidden", "true");
      canvas.setAttribute("data-dsh-deep-ocean", "canvas");
      canvas.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;display:block;" +
        "z-index:-1;pointer-events:none;opacity:0;";
      document.body.insertBefore(canvas, document.body.firstChild);

      let engine = null;
      let tuner = null;
      let destroyed = false;
      try {
        engine = new OceanEngine(canvas, {
          heroProbe: opts.heroProbe || null,
          fadeIn: opts.fadeIn,
        });
        engine.start();
        tuner = createTuner(engine);
        document.body.appendChild(tuner.el);
        tuner.place();
      } catch (err) {
        if (engine) engine.destroy();
        if (tuner) tuner.destroy();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        if (style.parentNode) style.parentNode.removeChild(style);
        throw err;
      }

      const handle = {
        canvas: canvas,
        style: style,
        engine: engine,
        tuner: tuner,
        destroy() {
          if (destroyed) return;
          destroyed = true;
          if (activeBackdrop === handle) activeBackdrop = null;
          engine.destroy();
          tuner.destroy();
          if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
          if (style.parentNode) style.parentNode.removeChild(style);
        },
      };
      activeBackdrop = handle;
      return handle;
    }

    // --------------------------------------------------------- tuner panel

    /**
     * Small corner panel that edits the settings live and persists them in
     * localStorage. Plain DOM on purpose: it must not re-render React.
     */
    function createTuner(engine) {
      const el = document.createElement("div");
      el.setAttribute("data-dsh-deep-ocean-tuner", "");
      el.style.cssText =
        "position:fixed;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;" +
        "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cfd4da;";

      const gear = document.createElement("button");
      gear.type = "button";
      gear.textContent = "//";
      gear.title = "深海设置 (O)";
      gear.setAttribute("aria-label", "深海设置");
      gear.setAttribute("aria-expanded", "false");
      gear.setAttribute("data-action", "toggle");
      gear.style.cssText =
        "width:30px;height:30px;border-radius:999px;border:1px solid rgba(220,224,230,.28);" +
        "background:rgba(10,12,14,.6);color:#e6e9ec;cursor:pointer;font-size:11px;line-height:1;" +
        "opacity:.4;transition:opacity .18s ease;padding:0;";

      const panel = document.createElement("div");
      panel.setAttribute("data-dsh-deep-ocean-panel", "");
      panel.style.cssText =
        "display:none;width:268px;box-sizing:border-box;padding:12px 12px 10px;border-radius:12px;" +
        "border:1px solid rgba(220,224,230,.2);background:rgba(8,9,11,.94);" +
        "box-shadow:0 14px 36px rgba(0,0,0,.5);backdrop-filter:blur(10px);";

      const title = document.createElement("div");
      title.textContent = "深海";
      title.style.cssText = "font-weight:600;letter-spacing:.08em;color:#f0f2f4;margin-bottom:8px;";

      const inputs = [];
      const row = (labelText, control, valueEl) => {
        const line = document.createElement("label");
        line.style.cssText = "display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;";
        const name = document.createElement("span");
        name.textContent = labelText;
        name.style.cssText = "color:#9aa0a6;flex:none;width:52px;";
        control.style.flex = "1";
        line.append(name, control);
        if (valueEl) {
          valueEl.style.cssText = "flex:none;width:38px;text-align:right;color:#cfd4da;font-variant-numeric:tabular-nums;";
          line.append(valueEl);
        }
        panel.appendChild(line);
        return line;
      };

      const slider = (key, labelText, min, max, step, format) => {
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.setAttribute("data-setting", key);
        input.setAttribute("aria-label", labelText);
        input.style.cssText = "min-width:0;accent-color:#c8ccd1;height:16px;";
        const valueEl = document.createElement("span");
        input.addEventListener("input", () => {
          const value = Number(input.value);
          const patch = {};
          patch[key] = value;
          engine.setSettings(patch);
          writeSettings(engine.settings);
          valueEl.textContent = format(value);
        });
        inputs.push({ input, key, format, valueEl });
        row(labelText, input, valueEl);
      };

      slider("speed", "速度", 0.25, 2.5, 0.05, (value) => value.toFixed(2) + "x");
      slider("density", "密度", 0, 1, 0.01, (value) => Math.round(value * 100) + "%");
      slider("charScale", "字符大小", 0.8, 2.6, 0.05, (value) => value.toFixed(2) + "×");
      slider("depth", "景深", 0, 1, 0.01, (value) => Math.round(value * 100) + "%");
      // v0.13: fifth control — overall field opacity (hero and chat).
      slider("opacity", "透明度", 0.05, 1, 0.01, (value) => Math.round(value * 100) + "%");

      // Pause is a checkbox rather than a fourth slider: it is a mode, not a
      // continuous value, and it keeps the panel at four controls total.
      const pause = document.createElement("input");
      pause.type = "checkbox";
      pause.setAttribute("data-setting", "paused");
      pause.setAttribute("aria-label", "暂停");
      pause.style.cssText = "flex:none;width:16px;height:16px;margin:0;accent-color:#c8ccd1;cursor:pointer;";
      const pauseValue = document.createElement("span");
      row("暂停", pause, pauseValue);
      pause.style.flex = "none";
      pauseValue.style.marginLeft = "auto";

      const footer = document.createElement("div");
      footer.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "恢复默认";
      reset.setAttribute("data-action", "reset");
      reset.style.cssText =
        "border:1px solid rgba(220,224,230,.26);background:transparent;color:#9aa0a6;border-radius:6px;" +
        "padding:3px 8px;font:inherit;cursor:pointer;";
      reset.addEventListener("click", () => {
        engine.setSettings(Object.assign({}, DEFAULT_SETTINGS));
        writeSettings(engine.settings);
        sync();
      });
      const hint = document.createElement("span");
      hint.textContent = "O 开关 · Esc 关闭 · T 科技";
      hint.style.cssText = "color:#5c6066;font-size:11px;";
      footer.append(reset, hint);

      panel.append(footer);
      panel.prepend(title);

      const sync = () => {
        const s = engine.settings;
        for (const { input, key, format, valueEl } of inputs) {
          const raw = Number(s[key]);
          const value = Number.isFinite(raw) ? raw : 0;
          input.value = String(value);
          valueEl.textContent = format(value);
        }
        pause.checked = s.paused === true;
        pauseValue.textContent = pause.checked ? "开" : "关";
      };

      pause.addEventListener("change", () => {
        engine.setSettings({ paused: pause.checked });
        writeSettings(engine.settings);
        pauseValue.textContent = pause.checked ? "开" : "关";
      });

      let open = false;
      const setOpen = (next) => {
        open = next;
        panel.style.display = open ? "block" : "none";
        gear.style.opacity = open ? "1" : ".4";
        gear.textContent = open ? "x" : "//";
        gear.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) sync();
      };

      gear.addEventListener("click", () => setOpen(!open));
      gear.addEventListener("mouseenter", () => {
        gear.style.opacity = "1";
      });
      gear.addEventListener("mouseleave", () => {
        if (!open) gear.style.opacity = ".4";
      });

      const isTypingTarget = (target) => {
        if (!target || !target.tagName) return false;
        if (target.isContentEditable) return true;
        const tag = target.tagName.toLowerCase();
        if (tag === "textarea" || tag === "select") return true;
        if (tag === "input") {
          const type = (target.type || "text").toLowerCase();
          return ["text", "search", "email", "url", "tel", "password", "number", "date", "time"].indexOf(type) >= 0;
        }
        return false;
      };

      const onKey = (event) => {
        if (event.key === "Escape") {
          if (!open) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          return;
        }
        if ((event.key === "o" || event.key === "O") && !event.repeat &&
            !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (isTypingTarget(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(!open);
          return;
        }
        // T toggles the instrument layer without adding a fifth control.
        if ((event.key === "t" || event.key === "T") && !event.repeat &&
            !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (isTypingTarget(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
          const next = Number(engine.settings.tech) > 0 ? 0 : 0.35;
          engine.setSettings({ tech: next });
          writeSettings(engine.settings);
        }
      };
      window.addEventListener("keydown", onKey, true);

      el.append(panel, gear);
      sync();

      return {
        el,
        /** Fixed viewport corner: the backdrop no longer follows a column. */
        place() {
          el.style.right = "18px";
          el.style.bottom = "18px";
        },
        destroy() {
          window.removeEventListener("keydown", onKey, true);
          el.remove();
        },
      };
    }

    function apply(ctx) {
      const react = require("react");
      const useEffect = react.useEffect;
      const useRef = react.useRef;

      function OceanBackdrop() {
        const anchor = useRef(null);

        useEffect(() => {
          const node = anchor.current;
          const handle = mountFullWindowBackdrop({ heroProbe: node });
          return () => {
            if (handle) handle.destroy();
          };
        }, []);

        return react.createElement("span", {
          ref: anchor,
          "data-dsh-deep-ocean-anchor": "",
          style: { display: "none" },
        });
      }

      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          { name: "conversation.input.dock", id: "deep-ocean", order: 30 },
          OceanBackdrop,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.OceanEngine = OceanEngine;
    exports.World = World;
    exports.AsciiRenderer = AsciiRenderer;
    /** Full-window lifecycle, also used by the UI fixture and visual review. */
    exports.mountFullWindowBackdrop = mountFullWindowBackdrop;
    exports.GLASS_STYLE_ID = GLASS_STYLE_ID;
    exports.GLASS_CSS = GLASS_CSS;
    /** Inspection hooks for previews, tests and visual review. */
    exports.DEPTH_LAYERS = DEPTH_LAYERS;
    exports.GLYPH_TABLE = Object.freeze({
      bodyRamp: BODY_RAMP.slice(),
      bodyLetters: BODY_LETTERS,
      edgeSparse: EDGE_SPARSE.slice(),
      edgeMid: EDGE_MID.slice(),
      edgeDense: EDGE_DENSE.slice(),
      edgeDirectional: [EDGE_VERTICAL, EDGE_HORIZONTAL, EDGE_SLASH, EDGE_BACKSLASH],
    });
    exports.PRESETS = {
      default: {},
      mono: { background: "#0c0e12", grid: 0.036, ink: 1.5, dust: 0.6 },
    };
    /** Settings contract for tests and the visual review. */
    exports.STORAGE_KEY = STORAGE_KEY;
    exports.DEFAULT_SETTINGS = Object.freeze(Object.assign({}, DEFAULT_SETTINGS));
    /** v0.9 LED matrix contract, exported for tests and the visual review. */
    exports.LED_MATRIX = Object.freeze({
      fillMin: LED_FILL_BASE,
      fillMax: LED_FILL_BASE + LED_FILL_RANGE,
      fillTiers: LED_FILL_TIERS,
      strokeBase: LED_STROKE_BASE,
      strokeRange: LED_STROKE_RANGE,
      strokeTiers: LED_STROKE_TIERS,
      strokeMax: LED_STROKE_BASE + LED_STROKE_RANGE,
      minContrast: LED_MIN_CONTRAST,
      letterMin: LED_LETTER_BASE,
      letterMax: LED_LETTER_BASE + LED_LETTER_RANGE,
      letterTiers: LED_LETTER_TIERS,
      strokeDevicePx: 1,
      breathRate: 2.1,
      breathRingsPerBody: 2.35,
      background: DEFAULT_SETTINGS.background,
    });
    /** v0.10 blue neon contract: palette and the two glow tiers. */
    exports.NEON = Object.freeze({
      water: NEON.water.slice(),
      fillLow: NEON.fillLow.slice(),
      fillHigh: NEON.fillHigh.slice(),
      halo: NEON.glow.slice(),
      line: NEON.line.slice(),
      letter: NEON.letter.slice(),
      snow: NEON.snow.slice(),
      tierA: { glow: 0, haloAlpha: 0.2, haloWidth: 2, bloomWidth: 4, bloomAlpha: 0.05 },
      tierB: { glow: 1, haloAlpha: 0.3, haloWidth: 2.5, bloomWidth: 6, bloomAlpha: 0.1 },
      innerLineAlpha: [0.45, 0.85],
      letterGlowPx: 2,
      glowTiers: LED_GLOW_TIERS,
    });
    /** v0.9 marine snow contract: 1-2 px motes, alpha 0.06-0.24. */
    exports.MARINE_SNOW = Object.freeze({
      minCount: SNOW_MIN_COUNT,
      maxCount: SNOW_MAX_COUNT,
      sizeMin: 1,
      sizeMax: 2,
      alphaMin: SNOW_ALPHA_MIN,
      alphaMax: SNOW_ALPHA_MAX,
    });
    /** Round-2 tuning contract, exported for tests and the visual review. */
    exports.FINAL_LOOK = Object.freeze({
      bodyPeakHalfWidth: 0.082,
      bodyPeakS: 0.29,
      bodyAspect: +(1 / (2 * 0.082)).toFixed(2),
      finHeightMax: 0.19,
      finSweepMin: 0.14,
      caudalTip: 0.19,
      finGroups: 3,
      finTriangles: 4,
      dorsalHeight: 0.16,
      pectoralHeight: 0.15,
      nearGlyphScale: 1.12,
      midGlyphScale: 0.84,
      nearShadeLevels: 32,
      midShadeLevels: 14,
      flickerAmplitude: 0.12,
      waveAmplitude: 0.15,
      wavePeriodS: +(TAU / 2.85).toFixed(2),
      sparkProbability: 0,
      matrixAlphaV1: DEFAULT_BORDER_ALPHA,
      matrixAlphaV2: 0.09,
      cellBaseV2: 12,
      gridColumns1440: 131,
      cellWidth1440: 11,
      bodySize1440: 10,
      fog: DEFAULT_SETTINGS.fog,
      tech: DEFAULT_SETTINGS.tech,
    });
    /** Geometry contract: body profile and fin triangles, for tests. */
    exports.SILHOUETTE = Object.freeze({
      bodyProfile: BODY_PROFILE.map((point) => [point[0], point[1]]),
      fins: FINS.map((tri) => tri.map((point) => [point[0], point[1]])),
      finRoles: FIN_ROLES.slice(),
      finGroups: 3,
      eyeCells: 1,
    });
    return module.exports;
  },
});
