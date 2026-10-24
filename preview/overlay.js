/**
 * Preview-only post-process for the A/B/C visual candidates.
 *
 * The shipped renderer owns depth, fog and the character field. This overlay
 * adds two presentation experiments that are not in lib/client.js yet:
 *
 *   grade  a very light top haze / exposure lift (A: subtle, B/C: fog)
 *   tech   scanlines, edge ticks and guide lines, every alpha <= 0.05 (C)
 *
 * Both are data-driven from window.__OCEAN_PRESET_META__ and shared by the
 * Chrome preview and the software rasterizer so the two engines stay aligned.
 * Any future renderer implementation should move these into settings (see
 * shots/t5-findings.json).
 */
(function () {
  "use strict";

  function draw(ctx, width, height, meta, options) {
    if (!meta) return;
    const opts = options || {};
    const grade = meta.grade;
    if (grade && Number(grade.top) > 0) {
      const fade = Math.max(0.05, Math.min(1, Number(grade.fade) || 0.5));
      const top = ctx.createLinearGradient(0, 0, 0, height * fade);
      top.addColorStop(0, "rgba(195,195,195," + Number(grade.top) + ")");
      top.addColorStop(1, "rgba(170,170,170,0)");
      ctx.fillStyle = top;
      ctx.fillRect(0, 0, width, height * fade);
    }
    if (grade && Number(grade.bottom) > 0) {
      const fade = Math.max(0.05, Math.min(1, Number(grade.bottomFade) || 0.25));
      const bottom = ctx.createLinearGradient(0, height * (1 - fade), 0, height);
      bottom.addColorStop(0, "rgba(160,160,160,0)");
      bottom.addColorStop(1, "rgba(160,160,160," + Number(grade.bottom) + ")");
      ctx.fillStyle = bottom;
      ctx.fillRect(0, height * (1 - fade), width, height * fade);
    }

    const tech = meta.tech;
    if (!tech || opts.tech === false) return;

    // Scanlines: one 1px line every 4px, alpha well below 5%.
    ctx.fillStyle = "rgba(190,190,190," + Math.min(0.05, Number(tech.scanline) || 0.018) + ")";
    for (let y = 0; y < height; y += 4) ctx.fillRect(0, y, width, 1);

    // Edge ticks and corner brackets.
    const tick = Math.min(0.05, Number(tech.ticks) || 0.05);
    ctx.strokeStyle = "rgba(205,205,205," + tick + ")";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 24; y < height; y += 64) {
      ctx.moveTo(12, y);
      ctx.lineTo(12, y + 6);
      ctx.moveTo(width - 12, y);
      ctx.lineTo(width - 12, y + 6);
    }
    const m = 18;
    const len = 22;
    ctx.moveTo(m, m); ctx.lineTo(m + len, m);
    ctx.moveTo(m, m); ctx.lineTo(m, m + len);
    ctx.moveTo(width - m, m); ctx.lineTo(width - m - len, m);
    ctx.moveTo(width - m, m); ctx.lineTo(width - m, m + len);
    ctx.moveTo(m, height - m); ctx.lineTo(m + len, height - m);
    ctx.moveTo(m, height - m); ctx.lineTo(m, height - m - len);
    ctx.moveTo(width - m, height - m); ctx.lineTo(width - m - len, height - m);
    ctx.moveTo(width - m, height - m); ctx.lineTo(width - m, height - m - len);
    ctx.stroke();

    // Horizontal thirds: grid breathing is animated in the live plugin; a
    // still frame shows the same guides at the same max alpha.
    const guide = Math.min(0.05, Number(tech.guides) || 0.025);
    ctx.strokeStyle = "rgba(190,190,190," + guide + ")";
    ctx.beginPath();
    for (let i = 1; i <= 2; i++) {
      const y = Math.round((height * i) / 3) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  window.__OCEAN_OVERLAY__ = { draw: draw };
})();
