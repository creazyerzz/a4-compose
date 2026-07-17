import { processImage } from "./enhance.js";

/** A4 size in millimeters */
export const A4_MM = { w: 210, h: 297 };
/** Preview canvas ≈ 96 DPI A4 (794×1123) */
export const PREVIEW_DPI = 96;

export function mmToPx(mm, dpi = PREVIEW_DPI) {
  return (mm / 25.4) * dpi;
}

let nextId = 1;

/**
 * @typedef {{ id: number, name: string, img: CanvasImageSource, objectUrl: string, x: number, y: number, w: number, h: number }} StageItem
 */

export class A4Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.pageW = canvas.width;
    this.pageH = canvas.height;
    /** @type {StageItem[]} bottom → top */
    this.items = [];
    /** @type {number|null} */
    this.selectedId = null;
    this.drag = null;
    this.options = { enhance: false, docMode: false, strength: 60 };
    /** @type {Map<number, HTMLCanvasElement>} */
    this._processed = new Map();
    this._optionsKey = "";
    this._raf = 0;

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
    this._invalidateProcessed();
    this.requestRender();
  }

  _invalidateProcessed() {
    this._processed.clear();
    this._optionsKey = "";
  }

  get selected() {
    return this.items.find((it) => it.id === this.selectedId) || null;
  }

  getSelectionLabel() {
    const it = this.selected;
    return it ? it.name : "未选中";
  }

  /**
   * @param {File} file
   */
  async addImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const fit = fitInside(
        img.naturalWidth || img.width,
        img.naturalHeight || img.height,
        this.pageW * 0.72,
        this.pageH * 0.36
      );
      const offset = (this.items.length % 6) * 18;
      const item = {
        id: nextId++,
        name: file.name || `image-${nextId}`,
        img,
        objectUrl: url,
        x: (this.pageW - fit.w) / 2 + offset,
        y: this.pageH * 0.12 + offset,
        w: fit.w,
        h: fit.h,
      };
      this.items.push(item);
      this.selectedId = item.id;
      this.requestRender();
      this.onChange?.();
      return item;
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }

  /**
   * @param {FileList|File[]} files
   */
  async addImages(files) {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    for (const file of list) {
      await this.addImage(file);
    }
    return list.length;
  }

  removeSelected() {
    const id = this.selectedId;
    if (id == null) return false;
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx < 0) return false;
    const [removed] = this.items.splice(idx, 1);
    URL.revokeObjectURL(removed.objectUrl);
    this._processed.delete(id);
    this.selectedId = this.items[Math.min(idx, this.items.length - 1)]?.id ?? null;
    this.requestRender();
    this.onChange?.();
    return true;
  }

  async duplicateSelected() {
    const src = this.selected;
    if (!src) return null;
    const canvas = document.createElement("canvas");
    const w = src.img.naturalWidth || src.img.width;
    const h = src.img.naturalHeight || src.img.height;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(src.img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const file = new File([blob], src.name.replace(/(\.\w+)?$/, "-copy$1"), {
      type: "image/png",
    });
    const item = await this.addImage(file);
    item.x = src.x + 20;
    item.y = src.y + 20;
    item.w = src.w;
    item.h = src.h;
    this.requestRender();
    this.onChange?.();
    return item;
  }

  clear() {
    for (const it of this.items) URL.revokeObjectURL(it.objectUrl);
    this.items = [];
    this.selectedId = null;
    this._invalidateProcessed();
    this.requestRender();
    this.onChange?.();
  }

  select(id) {
    this.selectedId = id;
    this.requestRender();
    this.onChange?.();
  }

  bringToFront() {
    const it = this.selected;
    if (!it) return;
    this.items = this.items.filter((x) => x.id !== it.id);
    this.items.push(it);
    this.requestRender();
    this.onChange?.();
  }

  sendToBack() {
    const it = this.selected;
    if (!it) return;
    this.items = this.items.filter((x) => x.id !== it.id);
    this.items.unshift(it);
    this.requestRender();
    this.onChange?.();
  }

  /** Stack images vertically with margins (good default for ID / docs). */
  autoLayout() {
    const n = this.items.length;
    if (!n) return;
    const marginX = mmToPx(18);
    const marginY = mmToPx(18);
    const gap = mmToPx(12);
    const maxW = this.pageW - marginX * 2;
    const availH = this.pageH - marginY * 2 - gap * Math.max(0, n - 1);
    const slotH = availH / n;

    for (const it of this.items) {
      const nw = it.img.naturalWidth || it.img.width;
      const nh = it.img.naturalHeight || it.img.height;
      const fit = fitInside(nw, nh, maxW, slotH);
      it.w = fit.w;
      it.h = fit.h;
    }

    let y = marginY;
    for (const it of this.items) {
      it.x = (this.pageW - it.w) / 2;
      it.y = y + (slotH - it.h) / 2;
      y += slotH + gap;
    }
    this.requestRender();
  }

  centerHorizontally() {
    for (const it of this.items) {
      it.x = (this.pageW - it.w) / 2;
    }
    this.requestRender();
  }

  _hitTest(x, y) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) {
        return it;
      }
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
    this.selectedId = hit?.id ?? null;
    this.onChange?.();
    if (!hit) {
      this.requestRender();
      return;
    }
    this.drag = { id: hit.id, ox: p.x - hit.x, oy: p.y - hit.y };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
    this.requestRender();
  }

  _onPointerMove(e) {
    if (!this.drag) {
      const p = this._eventPos(e);
      this.canvas.style.cursor = this._hitTest(p.x, p.y) ? "grab" : "default";
      return;
    }
    const it = this.items.find((x) => x.id === this.drag.id);
    if (!it) return;
    const p = this._eventPos(e);
    it.x = p.x - this.drag.ox;
    it.y = p.y - this.drag.oy;
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
    const it = this.selected;
    if (!it) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    const nw = it.w * factor;
    const nh = it.h * factor;
    if (nw < 24 || nw > this.pageW * 1.5) return;
    it.x -= (nw - it.w) / 2;
    it.y -= (nh - it.h) / 2;
    it.w = nw;
    it.h = nh;
    this.requestRender();
  }

  _optionsSignature() {
    return `${this.options.enhance}|${this.options.docMode}|${this.options.strength}`;
  }

  _ensureProcessed(item) {
    const sig = this._optionsSignature();
    if (sig !== this._optionsKey) {
      this._processed.clear();
      this._optionsKey = sig;
    }
    if (!this.options.enhance && !this.options.docMode) {
      return item.img;
    }
    if (!this._processed.has(item.id)) {
      this._processed.set(item.id, processImage(item.img, this.options));
    }
    return this._processed.get(item.id);
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

    ctx.save();
    ctx.strokeStyle = "rgba(11, 110, 79, 0.12)";
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(mmToPx(15), mmToPx(15), pageW - mmToPx(30), pageH - mmToPx(30));
    ctx.restore();

    if (!this.items.length) {
      ctx.fillStyle = "#7a8b9c";
      ctx.font = "15px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("添加图片后，可在此 A4 画布中拖动排版", pageW / 2, pageH / 2);
      return;
    }

    for (const it of this.items) {
      const src = this._ensureProcessed(it);
      ctx.drawImage(src, it.x, it.y, it.w, it.h);
      if (it.id === this.selectedId) {
        ctx.save();
        ctx.strokeStyle = "#0b6e4f";
        ctx.lineWidth = 2;
        ctx.strokeRect(it.x - 1, it.y - 1, it.w + 2, it.h + 2);
        ctx.restore();
      }
    }
  }

  /**
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

    for (const it of this.items) {
      const src = this._ensureProcessed(it);
      ctx.drawImage(src, it.x * scale, it.y * scale, it.w * scale, it.h * scale);
    }
    return out;
  }
}

function fitInside(srcW, srcH, maxW, maxH) {
  const s = Math.min(maxW / srcW, maxH / srcH);
  return { w: srcW * s, h: srcH * s };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = url;
  });
}
