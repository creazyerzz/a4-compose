/**
 * Client-side image processing (no AI / no network).
 *
 * Background removal strategy (document / ID friendly):
 * 1) Trimap: border = sure BG, center = sure FG (never eat subject core)
 * 2) Classify unknown by desk chroma + color distance + local variance
 * 3) Fill holes in FG, keep component touching center
 * 4) Crop ORIGINAL pixels to subject bbox (interior untouched)
 * 5) Shallow edge wipe only near crop borders (limited depth)
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

function saturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
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

function regionMean(data, width, height, predicate) {
  let rs = 0;
  let gs = 0;
  let bs = 0;
  let count = 0;
  let satSum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!predicate(x, y)) continue;
      const i = (y * width + x) * 4;
      rs += data[i];
      gs += data[i + 1];
      bs += data[i + 2];
      satSum += saturation(data[i], data[i + 1], data[i + 2]);
      count++;
    }
  }
  if (!count) return { r: 128, g: 128, b: 128, sat: 0, count: 0 };
  return {
    r: rs / count,
    g: gs / count,
    b: bs / count,
    sat: satSum / count,
    count,
  };
}

/** Local luminance variance (3x3) — desk is smooth, card text/patterns are not. */
function buildVarianceMap(data, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((y + dy) * width + (x + dx)) * 4;
          const lum = luminance(data[i], data[i + 1], data[i + 2]);
          sum += lum;
          sum2 += lum * lum;
          n++;
        }
      }
      const mean = sum / n;
      out[y * width + x] = sum2 / n - mean * mean;
    }
  }
  return out;
}

/**
 * Build FG mask (1 = keep subject). Protects center; fills holes.
 */
function buildSubjectMask(data, width, height) {
  const n = width * height;
  const border = Math.max(4, Math.round(Math.min(width, height) * 0.06));
  const insetX = Math.round(width * 0.22);
  const insetY = Math.round(height * 0.22);

  const bgMean = regionMean(
    data,
    width,
    height,
    (x, y) => x < border || y < border || x >= width - border || y >= height - border
  );
  const fgMean = regionMean(
    data,
    width,
    height,
    (x, y) => x >= insetX && x < width - insetX && y >= insetY && y < height - insetY
  );

  const variance = buildVarianceMap(data, width, height);
  // Adaptive variance threshold from border samples
  let vSum = 0;
  let vCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (x < border || y < border || x >= width - border || y >= height - border) {
        vSum += variance[y * width + x];
        vCount++;
      }
    }
  }
  const vBorder = vCount ? vSum / vCount : 20;
  const vThresh = Math.max(18, vBorder * 2.2);

  // fg[i]=1 means SUBJECT (keep)
  const fg = new Uint8Array(n);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const i = idx * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Sure FG: center core
      if (x >= insetX && x < width - insetX && y >= insetY && y < height - insetY) {
        fg[idx] = 1;
        continue;
      }

      // Sure BG: outer strip that looks like desk (smooth + near bg mean)
      const onBorder = x < border || y < border || x >= width - border || y >= height - border;
      const dBg = colorDist(r, g, b, bgMean.r, bgMean.g, bgMean.b);
      const dFg = colorDist(r, g, b, fgMean.r, fgMean.g, fgMean.b);
      const sat = saturation(r, g, b);
      const vari = variance[idx];

      if (onBorder && dBg < 55 && vari < vThresh * 1.5) {
        fg[idx] = 0;
        continue;
      }

      // Unknown: prefer subject when patterned, or closer to FG / less saturated than desk
      let subjectScore = 0;
      if (dFg + 8 < dBg) subjectScore += 2;
      if (dBg > 42) subjectScore += 1;
      if (vari > vThresh) subjectScore += 2;
      if (bgMean.sat > 0.12 && sat + 0.06 < bgMean.sat) subjectScore += 1; // less vivid than wood
      if (dBg < 28 && vari < vThresh * 0.8) subjectScore -= 2;

      fg[idx] = subjectScore >= 1 ? 1 : 0;
    }
  }

  // Force center sure FG again after classification
  for (let y = insetY; y < height - insetY; y++) {
    for (let x = insetX; x < width - insetX; x++) {
      fg[y * width + x] = 1;
    }
  }

  // Keep only FG components that touch the center region (drop desk islands)
  const keep = largestComponentsTouching(
    fg,
    width,
    height,
    (x, y) => x >= insetX && x < width - insetX && y >= insetY && y < height - insetY
  );
  fg.set(keep);

  // Fill holes: BG islands not connected to image border → subject
  fillInteriorHoles(fg, width, height);

  return { fg, bgMean, fgMean };
}

/** BFS keep FG components that touch the center predicate. */
function largestComponentsTouching(fg, width, height, touchesCenter) {
  const n = width * height;
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (let start = 0; start < n; start++) {
    if (!fg[start] || seen[start]) continue;
    let qh = 0;
    let qt = 0;
    queue[qt++] = start;
    seen[start] = 1;
    const comp = [];
    let hitCenter = false;
    while (qh < qt) {
      const idx = queue[qh++];
      comp.push(idx);
      const x = idx % width;
      const y = (idx / width) | 0;
      if (touchesCenter(x, y)) hitCenter = true;
      for (const [dx, dy] of neighbors) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nidx = ny * width + nx;
        if (seen[nidx] || !fg[nidx]) continue;
        seen[nidx] = 1;
        queue[qt++] = nidx;
      }
    }
    if (hitCenter) {
      for (const idx of comp) out[idx] = 1;
    }
  }
  return out;
}

/** Any non-FG region not reachable from border becomes FG (protect card patterns). */
function fillInteriorHoles(fg, width, height) {
  const n = width * height;
  const reachableBg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const push = (x, y) => {
    const idx = y * width + x;
    if (fg[idx] || reachableBg[idx]) return;
    reachableBg[idx] = 1;
    queue[qt++] = idx;
  };

  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }

  while (qh < qt) {
    const idx = queue[qh++];
    const x = idx % width;
    const y = (idx / width) | 0;
    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      push(nx, ny);
    }
  }

  for (let i = 0; i < n; i++) {
    if (!fg[i] && !reachableBg[i]) fg[i] = 1;
  }
}

function maskBoundingBox(fg, width, height) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!fg[y * width + x]) continue;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!count) return null;
  return { minX, minY, maxX, maxY, count };
}

/**
 * Only wipe desk pixels near the crop edge, limited depth — never deep into subject.
 */
function shallowEdgeWipe(canvas, bgMean, maxDepthRatio = 0.1) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const n = width * height;
  const maxDepth = Math.max(6, Math.round(Math.min(width, height) * maxDepthRatio));
  const mask = new Uint8Array(n); // 1 = wipe
  const depth = new Int16Array(n);
  depth.fill(-1);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;

  const trySeed = (x, y) => {
    const idx = y * width + x;
    const i = idx * 4;
    if (colorDist(data[i], data[i + 1], data[i + 2], bgMean.r, bgMean.g, bgMean.b) > 40) {
      return;
    }
    // Prefer wiping smoother / more saturated wood-like pixels
    mask[idx] = 1;
    depth[idx] = 0;
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
    const d0 = depth[idx];
    if (d0 >= maxDepth) continue;
    const i0 = idx * 4;
    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nidx = ny * width + nx;
      if (mask[nidx]) continue;
      const ni = nidx * 4;
      if (colorDist(data[ni], data[ni + 1], data[ni + 2], bgMean.r, bgMean.g, bgMean.b) > 36) {
        continue;
      }
      // Stop if clearly different from local seed (protect printed patterns)
      if (colorDist(data[ni], data[ni + 1], data[ni + 2], data[i0], data[i0 + 1], data[i0 + 2]) > 28) {
        continue;
      }
      mask[nidx] = 1;
      depth[nidx] = d0 + 1;
      queue[qt++] = nidx;
    }
  }

  for (let idx = 0; idx < n; idx++) {
    if (!mask[idx]) continue;
    const i = idx * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Remove desk/wall background for documents/IDs without destroying subject interior.
 * @param {CanvasImageSource} source
 * @param {{ bakeCleanup?: boolean }} [opts]
 * @returns {HTMLCanvasElement}
 */
export function removeBackground(source, opts = {}) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  srcCtx.drawImage(source, 0, 0);
  const img = srcCtx.getImageData(0, 0, width, height);
  const data = img.data;
  const n = width * height;

  const { fg, bgMean } = buildSubjectMask(data, width, height);
  const box = maskBoundingBox(fg, width, height);
  if (!box) {
    const err = new Error("未检测到可保留的主体");
    err.code = "BG_REMOVE_FAILED";
    throw err;
  }

  const contentRatio = box.count / n;
  if (contentRatio < 0.08 || contentRatio > 0.95) {
    const err = new Error("主体占比异常，已取消去背景以免损坏图片");
    err.code = "BG_REMOVE_FAILED";
    throw err;
  }

  const pad = Math.max(4, Math.round(Math.min(width, height) * 0.012));
  const minX = Math.max(0, box.minX - pad);
  const minY = Math.max(0, box.minY - pad);
  const maxX = Math.min(width - 1, box.maxX + pad);
  const maxY = Math.min(height - 1, box.maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  // Crop ORIGINAL pixels — do not paint inside the card
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(srcCanvas, minX, minY, cw, ch, 0, 0, cw, ch);

  // Only clean leftover desk near the new edges
  shallowEdgeWipe(out, bgMean, 0.08);

  if (!hasMeaningfulContent(out, 0.08)) {
    const err = new Error("去背景后主体丢失，已取消本次处理");
    err.code = "BG_REMOVE_FAILED";
    throw err;
  }

  // Default: no heavy bake — interior already preserved
  if (opts.bakeCleanup === true) {
    bakeMildCleanup(out);
  }

  out.__bgMeta = { contentRatio, width: cw, height: ch };
  return out;
}

function bakeMildCleanup(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const width = canvas.width;
  const height = canvas.height;
  const img = ctx.getImageData(0, 0, width, height);
  const tmp = copyImageData(img);
  const blur = copyImageData(img);
  const radius = Math.max(10, Math.round(Math.min(width, height) * 0.05));
  boxBlur(img, blur, tmp, width, height, radius);
  documentFlatten(img, blur, 0.4);
  boxBlur(img, blur, tmp, width, height, 1);
  unsharpMask(img, blur, 0.9);
  ctx.putImageData(img, 0, 0);
  return canvas;
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
