/**
 * Client-side image processing (no AI / no network).
 * - Document scan (CamScanner-style) via docscan.js
 * - 扫描件后处理：纸面白底、去阴影、文字清晰、保护人像
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

function saturation(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
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
    data[i] = clamp((data[i] - lo) * scale);
    data[i + 1] = clamp((data[i + 1] - lo) * scale);
    data[i + 2] = clamp((data[i + 2] - lo) * scale);
  }
}

function unsharpMask(src, blurred, amount, mask) {
  const s = src.data;
  const b = blurred.data;
  for (let i = 0, p = 0; i < s.length; i += 4, p++) {
    if (s[i + 3] < 8) continue;
    if (mask && mask[p] < 0.25) continue;
    const a = mask ? amount * mask[p] : amount;
    s[i] = clamp(s[i] + a * (s[i] - b[i]));
    s[i + 1] = clamp(s[i + 1] + a * (s[i + 1] - b[i + 1]));
    s[i + 2] = clamp(s[i + 2] + a * (s[i + 2] - b[i + 2]));
  }
}

function documentFlatten(src, bg, strength, paperMask) {
  const s = src.data;
  const g = bg.data;
  const lift = 0.5 + strength * 0.35;
  for (let i = 0, p = 0; i < s.length; i += 4, p++) {
    if (s[i + 3] < 8) continue;
    const paper = paperMask ? paperMask[p] : 1;
    const br = Math.max(g[i], 12);
    const bgc = Math.max(g[i + 1], 12);
    const bb = Math.max(g[i + 2], 12);
    let r = (s[i] / br) * 255;
    let gc = (s[i + 1] / bgc) * 255;
    let b = (s[i + 2] / bb) * 255;
    const lum = luminance(s[i], s[i + 1], s[i + 2]);
    const mix = Math.min(0.92, lift) * (0.25 + 0.75 * paper);
    // Dark ink / photo: much lighter flatten
    const darkGuard = lum < 90 ? 0.3 : lum < 130 ? 0.6 : 1;
    const m = mix * darkGuard;
    r = s[i] * (1 - m) + r * m;
    gc = s[i + 1] * (1 - m) + gc * m;
    b = s[i + 2] * (1 - m) + b * m;
    s[i] = clamp(r);
    s[i + 1] = clamp(gc);
    s[i + 2] = clamp(b);
  }
}

function midtoneContrast(data, amount, paperMask) {
  const a = amount * 0.45;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 8) continue;
    const w = paperMask ? 0.35 + 0.65 * paperMask[p] : 1;
    for (let c = 0; c < 3; c++) {
      const x = data[i + c] / 255;
      const y = x + a * w * (x - 0.5) * (1 - Math.abs(x - 0.5) * 2);
      data[i + c] = clamp(y * 255);
    }
  }
}

/**
 * Classify pixels: paper (whitened) vs photo/ink (protected).
 * Returns Float32Array weight in [0,1] — 1 = paper-like.
 */
function buildPaperMask(data, w, h) {
  const n = w * h;
  const mask = new Float32Array(n);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = luminance(r, g, b);
    const sat = saturation(r, g, b);
    // Skin / portrait tones
    const skin =
      r > 80 &&
      g > 40 &&
      b > 20 &&
      r >= g - 8 &&
      r - b > 10 &&
      Math.abs(r - g) < 75 &&
      lum > 45 &&
      lum < 220;
    // Emblem red / strong chroma
    const vivid = sat > 0.35 && lum > 40 && lum < 220;
    // Ink / dark text
    const ink = lum < 78;
    // Photo-ish dark block (hair/shirt)
    const photoDark = lum < 110 && sat < 0.25 && lum > 20;

    if (skin || vivid) {
      mask[p] = 0.05;
    } else if (ink || photoDark) {
      mask[p] = 0.15;
    } else if (lum > 155 && sat < 0.22) {
      mask[p] = 1; // clear paper
    } else if (lum > 135 && sat < 0.3) {
      mask[p] = 0.75; // guilloche / light tint
    } else if (lum > 120 && sat < 0.35) {
      mask[p] = 0.45;
    } else {
      mask[p] = 0.25;
    }
  }
  // Soften mask edges (3x3 box)
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += mask[yy * w + xx];
          c++;
        }
      }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

/**
 * 扫描件纸面：提白、去色偏；文字略压黑；人像基本不动。
 */
function applyScanLook(data, paperMask) {
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 8) continue;
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    const lum = luminance(r, g, b);
    const paper = paperMask[p];

    // Paper → scanner white (~248)
    if (paper > 0.4 && lum > 115) {
      const t = Math.min(1, (paper - 0.4) / 0.6) * Math.min(1, (lum - 115) / 80);
      const target = 248;
      r = r + (target - r) * t * 0.85;
      g = g + (target - g) * t * 0.85;
      b = b + (target - b) * t * 0.85;
      // Kill residual warm cast on paper
      const avg = (r + g + b) / 3;
      r = r + (avg - r) * t * 0.55;
      g = g + (avg - g) * t * 0.55;
      b = b + (avg - b) * t * 0.55;
    }

    // Ink → cleaner black (skip when in photo region)
    if (paper > 0.35 && lum < 95) {
      const t = (1 - lum / 95) * 0.35 * paper;
      r *= 1 - t;
      g *= 1 - t;
      b *= 1 - t;
    }

    data[i] = clamp(r);
    data[i + 1] = clamp(g);
    data[i + 2] = clamp(b);
  }
}

function ensureScanResolution(canvas, minW = 1400) {
  const w = canvas.width;
  const h = canvas.height;
  if (w >= minW) return canvas;
  const scale = minW / w;
  const out = document.createElement("canvas");
  out.width = Math.round(w * scale);
  out.height = Math.round(h * scale);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  if (canvas.__bgMeta) out.__bgMeta = { ...canvas.__bgMeta };
  return out;
}

/**
 * Crop → 扫描件：边缘裁切后的证件做成接近复印店/扫描王效果。
 */
export function removeBackground(source, opts = {}) {
  let out = scanDocument(source, opts);
  if (opts.enhance === false) return out;
  const meta = out.__bgMeta || {};
  out = ensureScanResolution(out, opts.minWidth ?? 1400);
  out = toScanDocument(out);
  out.__bgMeta = { ...meta, scanEnhanced: true, scanLook: true };
  return out;
}

/**
 * 扫描件模式（彩色证件）：去阴影、纸面白、文字实、人像保留。
 */
export function toScanDocument(source) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);

  let img = ctx.getImageData(0, 0, width, height);
  const tmp = copyImageData(img);
  const blur = copyImageData(img);
  const paperMask = buildPaperMask(img.data, width, height);

  // 1) Flatten uneven lighting (scanner-like flat light)
  const radius = Math.max(18, Math.round(Math.min(width, height) * 0.09));
  boxBlur(img, blur, tmp, width, height, radius);
  documentFlatten(img, blur, 0.72, paperMask);

  // 2) Paper white + ink clean
  applyScanLook(img.data, paperMask);

  // 3) Mild global stretch (not crushing)
  contrastStretch(img.data, 1.5, 99);
  midtoneContrast(img.data, 0.28, paperMask);

  // 4) Sharpen text/edges; protect portrait (low paper mask)
  boxBlur(img, blur, tmp, width, height, 1);
  unsharpMask(img, blur, 0.95, paperMask);
  boxBlur(img, blur, tmp, width, height, 1);
  unsharpMask(img, blur, 0.4, paperMask);

  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** @deprecated alias — use toScanDocument */
export function scanEnhance(source) {
  return toScanDocument(source);
}

/**
 * Live preview filters (optional toggles on stage).
 * @param {CanvasImageSource} source
 * @param {{ enhance?: boolean, docMode?: boolean, strength?: number }} options
 */
export function processImage(source, options = {}) {
  const enhance = !!options.enhance;
  const docMode = !!options.docMode;
  if (docMode) return toScanDocument(source);

  const strength = Math.min(1, Math.max(0, (options.strength ?? 60) / 100));
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  if (!enhance) return canvas;

  let img = ctx.getImageData(0, 0, width, height);
  const tmp = copyImageData(img);
  const blur = copyImageData(img);
  const radius = Math.max(1, Math.round(1 + strength * 1.2));
  boxBlur(img, blur, tmp, width, height, radius);
  unsharpMask(img, blur, 0.6 + strength * 0.8, null);
  contrastStretch(img.data, 1, 99.2);
  midtoneContrast(img.data, 0.3 + strength * 0.35, null);
  ctx.putImageData(img, 0, 0);
  return canvas;
}
