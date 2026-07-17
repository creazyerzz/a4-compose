/**
 * Canvas / document presets (page size, guides, scan aspect).
 * Dimensions in millimeters unless noted.
 */

/** Preview DPI used by the on-screen canvas */
export const PREVIEW_DPI = 96;

export function mmToPx(mm, dpi = PREVIEW_DPI) {
  return (mm / 25.4) * dpi;
}

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   desc: string,
 *   pageMm: { w: number, h: number },
 *   marginMm: number,
 *   scanAspect: number|null,
 *   scanLabel: string,
 *   layout: 'free' | 'id-duo' | 'single-page',
 *   guides: Array<{ label: string, xMm: number, yMm: number, wMm: number, hMm: number }>
 * }} CanvasPreset
 */

/** Chinese resident ID card */
const ID_CARD_MM = { w: 85.6, h: 54 };

/** Approximate hukou booklet page (户口页) when placed on A4 */
const HUKOU_PAGE_MM = { w: 140, h: 200 };

/** Residence permit is same physical size as ID card */
const RESIDENCE_MM = { w: 85.6, h: 54 };

/**
 * @type {Record<string, CanvasPreset>}
 */
export const CANVAS_PRESETS = {
  "a4-free": {
    id: "a4-free",
    name: "A4 通用",
    desc: "空白 A4，自由拖放多张图片",
    pageMm: { w: 210, h: 297 },
    marginMm: 15,
    scanAspect: null,
    scanLabel: "文档",
    layout: "free",
    guides: [],
  },
  "id-card": {
    id: "id-card",
    name: "身份证复印",
    desc: "A4 上正反面标准排版（85.6×54 mm）",
    pageMm: { w: 210, h: 297 },
    marginMm: 18,
    scanAspect: ID_CARD_MM.w / ID_CARD_MM.h,
    scanLabel: "身份证",
    layout: "id-duo",
    guides: (() => {
      const gap = 18;
      const totalH = ID_CARD_MM.h * 2 + gap;
      const top = (297 - totalH) / 2;
      const x = (210 - ID_CARD_MM.w) / 2;
      return [
        { label: "正面", xMm: x, yMm: top, wMm: ID_CARD_MM.w, hMm: ID_CARD_MM.h },
        {
          label: "反面",
          xMm: x,
          yMm: top + ID_CARD_MM.h + gap,
          wMm: ID_CARD_MM.w,
          hMm: ID_CARD_MM.h,
        },
      ];
    })(),
  },
  "hukou-page": {
    id: "hukou-page",
    name: "户口页",
    desc: "A4 居中单页（约 140×200 mm）",
    pageMm: { w: 210, h: 297 },
    marginMm: 15,
    scanAspect: HUKOU_PAGE_MM.w / HUKOU_PAGE_MM.h,
    scanLabel: "户口页",
    layout: "single-page",
    guides: [
      {
        label: "户口页",
        xMm: (210 - HUKOU_PAGE_MM.w) / 2,
        yMm: (297 - HUKOU_PAGE_MM.h) / 2,
        wMm: HUKOU_PAGE_MM.w,
        hMm: HUKOU_PAGE_MM.h,
      },
    ],
  },
  "residence": {
    id: "residence",
    name: "居住证复印",
    desc: "与身份证同尺寸的正反面排版",
    pageMm: { w: 210, h: 297 },
    marginMm: 18,
    scanAspect: RESIDENCE_MM.w / RESIDENCE_MM.h,
    scanLabel: "居住证",
    layout: "id-duo",
    guides: (() => {
      const gap = 18;
      const totalH = RESIDENCE_MM.h * 2 + gap;
      const top = (297 - totalH) / 2;
      const x = (210 - RESIDENCE_MM.w) / 2;
      return [
        { label: "正面", xMm: x, yMm: top, wMm: RESIDENCE_MM.w, hMm: RESIDENCE_MM.h },
        {
          label: "反面",
          xMm: x,
          yMm: top + RESIDENCE_MM.h + gap,
          wMm: RESIDENCE_MM.w,
          hMm: RESIDENCE_MM.h,
        },
      ];
    })(),
  },
  "license": {
    id: "license",
    name: "营业执照",
    desc: "A4 单页大图居中",
    pageMm: { w: 210, h: 297 },
    marginMm: 12,
    scanAspect: 210 / 297,
    scanLabel: "营业执照",
    layout: "single-page",
    guides: [
      {
        label: "执照",
        xMm: 12,
        yMm: 12,
        wMm: 210 - 24,
        hMm: 297 - 24,
      },
    ],
  },
};

export const DEFAULT_PRESET_ID = "id-card";

export function getPreset(id) {
  return CANVAS_PRESETS[id] || CANVAS_PRESETS[DEFAULT_PRESET_ID];
}

export function pageSizePx(preset, dpi = PREVIEW_DPI) {
  return {
    w: Math.round(mmToPx(preset.pageMm.w, dpi)),
    h: Math.round(mmToPx(preset.pageMm.h, dpi)),
  };
}
