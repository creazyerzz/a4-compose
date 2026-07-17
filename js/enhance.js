/**
 * Client-side image processing (no AI / no network).
 * - Background removal (border-mean flood-fill, no color creep)
 * - Document / shadow flatten
 * - Clarity enhance
 */

function clamp(v, min = 0, max = 255) {
  return v < min ? min : v > max ? max : v;
}

function copyImageData(src) {
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function colorDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Separable box blur into out (reuses tmp). */
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

/** Retinex-like shadow flatten — conservative white push to avoid wiping ID faces. */
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

function borderMean(data, width, height) {
  const strip = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  let rs = 0;
  let gs = 0;
  let bs = 0;
  let count = 0;
  const add = (x, y) => {
    const i = (y * width + x) * 4;
    rs += data[i];
    gs += data[i + 1];
    bs += data[i + 2];
    count++;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < strip || y < strip || x >= width - strip || y >= height - strip) {
        add(x, y);
      }
    }
  }
  return {
    r: rs / count,
    g: gs / count,
    b: bs / count,
    count,
  };
}

/**
 * Flood-fill against fixed border mean (prevents color creep into subject).
 * @returns {{ mask: Uint8Array, bgCount: number }}
 */
function buildBgMask(data, width, height, mean, tolerance) {
  const n = width * height;
  const mask = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const mr = mean.r;
  const mg = mean.g;
  const mb = mean.b;

  const trySeed = (x, y) => {
    const idx = y * width + x;
    if (mask[idx]) return;
    const i = idx * 4;
    if (colorDist(data[i], data[i + 1], data[i + 2], mr, mg, mb) > tolerance + 10) {
      return; // edge pixel is already subject-colored — skip
    }
    mask[idx] = 1;
    queue[qt++] = idx;
  };

  for (let x = 0; x < width; x++) {
    trySeed(x, 0);
    trySeed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    trySeed(0, y);
    trySeed(width - 1, y);
  }

  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (qh < qt) {
    const idx = queue[qh++];
    const x = idx % width;
    const y = (idx / width) | 0;
    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nidx = ny * width + nx;
      if (mask[nidx]) continue;
      const ni = nidx * 4;
      // KEY FIX: compare to border mean, never to neighbor (no creep)
      if (colorDist(data[ni], data[ni + 1], data[ni + 2], mr, mg, mb) <= tolerance) {
        mask[nidx] = 1;
        queue[qt++] = nidx;
      }
    }
  }

  // 1px dilate only into pixels still close to border mean
  const copy = new Uint8Array(mask);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (copy[idx]) continue;
      if (!(copy[idx - 1] || copy[idx + 1] || copy[idx - width] || copy[idx + width])) {
        continue;
      }
      const i = idx * 4;
      if (colorDist(data[i], data[i + 1], data[i + 2], mr, mg, mb) <= tolerance + 6) {
        mask[idx] = 1;
      }
    }
  }

  let bgCount = 0;
  for (let i = 0; i < n; i++) if (mask[i]) bgCount++;
  return { mask, bgCount };
}

function scoreMask(contentRatio) {
  // Ideal: subject is a sizable island (ID/doc photos usually 15%–70%)
  if (contentRatio < 0.08 || contentRatio > 0.9) return -1;
  const ideal = 0.4;
  return 1 - Math.abs(contentRatio - ideal);
}

/**
 * Mild cleanup baked after bg remove (shadows / clarity) — conservative.
 */
function bakeMildCleanup(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const width = canvas.width;
  const height = canvas.height;
  const img = ctx.getImageData(0, 0, width, height);
  const tmp = copyImageData(img);
  const blur = copyImageData(img);
  const radius = Math.max(12, Math.round(Math.min(width, height) * 0.06));
  boxBlur(img, blur, tmp, width, height, radius);
  documentFlatten(img, blur, 0.55);
  contrastStretch(img.data, 1.5, 99);
  boxBlur(img, blur, tmp, width, height, 1);
  unsharpMask(img, blur, 1.2);
  midtoneContrast(img.data, 0.35);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Remove desk/wall background → white, crop to subject.
 * Throws Error with code BG_REMOVE_FAILED if result would wipe the subject.
 * @param {CanvasImageSource} source
 * @param {{ tolerance?: number, bakeCleanup?: boolean }} [opts]
 * @returns {HTMLCanvasElement}
 */
export function removeBackground(source, opts = {}) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const n = width * height;
  const mean = borderMean(data, width, height);

  const tolerances =
    opts.tolerance != null
      ? [opts.tolerance]
      : [26, 32, 38, 44, 52, 60];

  let best = null;
  for (const tol of tolerances) {
    const { mask, bgCount } = buildBgMask(data, width, height, mean, tol);
    const contentRatio = 1 - bgCount / n;
    const score = scoreMask(contentRatio);
    if (score < 0) continue;
    if (!best || score > best.score) {
      best = { mask, bgCount, contentRatio, score, tol };
    }
    // Good enough early exit
    if (contentRatio >= 0.18 && contentRatio <= 0.65) break;
  }

  if (!best) {
    const err = new Error("无法可靠区分主体与背景，请换光线更均匀的照片或手动裁切");
    err.code = "BG_REMOVE_FAILED";
    throw err;
  }

  const { mask } = best;
  for (let idx = 0; idx < n; idx++) {
    if (!mask[idx]) continue;
    const i = idx * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  // Light feather only on pixels still close to desk color
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (mask[idx]) continue;
      let bgN = 0;
      for (const [dx, dy] of neighbors) {
        if (mask[(y + dy) * width + (x + dx)]) bgN++;
      }
      if (!bgN) continue;
      const i = idx * 4;
      if (colorDist(data[i], data[i + 1], data[i + 2], mean.r, mean.g, mean.b) > best.tol + 14) {
        continue;
      }
      const t = Math.min(0.7, 0.25 + bgN * 0.15);
      data[i] = clamp(data[i] + (255 - data[i]) * t);
      data[i + 1] = clamp(data[i + 1] + (255 - data[i + 1]) * t);
      data[i + 2] = clamp(data[i + 2] + (255 - data[i + 2]) * t);
    }
  }

  ctx.putImageData(img, 0, 0);
  let out = cropToContent(canvas, 10);
  // Guard: crop must keep meaningful pixels
  if (!hasMeaningfulContent(out)) {
    const err = new Error("去背景后主体丢失，已取消本次处理");
    err.code = "BG_REMOVE_FAILED";
    throw err;
  }
  if (opts.bakeCleanup !== false) {
    out = bakeMildCleanup(out);
    if (!hasMeaningfulContent(out)) {
      // cleanup wiped it — return pre-cleanup crop
      out = cropToContent(canvas, 10);
    }
  }
  out.__bgMeta = { tolerance: best.tol, contentRatio: best.contentRatio };
  return out;
}

function hasMeaningfulContent(sourceCanvas, minRatio = 0.02) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  if (w < 8 || h < 8) return false;
  const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  let content = 0;
  const total = w * h;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) content++;
  }
  return content / total >= minRatio;
}

/** Crop near-white margins. */
function cropToContent(sourceCanvas, pad = 6) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] > 248 && data[i + 1] > 248 && data[i + 2] > 248) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) {
    const err = new Error("去背景后未检测到主体");
    err.code = "BG_REMOVE_FAILED";
    throw err;
  }
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(sourceCanvas, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}

/**
 * @param {CanvasImageSource} source
 * @param {{ enhance?: boolean, docMode?: boolean, strength?: number }} options
 * @returns {HTMLCanvasElement}
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

/** Exported for tests / tooling */
export const __test = {
  borderMean,
  buildBgMask,
  scoreMask,
  colorDist,
  hasMeaningfulContent,
};
