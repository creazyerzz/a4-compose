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
  const lift = 0.45 + strength * 0.35;
  const whitePush = 225 - strength * 25;
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
    const shadowBoost = lum < 120 ? (1 - lum / 120) * 0.28 * strength : 0;
    const mix = Math.min(0.92, lift + shadowBoost);
    r = s[i] * (1 - mix) + r * mix;
    gc = s[i + 1] * (1 - mix) + gc * mix;
    b = s[i + 2] * (1 - mix) + b * mix;
    const outLum = luminance(r, gc, b);
    if (outLum > whitePush) {
      const t = Math.min(0.85, (outLum - whitePush) / (255 - whitePush));
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
 * CamScanner-style: detect document corners → perspective warp → clean rectangle.
 * Keeps interior pixels intact (no color flood-fill eating patterns).
 */
export function removeBackground(source) {
  return scanDocument(source);
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
    const radius = Math.max(12, Math.round(Math.min(width, height) * 0.06));
    boxBlur(img, blur, tmp, width, height, radius);
    documentFlatten(img, blur, Math.min(0.85, Math.max(strength, 0.4)));
    contrastStretch(img.data, 1.2, 99);
    midtoneContrast(img.data, 0.25 + strength * 0.3);
  }

  if (enhance) {
    const radius = Math.max(1, Math.round(1 + strength * 1.5));
    boxBlur(img, blur, tmp, width, height, radius);
    unsharpMask(img, blur, 0.9 + strength * 1.4);
    if (!docMode) {
      contrastStretch(img.data, 1, 99.2);
      midtoneContrast(img.data, 0.35 + strength * 0.4);
    } else {
      boxBlur(img, blur, tmp, width, height, 1);
      unsharpMask(img, blur, 0.55 + strength * 0.45);
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}
