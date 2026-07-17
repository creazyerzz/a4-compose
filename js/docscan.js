/**
 * Document scan pipeline (CamScanner-style, no ML):
 * 1) Canny edges  2) find largest 4-corner contour
 * 3) perspective warp to a clean rectangle
 */

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function grayscale(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return g;
}

function gaussianBlurGray(src, w, h, radius = 2) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const r = radius;
  const diam = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) {
        const xx = clamp(x + k, 0, w - 1);
        s += src[y * w + xx];
      }
      tmp[y * w + x] = s / diam;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) {
        const yy = clamp(y + k, 0, h - 1);
        s += tmp[yy * w + x];
      }
      out[y * w + x] = s / diam;
    }
  }
  return out;
}

function sobel(gray, w, h) {
  const mag = new Float32Array(w * h);
  const dir = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] +
        gray[i - w + 1] -
        2 * gray[i - 1] +
        2 * gray[i + 1] -
        gray[i + w - 1] +
        gray[i + w + 1];
      const gy =
        -gray[i - w - 1] -
        2 * gray[i - w] -
        gray[i - w + 1] +
        gray[i + w - 1] +
        2 * gray[i + w] +
        gray[i + w + 1];
      mag[i] = Math.hypot(gx, gy);
      dir[i] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

function nonMaxSuppression(mag, dir, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const angle = (((dir[i] * 180) / Math.PI) + 180) % 180;
      let m1 = 0;
      let m2 = 0;
      if ((angle >= 0 && angle < 22.5) || (angle >= 157.5 && angle <= 180)) {
        m1 = mag[i - 1];
        m2 = mag[i + 1];
      } else if (angle >= 22.5 && angle < 67.5) {
        m1 = mag[i - w + 1];
        m2 = mag[i + w - 1];
      } else if (angle >= 67.5 && angle < 112.5) {
        m1 = mag[i - w];
        m2 = mag[i + w];
      } else {
        m1 = mag[i - w - 1];
        m2 = mag[i + w + 1];
      }
      out[i] = mag[i] >= m1 && mag[i] >= m2 ? mag[i] : 0;
    }
  }
  return out;
}

function hysteresis(nms, w, h, low, high) {
  const edge = new Uint8Array(w * h); // 0 none, 1 weak, 2 strong
  for (let i = 0; i < nms.length; i++) {
    if (nms[i] >= high) edge[i] = 2;
    else if (nms[i] >= low) edge[i] = 1;
  }
  const stack = [];
  for (let i = 0; i < edge.length; i++) if (edge[i] === 2) stack.push(i);
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (edge[ni] === 1) {
          edge[ni] = 2;
          stack.push(ni);
        }
      }
    }
  }
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < edge.length; i++) bin[i] = edge[i] === 2 ? 1 : 0;
  return bin;
}

function canny(gray, w, h) {
  const blurred = gaussianBlurGray(gray, w, h, 2);
  const { mag, dir } = sobel(blurred, w, h);
  // Adaptive thresholds from magnitude histogram
  let max = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > max) max = mag[i];
  const high = Math.max(40, max * 0.18);
  const low = high * 0.4;
  const nms = nonMaxSuppression(mag, dir, w, h);
  return hysteresis(nms, w, h, low, high);
}

/** Dilate binary edges to connect gaps. */
function dilate(bin, w, h, r = 1) {
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -r; dy <= r && !v; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (bin[ny * w + nx]) {
            v = 1;
            break;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Suzuki-style border following for external contours on binary image.
 * Returns list of contours as arrays of {x,y}.
 */
function findContours(bin, w, h) {
  const visited = new Uint8Array(w * h);
  const contours = [];
  const N8 = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!bin[i] || visited[i]) continue;
      // start only on left edge of a stroke (bg on left)
      if (bin[i - 1]) continue;

      const contour = [];
      let cx = x;
      let cy = y;
      let dir = 0;
      let guard = 0;
      do {
        contour.push({ x: cx, y: cy });
        visited[cy * w + cx] = 1;
        let found = false;
        for (let k = 0; k < 8; k++) {
          const nd = (dir + 6 + k) % 8; // prefer turning left
          const nx = cx + N8[nd][0];
          const ny = cy + N8[nd][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (bin[ny * w + nx]) {
            cx = nx;
            cy = ny;
            dir = nd;
            found = true;
            break;
          }
        }
        if (!found) break;
        guard++;
      } while ((cx !== x || cy !== y) && guard < w * h);

      if (contour.length >= 40) contours.push(contour);
    }
  }
  return contours;
}

function perimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    p += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return p;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Ramer–Douglas–Peucker */
function approxPolyDP(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  let dmax = 0;
  let idx = 0;
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointLineDist(pts[i], first, last);
    if (d > dmax) {
      dmax = d;
      idx = i;
    }
  }
  if (dmax > epsilon) {
    const left = approxPolyDP(pts.slice(0, idx + 1), epsilon);
    const right = approxPolyDP(pts.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function pointLineDist(p, a, b) {
  const A = p.x - a.x;
  const B = p.y - a.y;
  const C = b.x - a.x;
  const D = b.y - a.y;
  const dot = A * C + B * D;
  const len2 = C * C + D * D || 1;
  const t = Math.max(0, Math.min(1, dot / len2));
  const xx = a.x + t * C;
  const yy = a.y + t * D;
  return Math.hypot(p.x - xx, p.y - yy);
}

function orderCorners(pts) {
  // pts length 4
  const sum = pts.map((p) => ({ p, s: p.x + p.y, d: p.y - p.x }));
  sum.sort((a, b) => a.s - b.s);
  const tl = sum[0].p;
  const br = sum[3].p;
  const mid = [sum[1], sum[2]];
  mid.sort((a, b) => a.d - b.d);
  const tr = mid[0].p;
  const bl = mid[1].p;
  return [tl, tr, br, bl];
}

function scoreQuad(quad, imgArea) {
  const area = polygonArea(quad);
  if (area < imgArea * 0.08 || area > imgArea * 0.95) return -1;
  // side lengths
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sides.push(Math.hypot(a.x - b.x, a.y - b.y));
  }
  const [w1, h1, w2, h2] = sides;
  const width = (w1 + w2) / 2;
  const height = (h1 + h2) / 2;
  if (width < 20 || height < 20) return -1;
  const ratio = Math.max(width, height) / Math.min(width, height);
  // ID ≈ 1.585, A4 page photo of card often 1.3–2.2
  if (ratio < 1.15 || ratio > 3.2) return -1;
  // rectangularity: area vs bbox
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of quad) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const bboxArea = (maxX - minX) * (maxY - minY) || 1;
  const rectScore = area / bboxArea;
  return area * rectScore;
}

/**
 * Solve 8x8 for homography mapping src[i] -> dst[i] (4 pairs).
 * Returns 3x3 row-major H (src -> dst).
 */
function getPerspectiveTransform(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i].x;
    const y = src[i].y;
    const u = dst[i].x;
    const v = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussian elimination for 8 unknowns. */
function solveLinear(A, b) {
  const n = 8;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error("透视矩阵求解失败");
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const Hh = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-12) throw new Error("透视矩阵不可逆");
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, Hh / det, I / det];
}

function applyH(H, x, y) {
  const u = H[0] * x + H[1] * y + H[2];
  const v = H[3] * x + H[4] * y + H[5];
  const w = H[6] * x + H[7] * y + H[8];
  return { x: u / w, y: v / w };
}

function sampleBilinear(data, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) {
    const xx = clamp(x, 0, w - 1);
    const yy = clamp(y, 0, h - 1);
    const i = ((yy | 0) * w + (xx | 0)) * 4;
    return [data[i], data[i + 1], data[i + 2], 255];
  }
  const x0 = x | 0;
  const y0 = y | 0;
  const dx = x - x0;
  const dy = y - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + w * 4;
  const i11 = i01 + 4;
  const out = [0, 0, 0, 255];
  for (let c = 0; c < 3; c++) {
    const v00 = data[i00 + c];
    const v10 = data[i10 + c];
    const v01 = data[i01 + c];
    const v11 = data[i11 + c];
    out[c] =
      v00 * (1 - dx) * (1 - dy) +
      v10 * dx * (1 - dy) +
      v01 * (1 - dx) * dy +
      v11 * dx * dy;
  }
  return out;
}

function warpPerspective(srcData, srcW, srcH, srcQuad, outW, outH) {
  const dstQuad = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];
  // H maps dest -> src for sampling
  const H_src_to_dst = getPerspectiveTransform(srcQuad, dstQuad);
  const H_dst_to_src = invertHomography(H_src_to_dst);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(outW, outH);
  const od = out.data;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const p = applyH(H_dst_to_src, x, y);
      const rgba = sampleBilinear(srcData, srcW, srcH, p.x, p.y);
      const i = (y * outW + x) * 4;
      od[i] = rgba[0];
      od[i + 1] = rgba[1];
      od[i + 2] = rgba[2];
      od[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

function detectDocumentQuad(data, w, h) {
  const imgArea = w * h;
  let best = null;
  let bestScore = -1;

  const consider = (pts) => {
    if (!pts || pts.length !== 4) return;
    const quad = orderCorners(pts);
    const score = scoreQuad(quad, imgArea);
    if (score > bestScore) {
      bestScore = score;
      best = quad;
    }
  };

  // Path A: Canny edges → contours → approx 4 corners
  const gray = grayscale(data, w, h);
  let edges = canny(gray, w, h);
  edges = dilate(edges, w, h, 1);
  for (const c of findContours(edges, w, h)) {
    const peri = perimeter(c);
    for (const factor of [0.015, 0.025, 0.035, 0.05, 0.07]) {
      let pts = approxPolyDP(c.concat([c[0]]), peri * factor);
      if (pts.length >= 2) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 3) pts = pts.slice(0, -1);
      }
      if (pts.length === 4) consider(pts);
      // If 5–6 points, try convex-ish by taking extreme corners
      if (pts.length > 4 && pts.length <= 8) {
        consider(orderCorners(pickExtremeCorners(pts)));
      }
    }
  }

  // Path B: subject blob (desk vs card) → outer contour → 4 corners
  const blobQuad = detectQuadFromBlob(data, w, h);
  if (blobQuad) consider(blobQuad);

  return best;
}

function pickExtremeCorners(pts) {
  let tl = pts[0];
  let tr = pts[0];
  let br = pts[0];
  let bl = pts[0];
  for (const p of pts) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.y - p.x > bl.y - bl.x) bl = p;
  }
  return [tl, tr, br, bl];
}

/** Build subject mask and approximate its outer contour to a quad. */
function detectQuadFromBlob(data, w, h) {
  const border = Math.max(3, Math.round(Math.min(w, h) * 0.05));
  let br = 0;
  let bg = 0;
  let bb = 0;
  let bn = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= border && y >= border && x < w - border && y < h - border) continue;
      const i = (y * w + x) * 4;
      br += data[i];
      bg += data[i + 1];
      bb += data[i + 2];
      bn++;
    }
  }
  br /= bn;
  bg /= bn;
  bb /= bn;

  const fg = new Uint8Array(w * h);
  const insetX = Math.round(w * 0.18);
  const insetY = Math.round(h * 0.18);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.hypot(data[i] - br, data[i + 1] - bg, data[i + 2] - bb);
      if (x >= insetX && x < w - insetX && y >= insetY && y < h - insetY) {
        fg[y * w + x] = 1;
      } else {
        // Prefer keeping uncertain pixels as subject (bias)
        fg[y * w + x] = d > 32 ? 1 : 0;
      }
    }
  }

  // Morphological close (dilate then erode) to smooth card silhouette
  let m = dilate(fg, w, h, 2);
  m = erode(m, w, h, 2);

  // Trace outer boundary of largest center-touching component
  const contour = traceBlobContour(m, w, h, insetX, insetY);
  if (!contour || contour.length < 40) return null;

  const peri = perimeter(contour);
  for (const factor of [0.02, 0.03, 0.04, 0.06]) {
    let pts = approxPolyDP(contour.concat([contour[0]]), peri * factor);
    if (pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3) pts = pts.slice(0, -1);
    }
    if (pts.length === 4) return pts;
    if (pts.length > 4 && pts.length <= 10) return pickExtremeCorners(pts);
  }
  return pickExtremeCorners(contour);
}

function erode(bin, w, h, r = 1) {
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dy = -r; dy <= r && v; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !bin[ny * w + nx]) {
            v = 0;
            break;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function traceBlobContour(fg, w, h, insetX, insetY) {
  // Find a starting border pixel of the main blob (leftmost FG touching center component)
  const seen = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (!fg[i] || seen[i]) return;
    seen[i] = 1;
    queue.push(i);
  };
  for (let y = insetY; y < h - insetY; y++) {
    for (let x = insetX; x < w - insetX; x++) push(x, y);
  }
  if (!queue.length) return null;
  // BFS mark main component
  const main = new Uint8Array(w * h);
  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    main[i] = 1;
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!fg[ni] || seen[ni]) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }

  // Find leftmost boundary start
  let sx = -1;
  let sy = -1;
  for (let x = 0; x < w && sx < 0; x++) {
    for (let y = 0; y < h; y++) {
      if (!main[y * w + x]) continue;
      // boundary if any 4-neighbor is outside / bg
      if (
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        !main[y * w + x - 1] ||
        !main[y * w + x + 1] ||
        !main[(y - 1) * w + x] ||
        !main[(y + 1) * w + x]
      ) {
        sx = x;
        sy = y;
        break;
      }
    }
  }
  if (sx < 0) return null;

  // Moore neighborhood contour trace
  const N8 = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];
  const contour = [];
  let cx = sx;
  let cy = sy;
  let dir = 0;
  let guard = 0;
  do {
    contour.push({ x: cx, y: cy });
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (dir + 6 + k) % 8;
      const nx = cx + N8[nd][0];
      const ny = cy + N8[nd][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (main[ny * w + nx]) {
        cx = nx;
        cy = ny;
        dir = nd;
        found = true;
        break;
      }
    }
    if (!found) break;
    guard++;
  } while ((cx !== sx || cy !== sy) && guard < w * h);

  return contour.length >= 40 ? contour : null;
}

/**
 * Fallback: axis-aligned tight crop using border-mean + center protection
 * (only used if quad detection fails).
 */
function fallbackAxisCrop(srcCanvas, data, w, h) {
  const border = Math.max(3, Math.round(Math.min(w, h) * 0.04));
  let br = 0;
  let bg = 0;
  let bb = 0;
  let bn = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= border && y >= border && x < w - border && y < h - border) continue;
      const i = (y * w + x) * 4;
      br += data[i];
      bg += data[i + 1];
      bb += data[i + 2];
      bn++;
    }
  }
  br /= bn;
  bg /= bn;
  bb /= bn;

  const mask = new Uint8Array(w * h);
  const insetX = Math.round(w * 0.2);
  const insetY = Math.round(h * 0.2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.hypot(data[i] - br, data[i + 1] - bg, data[i + 2] - bb);
      if (x >= insetX && x < w - insetX && y >= insetY && y < h - insetY) {
        mask[y * w + x] = 1;
      } else {
        mask[y * w + x] = d > 38 ? 1 : 0;
      }
    }
  }
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX <= minX) throw new Error("未检测到证件边缘");
  const pad = Math.round(Math.min(w, h) * 0.01);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(srcCanvas, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}

/**
 * CamScanner-style document extract.
 * @param {CanvasImageSource} source
 * @returns {HTMLCanvasElement}
 */
export function scanDocument(source) {
  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const ctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, srcW, srcH);

  // Work on downscaled copy for detection speed/robustness
  const maxSide = 640;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const dw = Math.max(32, Math.round(srcW * scale));
  const dh = Math.max(32, Math.round(srcH * scale));
  const small = document.createElement("canvas");
  small.width = dw;
  small.height = dh;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(srcCanvas, 0, 0, dw, dh);
  const smallImg = sctx.getImageData(0, 0, dw, dh);

  let quad = detectDocumentQuad(smallImg.data, dw, dh);
  let method = "perspective";

  if (!quad) {
    method = "fallback-crop";
    const out = fallbackAxisCrop(srcCanvas, img.data, srcW, srcH);
    out.__bgMeta = { method };
    return out;
  }

  // Map quad from downscaled space back to full resolution
  const srcQuad = quad.map((p) => ({
    x: p.x / scale,
    y: p.y / scale,
  }));

  const [tl, tr, br, bl] = orderCorners(srcQuad);
  const ordered = [tl, tr, br, bl];
  const widthA = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthB = Math.hypot(br.x - bl.x, br.y - bl.y);
  const heightA = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightB = Math.hypot(br.x - tr.x, br.y - tr.y);
  let outW = Math.round((widthA + widthB) / 2);
  let outH = Math.round((heightA + heightB) / 2);

  // Prefer ID-card-like aspect if close
  const ratio = Math.max(outW, outH) / Math.min(outW, outH);
  const idRatio = 85.6 / 54;
  if (Math.abs(ratio - idRatio) < 0.35) {
    if (outW >= outH) {
      outH = Math.round(outW / idRatio);
    } else {
      outW = Math.round(outH / idRatio);
    }
  }

  // Cap resolution for performance / memory
  const maxOut = 2000;
  const outScale = Math.min(1, maxOut / Math.max(outW, outH));
  outW = Math.max(64, Math.round(outW * outScale));
  outH = Math.max(64, Math.round(outH * outScale));

  const out = warpPerspective(img.data, srcW, srcH, ordered, outW, outH);
  out.__bgMeta = {
    method,
    width: outW,
    height: outH,
    ratio: outW / outH,
  };
  return out;
}

export const __testDocscan = {
  orderCorners,
  scoreQuad,
  approxPolyDP,
  polygonArea,
};
