import { processImage, removeBackground } from "./enhance.js";
import {
  DEFAULT_PRESET_ID,
  getPreset,
  mmToPx,
  pageSizePx,
  PREVIEW_DPI,
} from "./presets.js";

export { PREVIEW_DPI, mmToPx };

let nextId = 1;

/**
 * @typedef {{
 *   id: number,
 *   name: string,
 *   img: CanvasImageSource,
 *   objectUrl: string|null,
 *   x: number, y: number, w: number, h: number,
 *   rotation: number,
 *   bgRemoved?: boolean
 * }} StageItem
 */

export class A4Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.preset = getPreset(DEFAULT_PRESET_ID);
    const size = pageSizePx(this.preset);
    this.pageW = size.w;
    this.pageH = size.h;
    canvas.width = size.w;
    canvas.height = size.h;
    /** @type {StageItem[]} bottom → top */
    this.items = [];
    /** @type {number|null} */
    this.selectedId = null;
    this.drag = null;
    this.options = { enhance: false, docMode: false, strength: 70 };
    /** @type {Map<number, HTMLCanvasElement>} */
    this._processed = new Map();
    this._optionsKey = "";
    this._raf = 0;
    this._pulseUntil = 0;
    this._anim = null;

    this._bind();
    this.requestRender();
  }

  /**
   * Switch canvas / document template.
   * @param {string} presetId
   */
  setPreset(presetId) {
    const preset = getPreset(presetId);
    this.preset = preset;
    const size = pageSizePx(preset);
    const sx = size.w / this.pageW;
    const sy = size.h / this.pageH;
    this.pageW = size.w;
    this.pageH = size.h;
    this.canvas.width = size.w;
    this.canvas.height = size.h;
    // Scale existing items roughly into new page
    for (const it of this.items) {
      it.x *= sx;
      it.y *= sy;
      it.w *= sx;
      it.h *= sy;
    }
    this.requestRender();
    this.onChange?.();
    return preset;
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
    if (!it) return "未选中";
    const rot = Math.round(it.rotation) % 360;
    return rot ? `${it.name} · ${rot}°` : it.name;
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
        rotation: 0,
        bgRemoved: false,
        _backup: null,
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
    if (removed.objectUrl) URL.revokeObjectURL(removed.objectUrl);
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
    item.rotation = src.rotation;
    item.bgRemoved = src.bgRemoved;
    this.requestRender();
    this.onChange?.();
    return item;
  }

  clear() {
    for (const it of this.items) {
      if (it.objectUrl) URL.revokeObjectURL(it.objectUrl);
    }
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
    if (!it) return false;
    this.items = this.items.filter((x) => x.id !== it.id);
    this.items.push(it);
    this._flash(it);
    this.requestRender();
    this.onChange?.();
    return true;
  }

  sendToBack() {
    const it = this.selected;
    if (!it) return false;
    this.items = this.items.filter((x) => x.id !== it.id);
    this.items.unshift(it);
    this._flash(it);
    this.requestRender();
    this.onChange?.();
    return true;
  }

  _flash(it) {
    this._pulseUntil = performance.now() + 450;
    this._pulseId = it.id;
    const tick = () => {
      this.requestRender();
      if (performance.now() < this._pulseUntil) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /**
   * Animate horizontal center for selected (or all if none selected).
   */
  centerHorizontally() {
    const targets = this.selected ? [this.selected] : this.items;
    if (!targets.length) return false;
    const goals = targets.map((it) => ({
      it,
      fromX: it.x,
      toX: (this.pageW - it.w) / 2,
    }));
    const needMove = goals.some((g) => Math.abs(g.toX - g.fromX) > 0.5);
    this._animate(280, (t) => {
      const e = easeOutCubic(t);
      for (const g of goals) {
        g.it.x = g.fromX + (g.toX - g.fromX) * e;
      }
    });
    if (this.selected) this._flash(this.selected);
    return needMove;
  }

  rotateSelected(deltaDeg) {
    const it = this.selected;
    if (!it) return false;
    it.rotation = ((it.rotation + deltaDeg) % 360 + 360) % 360;
    this.requestRender();
    this.onChange?.();
    return true;
  }

  setSelectedRotation(deg) {
    const it = this.selected;
    if (!it) return false;
    it.rotation = ((deg % 360) + 360) % 360;
    this.requestRender();
    this.onChange?.();
    return true;
  }

  /**
   * Smart crop selected item (CamScanner-style).
   * Always runs on the ORIGINAL upload (backup) — never nest-crops a cropped result.
   * @returns {{ ok: true, meta: object, recrop?: boolean } | { ok: false, message: string }}
   */
  removeSelectedBackground() {
    const it = this.selected;
    if (!it) return { ok: false, message: "请先选中一张图片" };

    // Snapshot ORIGINAL pixels once; later clicks always re-crop from this
    if (!it._backup) {
      const bw = it.img.naturalWidth || it.img.width;
      const bh = it.img.naturalHeight || it.img.height;
      const snap = document.createElement("canvas");
      snap.width = bw;
      snap.height = bh;
      snap.getContext("2d").drawImage(it.img, 0, 0);
      it._backup = {
        canvas: snap,
        w: it.w,
        h: it.h,
        x: it.x,
        y: it.y,
      };
    }

    const source = it._backup.canvas;
    const wasCropped = !!it.bgRemoved;

    try {
      const cleaned = removeBackground(source, {
        targetAspect: this.preset.scanAspect,
      });
      // Fit into first empty guide if any, else keep center
      const guide = this._nextGuideSlot();
      const prevCx = it.x + it.w / 2;
      const prevCy = it.y + it.h / 2;
      if (guide) {
        const fit = fitInside(cleaned.width, cleaned.height, guide.w, guide.h);
        it.img = cleaned;
        it.bgRemoved = true;
        it.rotation = 0;
        it.w = fit.w;
        it.h = fit.h;
        it.x = guide.x + (guide.w - fit.w) / 2;
        it.y = guide.y + (guide.h - fit.h) / 2;
      } else {
        const maxW = this.pageW * 0.72;
        const maxH = this.pageH * 0.4;
        const fit = Math.min(maxW / cleaned.width, maxH / cleaned.height);
        it.img = cleaned;
        it.bgRemoved = true;
        it.rotation = 0;
        it.w = cleaned.width * fit;
        it.h = cleaned.height * fit;
        it.x = prevCx - it.w / 2;
        it.y = prevCy - it.h / 2;
      }
      this._processed.delete(it.id);
      this._flash(it);
      this.requestRender();
      this.onChange?.();
      return {
        ok: true,
        recrop: wasCropped,
        meta: cleaned.__bgMeta || {},
      };
    } catch (err) {
      return {
        ok: false,
        message: err?.message || "智能裁切失败",
      };
    }
  }

  /** Restore image from before document scan. */
  undoBackground() {
    const it = this.selected;
    if (!it?._backup) return false;
    const b = it._backup;
    it.img = b.canvas;
    it.w = b.w;
    it.h = b.h;
    it.x = b.x;
    it.y = b.y;
    it.bgRemoved = false;
    this._processed.delete(it.id);
    this._flash(it);
    this.requestRender();
    this.onChange?.();
    return true;
  }

  /** Pick first guide that doesn't already contain an item center. */
  _nextGuideSlot() {
    const guides = this.preset.guides || [];
    if (!guides.length) return null;
    for (const g of guides) {
      const slot = {
        x: mmToPx(g.xMm),
        y: mmToPx(g.yMm),
        w: mmToPx(g.wMm),
        h: mmToPx(g.hMm),
      };
      const occupied = this.items.some((it) => {
        if (it.id === this.selectedId) return false;
        const cx = it.x + it.w / 2;
        const cy = it.y + it.h / 2;
        return cx >= slot.x && cx <= slot.x + slot.w && cy >= slot.y && cy <= slot.y + slot.h;
      });
      if (!occupied) return slot;
    }
    // all occupied → last guide
    const g = guides[guides.length - 1];
    return {
      x: mmToPx(g.xMm),
      y: mmToPx(g.yMm),
      w: mmToPx(g.wMm),
      h: mmToPx(g.hMm),
    };
  }

  /** Layout according to current canvas preset. */
  autoLayout() {
    const n = this.items.length;
    if (!n) return;
    const layout = this.preset.layout;

    if (layout === "id-duo" && this.preset.guides.length) {
      const goals = [];
      for (let i = 0; i < n; i++) {
        const it = this.items[i];
        const g = this.preset.guides[Math.min(i, this.preset.guides.length - 1)];
        const slot = {
          x: mmToPx(g.xMm),
          y: mmToPx(g.yMm),
          w: mmToPx(g.wMm),
          h: mmToPx(g.hMm),
        };
        it.rotation = 0;
        const nw = it.img.naturalWidth || it.img.width;
        const nh = it.img.naturalHeight || it.img.height;
        const fit = fitInside(nw, nh, slot.w, slot.h);
        goals.push({
          it,
          fromX: it.x,
          fromY: it.y,
          fromW: it.w,
          fromH: it.h,
          toX: slot.x + (slot.w - fit.w) / 2,
          toY: slot.y + (slot.h - fit.h) / 2,
          toW: fit.w,
          toH: fit.h,
        });
      }
      this._animate(320, (t) => {
        const e = easeOutCubic(t);
        for (const g of goals) {
          g.it.x = g.fromX + (g.toX - g.fromX) * e;
          g.it.y = g.fromY + (g.toY - g.fromY) * e;
          g.it.w = g.fromW + (g.toW - g.fromW) * e;
          g.it.h = g.fromH + (g.toH - g.fromH) * e;
        }
      });
      return;
    }

    if (layout === "single-page" && this.preset.guides[0]) {
      const g = this.preset.guides[0];
      const slot = {
        x: mmToPx(g.xMm),
        y: mmToPx(g.yMm),
        w: mmToPx(g.wMm),
        h: mmToPx(g.hMm),
      };
      const it = this.items[0];
      it.rotation = 0;
      const nw = it.img.naturalWidth || it.img.width;
      const nh = it.img.naturalHeight || it.img.height;
      const fit = fitInside(nw, nh, slot.w, slot.h);
      const goals = [
        {
          it,
          fromX: it.x,
          fromY: it.y,
          fromW: it.w,
          fromH: it.h,
          toX: slot.x + (slot.w - fit.w) / 2,
          toY: slot.y + (slot.h - fit.h) / 2,
          toW: fit.w,
          toH: fit.h,
        },
      ];
      // Extra images below if any
      for (let i = 1; i < n; i++) {
        const extra = this.items[i];
        extra.rotation = 0;
        const fit2 = fitInside(
          extra.img.naturalWidth || extra.img.width,
          extra.img.naturalHeight || extra.img.height,
          slot.w * 0.5,
          slot.h * 0.25
        );
        goals.push({
          it: extra,
          fromX: extra.x,
          fromY: extra.y,
          fromW: extra.w,
          fromH: extra.h,
          toX: slot.x + (slot.w - fit2.w) / 2,
          toY: slot.y + slot.h - fit2.h - mmToPx(4) + i * mmToPx(2),
          toW: fit2.w,
          toH: fit2.h,
        });
      }
      this._animate(320, (t) => {
        const e = easeOutCubic(t);
        for (const g of goals) {
          g.it.x = g.fromX + (g.toX - g.fromX) * e;
          g.it.y = g.fromY + (g.toY - g.fromY) * e;
          g.it.w = g.fromW + (g.toW - g.fromW) * e;
          g.it.h = g.fromH + (g.toH - g.fromH) * e;
        }
      });
      return;
    }

    // free: vertical stack
    const marginX = mmToPx(this.preset.marginMm);
    const marginY = mmToPx(this.preset.marginMm);
    const gap = mmToPx(12);
    const maxW = this.pageW - marginX * 2;
    const availH = this.pageH - marginY * 2 - gap * Math.max(0, n - 1);
    const slotH = availH / n;

    for (const it of this.items) {
      it.rotation = 0;
      const nw = it.img.naturalWidth || it.img.width;
      const nh = it.img.naturalHeight || it.img.height;
      const fit = fitInside(nw, nh, maxW, slotH);
      it.w = fit.w;
      it.h = fit.h;
    }

    const goals = [];
    let y = marginY;
    for (const it of this.items) {
      goals.push({
        it,
        fromX: it.x,
        fromY: it.y,
        toX: (this.pageW - it.w) / 2,
        toY: y + (slotH - it.h) / 2,
      });
      y += slotH + gap;
    }
    this._animate(320, (t) => {
      const e = easeOutCubic(t);
      for (const g of goals) {
        g.it.x = g.fromX + (g.toX - g.fromX) * e;
        g.it.y = g.fromY + (g.toY - g.fromY) * e;
      }
    });
  }

  _animate(ms, fn) {
    if (this._anim) cancelAnimationFrame(this._anim.raf);
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      fn(t);
      this.requestRender();
      if (t < 1) {
        this._anim = { raf: requestAnimationFrame(step) };
      } else {
        this._anim = null;
      }
    };
    this._anim = { raf: requestAnimationFrame(step) };
  }

  _localPoint(it, x, y) {
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const rad = (-it.rotation * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      x: dx * cos - dy * sin + it.w / 2,
      y: dx * sin + dy * cos + it.h / 2,
    };
  }

  _hitTest(x, y) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const lp = this._localPoint(it, x, y);
      if (lp.x >= 0 && lp.x <= it.w && lp.y >= 0 && lp.y <= it.h) return it;
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
    if (e.shiftKey) {
      it.rotation = ((it.rotation + (e.deltaY < 0 ? -3 : 3)) % 360 + 360) % 360;
      this.onChange?.();
      this.requestRender();
      return;
    }
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

  _drawItem(ctx, it, src) {
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((it.rotation * Math.PI) / 180);
    ctx.drawImage(src, -it.w / 2, -it.h / 2, it.w, it.h);

    const pulsing =
      it.id === this._pulseId && performance.now() < this._pulseUntil;
    if (it.id === this.selectedId || pulsing) {
      ctx.strokeStyle = pulsing ? "#e11d48" : "#0b6e4f";
      ctx.lineWidth = pulsing ? 3 : 2;
      ctx.strokeRect(-it.w / 2 - 1, -it.h / 2 - 1, it.w + 2, it.h + 2);
      // rotation handle hint
      if (it.id === this.selectedId) {
        ctx.fillStyle = "#0b6e4f";
        ctx.beginPath();
        ctx.arc(0, -it.h / 2 - 14, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#0b6e4f";
        ctx.beginPath();
        ctx.moveTo(0, -it.h / 2);
        ctx.lineTo(0, -it.h / 2 - 10);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  render() {
    const { ctx, pageW, pageH } = this;
    ctx.clearRect(0, 0, pageW, pageH);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pageW, pageH);

    ctx.save();
    ctx.strokeStyle = "rgba(11, 110, 79, 0.12)";
    ctx.setLineDash([6, 6]);
    const m = mmToPx(this.preset.marginMm);
    ctx.strokeRect(m, m, pageW - m * 2, pageH - m * 2);
    ctx.restore();

    // Template guides (ID slots / hukou frame)
    for (const g of this.preset.guides || []) {
      const x = mmToPx(g.xMm);
      const y = mmToPx(g.yMm);
      const w = mmToPx(g.wMm);
      const h = mmToPx(g.hMm);
      ctx.save();
      ctx.strokeStyle = "rgba(11, 110, 79, 0.35)";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(11, 110, 79, 0.55)";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(g.label, x + 4, y - 4);
      ctx.restore();
    }

    if (!this.items.length) {
      ctx.fillStyle = "#7a8b9c";
      ctx.font = "15px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `「${this.preset.name}」添加图片后可拖动 / 旋转排版`,
        pageW / 2,
        pageH / 2
      );
      return;
    }

    for (const it of this.items) {
      const src = this._ensureProcessed(it);
      this._drawItem(ctx, it, src);
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
      const cx = (it.x + it.w / 2) * scale;
      const cy = (it.y + it.h / 2) * scale;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((it.rotation * Math.PI) / 180);
      ctx.drawImage(src, (-it.w / 2) * scale, (-it.h / 2) * scale, it.w * scale, it.h * scale);
      ctx.restore();
    }
    return out;
  }
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
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
