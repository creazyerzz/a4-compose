/**
 * Client-side image processing (no AI / no network).
 * - Document scan (CamScanner-style) via docscan.js
 * - Clarity enhance + document shadow flatten for live filters
 */

import { scanDocument } from "./docscan.js";

function clamp(v, min = 0, max = 255) {
  return v < min ? min : v > max ? max : v;
}

function copyImageData(src) {
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function boxBlur(src, out, tmp, width, height, radius) {
  const w = width;
  const h = height;
  const r = Math.max(1, radius | 0);
  const diam = r * 2 + 1;
  const s = src.data;
  const t = tmp.data;
  const o = out.data;

  for (let y = 0; y < h; y++) {
    let rs = 0;
    let gs = 0;
    let bs = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) {
      const xi = x < 0 ? 0 : x >= w ? w - 1 : x;
      const i = (row + xi) * 4;
      rs += s[i];
      gs += s[i + 1];
      bs += s[i + 2];
    }
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4;
      t[i] = (rs / diam + 0.5) | 0;
      t[i + 1] = (gs / diam + 0.5) | 0;
      t[i + 2] = (bs / diam + 0.5) | 0;
      t[i + 3] = s[i + 3];
      const xAdd = x + r + 1;
      const xRem = x - r;
      const ia = (row + (xAdd >= w ? w - 1 : xAdd)) * 4;
      const ir = (row + (xRem < 0 ? 0 : xRem)) * 4;
      rs += s[ia] - s[ir];
      gs += s[ia + 1] - s[ir + 1];
      bs += s[ia + 2] - s[ir + 2];
    }
  }

  for (let x = 0; x < w; x++) {
    let rs = 0;
    let gs = 0;
    let bs = 0;
    for (let y = -r; y <= r; y++) {
      const yi = y < 0 ? 0 : y >= h ? h - 1 : y;
      const i = (yi * w + x) * 4;
      rs += t[i];
      gs += t[i + 1];
      bs += t[i + 2];
    }
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      o[i] = (rs / diam + 0.5) | 0;
      o[i + 1] = (gs / diam + 0.5) | 0;
      o[i + 2] = (bs / diam + 0.5) | 0;
      o[i + 3] = t[i + 3];
      const yAdd = y + r + 1;
      const yRem = y - r;
      const ia = ((yAdd >= h ? h - 1 : yAdd) * w + x) * 4;
      const ir = ((yRem < 0 ? 0 : yRem) * w + x) * 4;
      rs += t[ia] - t[ir];
      gs += t[ia + 1] - t[ir + 1];
      bs += t[ia + 2] - t[ir + 2];
    }
  }
}

function contrastStretch(data, lowPct = 2, highPct = 98) {
  const hist = new Uint32Array(256);
  let counted = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    if (data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250) continue;
    hist[(luminance(data[i], data[i + 1], data[i + 2]) + 0.5) | 0]++;
    counted++;
  }
  if (counted < 16) return;
  const lowTarget = (counted * lowPct) / 100;
  const highTarget = (counted * highPct) / 100;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= lowTarget) {
      lo = i;
      break;
    }
  }
  acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= highTarget) {
      hi = i;
      break;
    }
  }
  if (hi <= lo) return;
  const scale = 255 / (hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    if (data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250) continue;
    data[i] = clamp((data[i] - lo) * scale);
    data[i + 1] = clamp((data[i + 1] - lo) * scale);
    data[i + 2] = clamp((data[i + 2] - lo) * scale);
  }
}

function unsharpMask(src, blurred, amount) {
  const s = src.data;
  const b = blurred.data;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i + 3] < 8) continue;
    if (s[i] > 250 && s[i + 1] > 250 && s[i + 2] > 250) continue;
    s[i] = clamp(s[i] + amount * (s[i] - b[i]));
    s[i + 1] = clamp(s[i + 1] + amount * (s[i + 1] - b[i + 1]));
    s[i + 2] = clamp(s[i + 2] + amount * (s[i + 2] - b[i + 2]));
  }
}

function documentFlatten(src, bg, strength) {
  const s = src.data;
  const g = bg.data;
  const lift = 0.42 + strength * 0.32;
  const whitePush = 218 - strength * 12;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i + 3] < 8) continue;
    if (s[i] > 250 && s[i + 1] > 250 && s[i + 2] > 250) continue;
    const br = Math.max(g[i], 12);
    const bgc = Math.max(g[i + 1], 12);
    const bb = Math.max(g[i + 2], 12);
    let r = (s[i] / br) * 255;
    let gc = (s[i + 1] / bgc) * 255;
    let b = (s[i + 2] / bb) * 255;
    const lum = luminance(s[i], s[i + 1], s[i + 2]);
    // Protect dark photo / ink regions from over-bleach
    const protect = lum < 85 ? 0.35 : lum < 120 ? 0.15 : 0;
    const shadowBoost = lum < 140 ? (1 - lum / 140) * 0.22 * strength : 0;
    const mix = Math.min(0.85, lift + shadowBoost) * (1 - protect);
    r = s[i] * (1 - mix) + r * mix;
    gc = s[i + 1] * (1 - mix) + gc * mix;
    b = s[i + 2] * (1 - mix) + b * mix;
    const outLum = luminance(r, gc, b);
    if (outLum > whitePush && lum > 100) {
      const t = Math.min(0.7, (outLum - whitePush) / (255 - whitePush));
      r = r + (255 - r) * t;
      gc = gc + (255 - gc) * t;
      b = b + (255 - b) * t;
    }
    s[i] = clamp(r);
    s[i + 1] = clamp(gc);
    s[i + 2] = clamp(b);
  }
}

function midtoneContrast(data, amount) {
  const a = amount * 0.45;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    if (data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250) continue;
    for (let c = 0; c < 3; c++) {
      const x = data[i + c] / 255;
      const y = x + a * (x - 0.5) * (1 - Math.abs(x - 0.5) * 2);
      data[i + c] = clamp(y * 255);
    }
  }
}

/**
 * CamScanner-style: detect document corners → perspective warp → scan enhance.
 * Keeps interior pixels intact (no color flood-fill eating patterns).
 */
export function removeBackground(source, opts = {}) {
  let out = scanDocument(source, opts);
  if (opts.enhance === false) return out;
  const meta = out.__bgMeta || {};
  out = scanEnhance(out, opts.scanStrength ?? 0.58);
  out.__bgMeta = { ...meta, scanEnhanced: true };
  return out;
}

/**
 * Photocopy / 全能扫描王 style: flatten shadows, whiten paper, punch text.
 * @param {CanvasImageSource} source
 * @param {number} [strength] 0–1
 */
export function scanEnhance(source, strength = 0.58) {
  const s = Math.min(1, Math.max(0.3, strength));
  return processImage(source, {
    enhance: true,
    docMode: true,
    strength: Math.round(42 + s * 28),
  });
}

/**
 * @param {CanvasImageSource} source
 * @param {{ enhance?: boolean, docMode?: boolean, strength?: number }} options
 */
export function processImage(source, options = {}) {
  const enhance = !!options.enhance;
  const docMode = !!options.docMode;
  const strength = Math.min(1, Math.max(0, (options.strength ?? 60) / 100));

  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);

  if (!enhance && !docMode) return canvas;

  let img = ctx.getImageData(0, 0, width, height);
  const tmp = copyImageData(img);
  const blur = copyImageData(img);

  if (docMode) {
    // Soft CamScanner-like: lift shadows, mild white balance — keep photo/guilloche
    const radius = Math.max(12, Math.round(Math.min(width, height) * 0.06));
    boxBlur(img, blur, tmp, width, height, radius);
    documentFlatten(img, blur, Math.min(0.58, Math.max(strength * 0.7, 0.32)));
    whiteBalancePaper(img.data, 0.4);
    contrastStretch(img.data, 2, 98.5);
    midtoneContrast(img.data, 0.12 + strength * 0.15);
  }

  if (enhance) {
    const radius = Math.max(1, Math.round(1 + strength));
    boxBlur(img, blur, tmp, width, height, radius);
    unsharpMask(img, blur, 0.45 + strength * 0.55);
    if (!docMode) {
      contrastStretch(img.data, 1, 99.2);
      midtoneContrast(img.data, 0.35 + strength * 0.4);
    } else {
      boxBlur(img, blur, tmp, width, height, 1);
      unsharpMask(img, blur, 0.22 + strength * 0.2);
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Neutralize warm desk cast toward paper white. */
function whiteBalancePaper(data, amount = 0.55) {
  let rs = 0;
  let gs = 0;
  let bs = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = luminance(r, g, b);
    if (lum < 150 || lum > 245) continue;
    rs += r;
    gs += g;
    bs += b;
    n++;
  }
  if (n < 32) return;
  const mr = rs / n;
  const mg = gs / n;
  const mb = bs / n;
  const target = (mr + mg + mb) / 3;
  const kr = 1 + (target / Math.max(mr, 1) - 1) * amount;
  const kg = 1 + (target / Math.max(mg, 1) - 1) * amount;
  const kb = 1 + (target / Math.max(mb, 1) - 1) * amount;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    data[i] = clamp(data[i] * kr);
    data[i + 1] = clamp(data[i + 1] * kg);
    data[i + 2] = clamp(data[i + 2] * kb);
  }
}

/** Local contrast (text punch) using blurred luminance as baseline. */
function localContrast(img, blurOut, tmp, width, height, amount) {
  const radius = Math.max(4, Math.round(Math.min(width, height) * 0.012));
  boxBlur(img, blurOut, tmp, width, height, radius);
  const s = img.data;
  const b = blurOut.data;
  const a = amount;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i + 3] < 8) continue;
    for (let c = 0; c < 3; c++) {
      const v = s[i + c];
      const m = b[i + c];
      s[i + c] = clamp(m + (v - m) * (1 + a));
    }
  }
}

/** Slightly darken near-black ink without crushing photo areas. */
function inkBoost(data, amount) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const lum = luminance(data[i], data[i + 1], data[i + 2]);
    if (lum > 95) continue;
    const t = (1 - lum / 95) * amount;
    data[i] = clamp(data[i] * (1 - t));
    data[i + 1] = clamp(data[i + 1] * (1 - t));
    data[i + 2] = clamp(data[i + 2] * (1 - t));
  }
}
