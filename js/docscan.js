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

/** Pull corners toward center to drop desk fringe. */
function shrinkQuad(quad, t) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  return quad.map((p) => ({
    x: cx + (p.x - cx) * (1 - t),
    y: cy + (p.y - cy) * (1 - t),
  }));
}

function scoreQuad(quad, imgArea, targetAspect = null) {
  const area = polygonArea(quad);
  if (area < imgArea * 0.08 || area > imgArea * 0.92) return -1;
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
  let score = area * rectScore;
  // Prefer tighter quads (not almost full frame = desk included)
  const areaFrac = area / imgArea;
  if (areaFrac > 0.78) score *= 0.25;
  else if (areaFrac > 0.65) score *= 0.55;
  else if (areaFrac >= 0.18 && areaFrac <= 0.55) score *= 1.35;
  // Prefer physical ID aspect when known
  if (targetAspect && targetAspect > 0.2 && targetAspect < 5) {
    const physical = targetAspect >= 1 ? targetAspect : 1 / targetAspect;
    const err = Math.abs(ratio - physical) / physical;
    if (err > 0.35) score *= 0.2;
    else if (err > 0.2) score *= 0.55;
    else score *= 1.4 - err;
  }
  return score;
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

function detectDocumentQuad(data, w, h, targetAspect = null) {
  const imgArea = w * h;
  let best = null;
  let bestScore = -1;

  const consider = (pts) => {
    if (!pts || pts.length !== 4) return;
    const quad = orderCorners(pts);
    const score = scoreQuad(quad, imgArea, targetAspect);
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

/** Build subject mask and fit min-area rectangle (tight CamScanner-like crop). */
function detectQuadFromBlob(data, w, h) {
  const border = Math.max(3, Math.round(Math.min(w, h) * 0.05));
  let br = 0;
  let bg = 0;
  let bb = 0;
  let bn = 0;
  let satSum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= border && y >= border && x < w - border && y < h - border) continue;
      const i = (y * w + x) * 4;
      br += data[i];
      bg += data[i + 1];
      bb += data[i + 2];
      const mx = Math.max(data[i], data[i + 1], data[i + 2]);
      const mn = Math.min(data[i], data[i + 1], data[i + 2]);
      satSum += mx === 0 ? 0 : (mx - mn) / mx;
      bn++;
    }
  }
  br /= bn;
  bg /= bn;
  bb /= bn;
  const bgSat = satSum / bn;
  // Wood desks are warm (R > B); ID faces are cooler / bluer
  const bgWarm = br - bb;

  const fg = new Uint8Array(w * h);
  const insetX = Math.round(w * 0.28);
  const insetY = Math.round(h * 0.28);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const d = Math.hypot(r - br, g - bg, b - bb);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const warm = r - b;
      const inCore = x >= insetX && x < w - insetX && y >= insetY && y < h - insetY;

      // Desk: similar color OR similarly warm wood tone
      const looksLikeDesk =
        (d < 32 && Math.abs(sat - bgSat) < 0.12) ||
        (bgWarm > 15 && warm > bgWarm * 0.5 && d < 48 && sat < bgSat + 0.08);

      if (inCore) {
        // Core is subject unless clearly desk-colored
        fg[y * w + x] = looksLikeDesk && d < 22 ? 0 : 1;
      } else {
        // Prefer cooler / different-from-desk pixels as subject (ID guilloche)
        const coolerThanDesk = bgWarm > 12 && warm < bgWarm - 10;
        const bluishCard = b > r - 5 && b > 90;
        fg[y * w + x] =
          looksLikeDesk && !coolerThanDesk && !bluishCard
            ? 0
            : d > 22 || coolerThanDesk || bluishCard
              ? 1
              : 0;
      }
    }
  }

  let m = dilate(fg, w, h, 1);
  m = erode(m, w, h, 2);

  const contour = traceBlobContour(m, w, h, insetX, insetY);
  if (!contour || contour.length < 40) return null;

  const hull = convexHull(contour);
  if (hull.length < 4) return null;
  return minAreaRectCorners(hull);
}

/** Andrew's monotone chain convex hull. */
function convexHull(points) {
  const pts = points
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const uniq = [];
  for (const p of pts) {
    if (!uniq.length || uniq[uniq.length - 1].x !== p.x || uniq[uniq.length - 1].y !== p.y) {
      uniq.push(p);
    }
  }
  if (uniq.length <= 2) return uniq;

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Rotating-calipers min-area rect → 4 corners. */
function minAreaRectCorners(hull) {
  let bestArea = Infinity;
  let best = null;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const edgeDx = b.x - a.x;
    const edgeDy = b.y - a.y;
    const len = Math.hypot(edgeDx, edgeDy) || 1;
    const ux = edgeDx / len;
    const uy = edgeDy / len;
    const vx = -uy;
    const vy = ux;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = (p.x - a.x) * ux + (p.y - a.y) * uy;
      const v = (p.x - a.x) * vx + (p.y - a.y) * vy;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      best = { a, ux, uy, vx, vy, minU, maxU, minV, maxV };
    }
  }
  if (!best) return null;
  const { a, ux, uy, vx, vy, minU, maxU, minV, maxV } = best;
  const corner = (u, v) => ({
    x: a.x + ux * u + vx * v,
    y: a.y + uy * u + vy * v,
  });
  return [
    corner(minU, minV),
    corner(maxU, minV),
    corner(maxU, maxV),
    corner(minU, maxV),
  ];
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
 * Fallback: warm-desk vs cooler-card crop; retry perspective via mask rect if needed.
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
  const bgWarm = br - bb;

  const mask = new Uint8Array(w * h);
  const insetX = Math.round(w * 0.3);
  const insetY = Math.round(h * 0.3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const d = Math.hypot(r - br, g - bg, b - bb);
      const warm = r - b;
      const looksDesk = d < 38 || (bgWarm > 18 && warm > bgWarm * 0.5 && d < 60);
      const cooler = bgWarm > 12 && warm < bgWarm - 6;
      if (x >= insetX && x < w - insetX && y >= insetY && y < h - insetY) {
        mask[y * w + x] = looksDesk && d < 24 ? 0 : 1;
      } else {
        mask[y * w + x] = looksDesk && !cooler ? 0 : 1;
      }
    }
  }

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      count++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX <= minX || count < w * h * 0.05) throw new Error("未检测到证件边缘");

  const areaRatio = ((maxX - minX) * (maxY - minY)) / (w * h);
  const contour = traceBlobContour(mask, w, h, insetX, insetY);
  if (contour && contour.length > 40) {
    const hull = convexHull(contour);
    const rect = minAreaRectCorners(hull);
    if (rect) {
      const orderedTry = orderCorners(rect);
      // Prefer perspective even if corners are slightly noisy
      for (const shrink of [0.04, 0.07, 0.02]) {
        const ordered = orderCorners(shrinkQuad(orderedTry, shrink));
        if (!isStableQuad(ordered) && shrink === 0.02) continue;
        const [tl, tr, brc, bl] = ordered;
        let outW = Math.round(
          (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(brc.x - bl.x, brc.y - bl.y)) / 2
        );
        let outH = Math.round(
          (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(brc.x - tr.x, brc.y - tr.y)) / 2
        );
        const sized = sizeForOrientation(outW, outH, 85.6 / 54);
        outW = Math.max(64, sized.w);
        outH = Math.max(64, sized.h);
        try {
          const warped = warpPerspective(data, w, h, ordered, outW, outH);
          if (warpLooksSane(warped)) {
            const physical = 85.6 / 54;
            const r = Math.max(warped.width, warped.height) / Math.min(warped.width, warped.height);
            if (Math.abs(r - physical) / physical <= 0.3) return warped;
          }
        } catch {
          /* try next shrink */
        }
      }
    }
  }

  // Axis crop — pull in from desk a bit more aggressively
  if (areaRatio > 0.75) {
    const shrink = Math.round(Math.min(w, h) * 0.06);
    minX = Math.min(minX + shrink, insetX);
    minY = Math.min(minY + shrink, insetY);
    maxX = Math.max(maxX - shrink, w - insetX);
    maxY = Math.max(maxY - shrink, h - insetY);
  }

  // Inset bbox toward card (drop desk fringe)
  const inset = Math.round(Math.min(maxX - minX, maxY - minY) * 0.03);
  minX = Math.min(minX + inset, maxX - 20);
  minY = Math.min(minY + inset, maxY - 20);
  maxX = Math.max(maxX - inset, minX + 20);
  maxY = Math.max(maxY - inset, minY + 20);

  const pad = Math.round(Math.min(w, h) * 0.005);
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
 * @param {{ targetAspect?: number|null }} [opts] targetAspect = width/height (e.g. ID 85.6/54)
 * @returns {HTMLCanvasElement}
 */
export function scanDocument(source, opts = {}) {
  const targetAspect = opts.targetAspect ?? null;
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

  let quad = detectDocumentQuad(smallImg.data, dw, dh, targetAspect);
  let method = "perspective";

  if (!quad) {
    method = "fallback-crop";
    let out = fallbackAxisCrop(srcCanvas, img.data, srcW, srcH);
    out = trimDeskFringe(out);
    out = normalizeIdOrientation(out);
    out = tightenToIdAspect(out, targetAspect);
    out.__bgMeta = { ...(out.__bgMeta || {}), method };
    return out;
  }

  // Map quad from downscaled space back to full resolution
  const srcQuad = quad.map((p) => ({
    x: p.x / scale,
    y: p.y / scale,
  }));

  const [tl0, tr0, br0, bl0] = orderCorners(srcQuad);
  let ordered;
  const stable = isStableQuad([tl0, tr0, br0, bl0]);
  if (!stable) {
    ordered = orderCorners(shrinkQuad([tl0, tr0, br0, bl0], 0.07));
    const areaOk = polygonArea(ordered) > srcW * srcH * 0.1;
    if (!areaOk) {
      method = "fallback-crop";
      let out = fallbackAxisCrop(srcCanvas, img.data, srcW, srcH);
      out = trimDeskFringe(out);
      out = normalizeIdOrientation(out);
      out = tightenToIdAspect(out, targetAspect);
      out.__bgMeta = { ...(out.__bgMeta || {}), method, reason: "unstable-quad" };
      return out;
    }
    // Still try perspective — warpLooksSane will reject smear
    method = "perspective-relaxed";
  } else {
    ordered = orderCorners(shrinkQuad([tl0, tr0, br0, bl0], 0.06));
  }
  const [tl, tr, br, bl] = ordered;
  const widthA = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthB = Math.hypot(br.x - bl.x, br.y - bl.y);
  const heightA = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightB = Math.hypot(br.x - tr.x, br.y - tr.y);
  let outW = Math.max(1, Math.round((widthA + widthB) / 2));
  let outH = Math.max(1, Math.round((heightA + heightB) / 2));

  // Match physical card aspect to DETECTED orientation (portrait photo ≠ force landscape!)
  // targetAspect is physical long/short when card is "wide" (ID ≈ 1.585)
  if (targetAspect && targetAspect > 0.2 && targetAspect < 5) {
    const physical = targetAspect >= 1 ? targetAspect : 1 / targetAspect;
    const sized = sizeForOrientation(outW, outH, physical);
    outW = sized.w;
    outH = sized.h;
  } else {
    const ratio = Math.max(outW, outH) / Math.min(outW, outH);
    const idRatio = 85.6 / 54;
    if (Math.abs(ratio - idRatio) < 0.45) {
      const sized = sizeForOrientation(outW, outH, idRatio);
      outW = sized.w;
      outH = sized.h;
    }
  }

  // Cap resolution for performance / memory
  const maxOut = 2000;
  const outScale = Math.min(1, maxOut / Math.max(outW, outH));
  outW = Math.max(64, Math.round(outW * outScale));
  outH = Math.max(64, Math.round(outH * outScale));

  let out;
  try {
    out = warpPerspective(img.data, srcW, srcH, ordered, outW, outH);
    if (!warpLooksSane(out)) {
      throw new Error("warp-quality");
    }
    const physical =
      targetAspect && targetAspect > 0.2 && targetAspect < 5
        ? targetAspect >= 1
          ? targetAspect
          : 1 / targetAspect
        : 85.6 / 54;
    const r = Math.max(out.width, out.height) / Math.min(out.width, out.height);
    if (Math.abs(r - physical) / physical > 0.28) {
      throw new Error("warp-aspect");
    }
  } catch {
    // Second chance: blob-only quad (often better on wood desks than Canny)
    try {
      const blobQ = detectQuadFromBlob(smallImg.data, dw, dh);
      if (blobQ) {
        const bq = orderCorners(
            shrinkQuad(
            blobQ.map((p) => ({ x: p.x / scale, y: p.y / scale })),
            0.09
          )
        );
        let bw = Math.round(
          (Math.hypot(bq[1].x - bq[0].x, bq[1].y - bq[0].y) +
            Math.hypot(bq[2].x - bq[3].x, bq[2].y - bq[3].y)) /
            2
        );
        let bh = Math.round(
          (Math.hypot(bq[3].x - bq[0].x, bq[3].y - bq[0].y) +
            Math.hypot(bq[2].x - bq[1].x, bq[2].y - bq[1].y)) /
            2
        );
        const physical =
          targetAspect && targetAspect > 0.2 && targetAspect < 5
            ? targetAspect >= 1
              ? targetAspect
              : 1 / targetAspect
            : 85.6 / 54;
        const sized = sizeForOrientation(bw, bh, physical);
        bw = Math.max(64, sized.w);
        bh = Math.max(64, sized.h);
        const blobOut = warpPerspective(img.data, srcW, srcH, bq, bw, bh);
        if (warpLooksSane(blobOut)) {
          const r =
            Math.max(blobOut.width, blobOut.height) / Math.min(blobOut.width, blobOut.height);
          if (Math.abs(r - physical) / physical <= 0.3) {
            out = normalizeIdOrientation(blobOut);
            out.__bgMeta = {
              ...(out.__bgMeta || {}),
              method: "perspective-blob",
              width: out.width,
              height: out.height,
              ratio: out.width / out.height,
              orientation: "landscape",
            };
            return out;
          }
        }
      }
    } catch {
      /* fall through */
    }
    method = "fallback-crop";
    out = fallbackAxisCrop(srcCanvas, img.data, srcW, srcH);
    out = trimDeskFringe(out);
    out = normalizeIdOrientation(out);
    out = tightenToIdAspect(out, targetAspect);
    out.__bgMeta = { ...(out.__bgMeta || {}), method, reason: "bad-warp" };
    return out;
  }

  // Perspective may still leave a hairline of desk — light fringe trim
  out = trimDeskFringe(out);
  out = normalizeIdOrientation(out);
  out.__bgMeta = {
    ...(out.__bgMeta || {}),
    method,
    width: out.width,
    height: out.height,
    ratio: out.width / out.height,
    orientation: out.width >= out.height ? "landscape" : "portrait",
  };
  return out;
}

/** Keep detected portrait/landscape; apply physical long/short ratio. */
function sizeForOrientation(outW, outH, physicalLongOverShort) {
  const long = Math.max(outW, outH);
  if (outW >= outH) {
    return { w: Math.round(long), h: Math.max(32, Math.round(long / physicalLongOverShort)) };
  }
  return { w: Math.max(32, Math.round(long / physicalLongOverShort)), h: Math.round(long) };
}

/** Rotate canvas by 90/180/270 degrees clockwise. */
function rotateCanvas(canvas, deg) {
  const w = canvas.width;
  const h = canvas.height;
  const out = document.createElement("canvas");
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) {
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(canvas, 0, 0);
    return out;
  }
  if (d === 180) {
    out.width = w;
    out.height = h;
  } else {
    out.width = h;
    out.height = w;
  }
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(canvas, -w / 2, -h / 2);
  return out;
}

/**
 * Score how "upright" a landscape ID crop looks.
 * Emblem side: red emblem near top. Photo side: portrait on the right, text on the left.
 */
function scoreIdUpright(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 40 || h < 40) return -1e9;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);

  const region = (x0, y0, rw, rh) => {
    let red = 0;
    let skin = 0;
    let ink = 0;
    let dark = 0;
    let n = 0;
    const step = Math.max(2, Math.floor(Math.min(rw, rh) / 48));
    for (let y = y0; y < y0 + rh; y += step) {
      for (let x = x0; x < x0 + rw; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        n++;
        if (r > 110 && r > g + 25 && r > b + 25) red++;
        // Face / portrait tones
        if (
          r > 80 &&
          g > 40 &&
          b > 20 &&
          r >= g - 5 &&
          r - b > 8 &&
          Math.abs(r - g) < 70 &&
          lum > 40 &&
          lum < 220
        ) {
          skin++;
        }
        if (lum < 100) ink++;
        if (lum < 70) dark++;
      }
    }
    return {
      red: red / (n || 1),
      skin: skin / (n || 1),
      ink: ink / (n || 1),
      dark: dark / (n || 1),
    };
  };

  const top = region(0, 0, w, Math.floor(h * 0.4));
  const bottom = region(0, Math.floor(h * 0.6), w, Math.floor(h * 0.4));
  const left = region(0, 0, Math.floor(w * 0.4), h);
  const right = region(Math.floor(w * 0.6), 0, Math.floor(w * 0.4), h);
  // Portrait box on standard ID: right-central
  const photoBox = region(Math.floor(w * 0.62), Math.floor(h * 0.12), Math.floor(w * 0.32), Math.floor(h * 0.7));
  const antiPhoto = region(Math.floor(w * 0.05), Math.floor(h * 0.12), Math.floor(w * 0.32), Math.floor(h * 0.7));

  const emblemMode = (top.red - bottom.red) * 10 + (bottom.ink - top.ink) * 1.5;
  // Upright photo side: face on right, more text ink on left, photo block darker than left text area
  const photoMode =
    (photoBox.skin - antiPhoto.skin) * 10 +
    (photoBox.dark - antiPhoto.dark) * 4 +
    (left.ink - right.ink) * 2.5 +
    (right.skin - left.skin) * 5;
  return Math.max(emblemMode, photoMode);
}

/**
 * Ensure landscape and upright (pick best among 0/90/180/270).
 */
export function normalizeIdOrientation(canvas) {
  const candidates = [];
  for (const deg of [0, 90, 180, 270]) {
    const c = deg === 0 ? canvas : rotateCanvas(canvas, deg);
    if (c.width < c.height) continue;
    candidates.push({ canvas: c, deg, score: scoreIdUpright(c) });
  }
  if (!candidates.length) {
    // Shouldn't happen; force landscape from portrait
    const c = rotateCanvas(canvas, 90);
    candidates.push({ canvas: c, deg: 90, score: scoreIdUpright(c) });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const out = best.canvas === canvas ? rotateCanvas(canvas, 0) : best.canvas;
  out.__bgMeta = {
    ...(canvas.__bgMeta || {}),
    rotated: best.deg,
    uprightScore: best.score,
    orientation: "landscape",
  };
  return out;
}

/**
 * Trim residual desk fringe after warp (warm wood edges vs cooler card).
 */
function trimDeskFringe(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 48 || h < 48) return canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);

  const pixel = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const warm = ([r, , b]) => r - b;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // Interior reference (card body)
  const ix0 = Math.floor(w * 0.3);
  const iy0 = Math.floor(h * 0.3);
  const ix1 = Math.floor(w * 0.7);
  const iy1 = Math.floor(h * 0.7);
  let cr = 0;
  let cg = 0;
  let cb = 0;
  let cn = 0;
  for (let y = iy0; y < iy1; y += 3) {
    for (let x = ix0; x < ix1; x += 3) {
      const [r, g, b] = pixel(x, y);
      cr += r;
      cg += g;
      cb += b;
      cn++;
    }
  }
  const card = [cr / cn, cg / cn, cb / cn];
  const cardWarm = warm(card);

  const isFringeCol = (x) => {
    let fringe = 0;
    let n = 0;
    for (let y = 0; y < h; y += 2) {
      const p = pixel(x, y);
      n++;
      const d = dist(p, card);
      const wrm = warm(p);
      if (d > 48 && wrm > cardWarm + 14) fringe++;
      else if (d > 70 && wrm > cardWarm + 8) fringe++;
    }
    return fringe / n > 0.55;
  };
  const isFringeRow = (y) => {
    let fringe = 0;
    let n = 0;
    for (let x = 0; x < w; x += 2) {
      const p = pixel(x, y);
      n++;
      const d = dist(p, card);
      const wrm = warm(p);
      if (d > 48 && wrm > cardWarm + 14) fringe++;
      else if (d > 70 && wrm > cardWarm + 8) fringe++;
    }
    return fringe / n > 0.55;
  };

  const maxTrim = Math.floor(Math.min(w, h) * 0.08);
  let left = 0;
  let right = w - 1;
  let top = 0;
  let bottom = h - 1;
  while (left < maxTrim && isFringeCol(left)) left++;
  while (w - 1 - right < maxTrim && isFringeCol(right)) right--;
  while (top < maxTrim && isFringeRow(top)) top++;
  while (h - 1 - bottom < maxTrim && isFringeRow(bottom)) bottom--;

  if (left === 0 && top === 0 && right === w - 1 && bottom === h - 1) return canvas;
  if (right - left < w * 0.5 || bottom - top < h * 0.5) return canvas;

  const cw = right - left + 1;
  const ch = bottom - top + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
  if (canvas.__bgMeta) out.__bgMeta = { ...canvas.__bgMeta, trimmed: [left, top, right, bottom] };
  return out;
}

/**
 * Only for loose fallback crops: if still much wider/taller than ID, trim fringe sides.
 * Never used on successful perspective warps (would clip photo / emblem).
 */
function tightenToIdAspect(canvas, targetAspect) {
  const physical =
    targetAspect && targetAspect > 0.2 && targetAspect < 5
      ? targetAspect >= 1
        ? targetAspect
        : 1 / targetAspect
      : 85.6 / 54;
  const w = canvas.width;
  const h = canvas.height;
  if (w < 48 || h < 48) return canvas;
  const ratio = w / h;
  const err = Math.abs(ratio - physical) / physical;
  // Only fix obviously wrong aspect (desk still included)
  if (err < 0.18) return canvas;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  const stripWarm = (vertical, atStart) => {
    const thickness = Math.max(4, Math.round((vertical ? w : h) * 0.05));
    let warmSum = 0;
    let n = 0;
    if (vertical) {
      const x0 = atStart ? 0 : w - thickness;
      for (let y = 0; y < h; y += 2) {
        for (let x = x0; x < x0 + thickness; x++) {
          const i = (y * w + x) * 4;
          warmSum += data[i] - data[i + 2];
          n++;
        }
      }
    } else {
      const y0 = atStart ? 0 : h - thickness;
      for (let y = y0; y < y0 + thickness; y++) {
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4;
          warmSum += data[i] - data[i + 2];
          n++;
        }
      }
    }
    return warmSum / (n || 1);
  };

  let x0 = 0;
  let y0 = 0;
  let cw = w;
  let ch = h;

  if (ratio > physical) {
    const targetW = Math.round(h * physical);
    const trim = w - targetW;
    if (trim <= 0) return canvas;
    const leftWarm = stripWarm(true, true);
    const rightWarm = stripWarm(true, false);
    let left = Math.round(trim * 0.5);
    if (leftWarm > rightWarm + 4) left = Math.min(trim, Math.round(trim * 0.75));
    else if (rightWarm > leftWarm + 4) left = Math.min(trim, Math.round(trim * 0.25));
    const right = trim - left;
    x0 = left;
    cw = w - left - right;
  } else {
    const targetH = Math.round(w / physical);
    const trim = h - targetH;
    if (trim <= 0) return canvas;
    const topWarm = stripWarm(false, true);
    const botWarm = stripWarm(false, false);
    let top = Math.round(trim * 0.5);
    if (topWarm > botWarm + 4) top = Math.min(trim, Math.round(trim * 0.75));
    else if (botWarm > topWarm + 4) top = Math.min(trim, Math.round(trim * 0.25));
    const bot = trim - top;
    y0 = top;
    ch = h - top - bot;
  }

  if (cw < w * 0.65 || ch < h * 0.65) return canvas;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
  if (canvas.__bgMeta) {
    out.__bgMeta = { ...canvas.__bgMeta, aspectTightened: true, ratio: cw / ch };
  }
  return out;
}

function isStableQuad(quad) {
  const area = polygonArea(quad);
  if (area < 100) return false;
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sides.push(Math.hypot(a.x - b.x, a.y - b.y));
  }
  const minS = Math.min(...sides);
  const maxS = Math.max(...sides);
  if (minS < 8 || maxS / minS > 6) return false;
  // Reject near-degenerate (almost collinear) quads via cross products
  for (let i = 0; i < 4; i++) {
    const p0 = quad[i];
    const p1 = quad[(i + 1) % 4];
    const p2 = quad[(i + 2) % 4];
    const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (Math.abs(cross) < 8) return false;
  }
  return true;
}

/** Reject smeared / exploded warps (common when aspect forced wrong way). */
function warpLooksSane(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 40 || h < 40) return false;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  // Sample a grid; expect decent color variance (ID cards aren't one smear)
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const step = Math.max(4, Math.floor(Math.min(w, h) / 40));
  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sum2 += lum * lum;
      n++;
    }
  }
  if (n < 16) return false;
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  // Real ID photos have texture; exploded warps often low-variance smear OR extreme
  if (variance < 600) return false;
  // Reject motion-smear / exploded warps: expect some edge energy
  let edge = 0;
  let en = 0;
  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const i = (y * w + x) * 4;
      const j = (y * w + x + step) * 4;
      const k = ((y + step) * w + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const lumR = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      const lumD = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
      edge += Math.abs(lum - lumR) + Math.abs(lum - lumD);
      en++;
    }
  }
  if (en > 0 && edge / en < 6) return false;
  return true;
}

export const __testDocscan = {
  orderCorners,
  scoreQuad,
  approxPolyDP,
  polygonArea,
  sizeForOrientation,
  isStableQuad,
  scoreIdUpright,
  normalizeIdOrientation,
  trimDeskFringe,
};
