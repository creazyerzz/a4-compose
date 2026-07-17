/**
 * Client-side image processing (no AI / no network).
 * - Background removal (edge flood-fill)
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
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    hist[(luminance(data[i], data[i + 1], data[i + 2]) + 0.5) | 0]++;
  }
  const total = data.length / 4;
  const lowTarget = (total * lowPct) / 100;
  const highTarget = (total * highPct) / 100;
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

function unsharpMask(src, blurred, amount) {
  const s = src.data;
  const b = blurred.data;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i + 3] < 8) continue;
    s[i] = clamp(s[i] + amount * (s[i] - b[i]));
    s[i + 1] = clamp(s[i + 1] + amount * (s[i + 1] - b[i + 1]));
    s[i + 2] = clamp(s[i + 2] + amount * (s[i + 2] - b[i + 2]));
  }
}

/** Retinex-like shadow flatten: divide by large illumination blur. */
function documentFlatten(src, bg, strength) {
  const s = src.data;
  const g = bg.data;
  const lift = 0.55 + strength * 0.4;
  const whitePush = 195 - strength * 45;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i + 3] < 8) continue;
    const br = Math.max(g[i], 12);
    const bgc = Math.max(g[i + 1], 12);
    const bb = Math.max(g[i + 2], 12);
    let r = (s[i] / br) * 255;
    let gc = (s[i + 1] / bgc) * 255;
    let b = (s[i + 2] / bb) * 255;
    // Extra lift in darker regions (typical soft shadows)
    const lum = luminance(s[i], s[i + 1], s[i + 2]);
    const shadowBoost = lum < 140 ? (1 - lum / 140) * 0.35 * strength : 0;
    const mix = Math.min(1, lift + shadowBoost);
    r = s[i] * (1 - mix) + r * mix;
    gc = s[i + 1] * (1 - mix) + gc * mix;
    b = s[i + 2] * (1 - mix) + b * mix;
    const outLum = luminance(r, gc, b);
    if (outLum > whitePush) {
      const t = Math.min(1, (outLum - whitePush) / (255 - whitePush));
      r = r + (255 - r) * t;
      gc = gc + (255 - gc) * t;
      b = b + (255 - b) * t;
    }
    s[i] = clamp(r);
    s[i + 1] = clamp(gc);
    s[i + 2] = clamp(b);
  }
}

/** Midtone contrast (S-curve) — makes text pop more than plain stretch. */
function midtoneContrast(data, amount) {
  const a = amount * 0.55;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    for (let c = 0; c < 3; c++) {
      const x = data[i + c] / 255;
      const y = x + a * (x - 0.5) * (1 - Math.abs(x - 0.5) * 2);
      data[i + c] = clamp(y * 255);
    }
  }
}

/**
 * Flood-fill from image borders to remove desk / wall background → white.
 * Then crop to content bounding box.
 * @param {CanvasImageSource} source
 * @param {{ tolerance?: number }} [opts]
 * @returns {HTMLCanvasElement}
 */
export function removeBackground(source, opts = {}) {
  const tolerance = opts.tolerance ?? 48;
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
  const mask = new Uint8Array(n); // 1 = background

  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;

  const pushSeed = (x, y) => {
    const idx = y * width + x;
    if (mask[idx]) return;
    mask[idx] = 1;
    queue[qt++] = idx;
  };

  for (let x = 0; x < width; x++) {
    pushSeed(x, 0);
    pushSeed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushSeed(0, y);
    pushSeed(width - 1, y);
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
    const i = idx * 4;
    const r0 = data[i];
    const g0 = data[i + 1];
    const b0 = data[i + 2];

    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nidx = ny * width + nx;
      if (mask[nidx]) continue;
      const ni = nidx * 4;
      if (colorDist(r0, g0, b0, data[ni], data[ni + 1], data[ni + 2]) <= tolerance) {
        mask[nidx] = 1;
        queue[qt++] = nidx;
      }
    }
  }

  // Dilate mask 2px to eat anti-aliased fringe / soft shadow near desk
  const dilate = new Uint8Array(mask);
  for (let pass = 0; pass < 2; pass++) {
    dilate.set(mask);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (mask[idx]) continue;
        if (
          dilate[idx - 1] ||
          dilate[idx + 1] ||
          dilate[idx - width] ||
          dilate[idx + width]
        ) {
          // Only expand into pixels similar to nearby bg (avoid eating card)
          const i = idx * 4;
          let nearBg = false;
          for (const [dx, dy] of neighbors) {
            const nidx = (y + dy) * width + (x + dx);
            if (!dilate[nidx]) continue;
            const ni = nidx * 4;
            // Use original color of bg neighbor vs current — if similar to white-bound desk, expand
            if (colorDist(data[i], data[i + 1], data[i + 2], data[ni], data[ni + 1], data[ni + 2]) < tolerance + 12) {
              nearBg = true;
              break;
            }
          }
          if (nearBg) mask[idx] = 1;
        }
      }
    }
  }

  // Paint background white + soft feather
  for (let idx = 0; idx < n; idx++) {
    if (!mask[idx]) continue;
    const i = idx * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  // Soften remaining near-white fringe on content edge
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (mask[idx]) continue;
      let bgN = 0;
      for (const [dx, dy] of neighbors) {
        if (mask[(y + dy) * width + (x + dx)]) bgN++;
      }
      if (bgN === 0) continue;
      const i = idx * 4;
      const lum = luminance(data[i], data[i + 1], data[i + 2]);
      if (lum > 170 || bgN >= 2) {
        const t = Math.min(1, 0.35 + bgN * 0.2);
        data[i] = clamp(data[i] + (255 - data[i]) * t);
        data[i + 1] = clamp(data[i + 1] + (255 - data[i + 1]) * t);
        data[i + 2] = clamp(data[i + 2] + (255 - data[i + 2]) * t);
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return cropToContent(canvas, 8);
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
  if (maxX < minX || maxY < minY) return sourceCanvas;
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
    const radius = Math.max(16, Math.round(Math.min(width, height) * 0.08));
    boxBlur(img, blur, tmp, width, height, radius);
    documentFlatten(img, blur, Math.max(strength, 0.55));
    // Second lighter pass for residual shadows
    boxBlur(img, blur, tmp, width, height, Math.max(8, (radius / 2) | 0));
    documentFlatten(img, blur, 0.35 + strength * 0.25);
    contrastStretch(img.data, 1, 99.2);
    midtoneContrast(img.data, 0.35 + strength * 0.4);
  }

  if (enhance) {
    const radius = Math.max(1, Math.round(1 + strength * 2));
    boxBlur(img, blur, tmp, width, height, radius);
    unsharpMask(img, blur, 1.1 + strength * 1.8);
    if (!docMode) {
      contrastStretch(img.data, 0.8, 99.5);
      midtoneContrast(img.data, 0.45 + strength * 0.5);
    } else {
      // Extra crisp on text after doc flatten
      boxBlur(img, blur, tmp, width, height, 1);
      unsharpMask(img, blur, 0.8 + strength * 0.6);
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}
