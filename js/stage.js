import { processImage } from "./enhance.js";

/** A4 mm and screen preview scale (96 CSS px ≈ 25.4mm → ~3.78 px/mm; we use fixed preview). */
export const A4_MM = { w: 210, h: 297 };
export const ID_MM = { w: 85.6, h: 54 };
/** Preview: 794×1123 ≈ 96dpi A4 */
export const PREVIEW_DPI = 96;

export function mmToPx(mm, dpi = PREVIEW_DPI) {
  return (mm / 25.4) * dpi;
}

function defaultSlots(pageW, pageH) {
  const cardW = mmToPx(ID_MM.w);
  const cardH = mmToPx(ID_MM.h);
  const gap = mmToPx(18);
  const totalH = cardH * 2 + gap;
  const top = (pageH - totalH) / 2;
  const x = (pageW - cardW) / 2;
  return {
    front: { x, y: top, w: cardW, h: cardH },
    back: { x, y: top + cardH + gap, w: cardW, h: cardH },
  };
}

export class A4Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.pageW = canvas.width;
    this.pageH = canvas.height;
    this.items = {
      front: null,
      back: null,
    };
    this.selected = null;
    this.drag = null;
    this.options = { enhance: false, docMode: false, strength: 60 };
    this._cache = { front: null, back: null, key: "" };
    this._raf = 0;

    const slots = defaultSlots(this.pageW, this.pageH);
    this.layout = {
      front: { ...slots.front },
      back: { ...slots.back },
    };

    this._bind();
    this.requestRender();
  }

  _bind() {
    const el = this.canvas;
    el.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    el.addEventListener("pointermove", (e) => this._onPointerMove(e));
    el.addEventListener("pointerup", (e) => this._onPointerUp(e));
    el.addEventListener("pointercancel", (e) => this._onPointerUp(e));
    el.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
  }

  setOptions(partial) {
    Object.assign(this.options, partial);
    this._cache.key = "";
    this.requestRender();
  }

  async setImage(side, file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      if (this.items[side]?.objectUrl) URL.revokeObjectURL(this.items[side].objectUrl);
      this.items[side] = { img, name: file.name, objectUrl: url };
      this._cache.key = "";
      this.selected = side;
      this.requestRender();
      return file.name;
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  resetLayout() {
    const slots = defaultSlots(this.pageW, this.pageH);
    this.layout.front = { ...slots.front };
    this.layout.back = { ...slots.back };
    this.requestRender();
  }

  centerHorizontally() {
    for (const side of ["front", "back"]) {
      const L = this.layout[side];
      L.x = (this.pageW - L.w) / 2;
    }
    this.requestRender();
  }

  getSelectionLabel() {
    if (!this.selected) return "未选中";
    return this.selected === "front" ? "正面" : "反面";
  }

  _hitTest(x, y) {
    const order = this.selected ? [this.selected, this.selected === "front" ? "back" : "front"] : ["front", "back"];
    for (const side of order) {
      if (!this.items[side]) continue;
      const L = this.layout[side];
      if (x >= L.x && x <= L.x + L.w && y >= L.y && y <= L.y + L.h) return side;
    }
    return null;
  }

  _eventPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  }

  _onPointerDown(e) {
    const p = this._eventPos(e);
    const hit = this._hitTest(p.x, p.y);
    this.selected = hit;
    if (!hit) {
      this.requestRender();
      this.onSelectionChange?.();
      return;
    }
    const L = this.layout[hit];
    this.drag = {
      side: hit,
      ox: p.x - L.x,
      oy: p.y - L.y,
    };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
    this.requestRender();
    this.onSelectionChange?.();
  }

  _onPointerMove(e) {
    if (!this.drag) {
      const p = this._eventPos(e);
      this.canvas.style.cursor = this._hitTest(p.x, p.y) ? "grab" : "default";
      return;
    }
    const p = this._eventPos(e);
    const L = this.layout[this.drag.side];
    L.x = p.x - this.drag.ox;
    L.y = p.y - this.drag.oy;
    this.requestRender();
  }

  _onPointerUp(e) {
    if (!this.drag) return;
    this.drag = null;
    this.canvas.style.cursor = "default";
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  _onWheel(e) {
    if (!this.selected || !this.items[this.selected]) return;
    e.preventDefault();
    const L = this.layout[this.selected];
    const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    const nw = L.w * factor;
    const nh = L.h * factor;
    if (nw < 40 || nw > this.pageW * 1.2) return;
    L.x -= (nw - L.w) / 2;
    L.y -= (nh - L.h) / 2;
    L.w = nw;
    L.h = nh;
    this.requestRender();
  }

  _processKey() {
    return `${this.options.enhance}|${this.options.docMode}|${this.options.strength}|${this.items.front?.name}|${this.items.back?.name}`;
  }

  _ensureProcessed(side) {
    const item = this.items[side];
    if (!item) return null;
    const key = this._processKey();
    if (this._cache.key !== key) {
      this._cache = { front: null, back: null, key };
    }
    if (!this._cache[side]) {
      this._cache[side] = processImage(item.img, this.options);
    }
    return this._cache[side];
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  render() {
    const { ctx, pageW, pageH } = this;
    ctx.clearRect(0, 0, pageW, pageH);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pageW, pageH);

    // light guide
    ctx.save();
    ctx.strokeStyle = "rgba(11, 110, 79, 0.12)";
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(mmToPx(15), mmToPx(15), pageW - mmToPx(30), pageH - mmToPx(30));
    ctx.restore();

    for (const side of ["front", "back"]) {
      const processed = this._ensureProcessed(side);
      if (!processed) {
        this._drawPlaceholder(side);
        continue;
      }
      const L = this.layout[side];
      ctx.drawImage(processed, L.x, L.y, L.w, L.h);
      if (this.selected === side) {
        ctx.save();
        ctx.strokeStyle = "#0b6e4f";
        ctx.lineWidth = 2;
        ctx.strokeRect(L.x - 1, L.y - 1, L.w + 2, L.h + 2);
        ctx.restore();
      }
    }
  }

  _drawPlaceholder(side) {
    const L = this.layout[side];
    ctxRoundRect(this.ctx, L.x, L.y, L.w, L.h, 6);
    this.ctx.fillStyle = "#f1f5f9";
    this.ctx.fill();
    this.ctx.strokeStyle = "#c5d0dc";
    this.ctx.setLineDash([8, 6]);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.fillStyle = "#7a8b9c";
    this.ctx.font = "14px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(side === "front" ? "上传身份证正面" : "上传身份证反面", L.x + L.w / 2, L.y + L.h / 2);
  }

  /**
   * Render final A4 page at target DPI for export.
   * @param {number} dpi
   * @returns {HTMLCanvasElement}
   */
  renderExport(dpi) {
    const scale = dpi / PREVIEW_DPI;
    const out = document.createElement("canvas");
    out.width = Math.round(this.pageW * scale);
    out.height = Math.round(this.pageH * scale);
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);

    for (const side of ["front", "back"]) {
      const processed = this._ensureProcessed(side);
      if (!processed) continue;
      const L = this.layout[side];
      ctx.drawImage(
        processed,
        L.x * scale,
        L.y * scale,
        L.w * scale,
        L.h * scale
      );
    }
    return out;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = url;
  });
}

function ctxRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
