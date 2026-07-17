/**
 * ID-card photocopy canvas only (A4 + front/back slots).
 */

export const PREVIEW_DPI = 96;

export function mmToPx(mm, dpi = PREVIEW_DPI) {
  return (mm / 25.4) * dpi;
}

/** Chinese resident ID card physical size */
export const ID_CARD_MM = { w: 85.6, h: 54 };
export const ID_ASPECT = ID_CARD_MM.w / ID_CARD_MM.h; // landscape ≈ 1.585

const GAP_MM = 18;

function idGuides() {
  const totalH = ID_CARD_MM.h * 2 + GAP_MM;
  const top = (297 - totalH) / 2;
  const x = (210 - ID_CARD_MM.w) / 2;
  return [
    { label: "正面", xMm: x, yMm: top, wMm: ID_CARD_MM.w, hMm: ID_CARD_MM.h },
    {
      label: "反面",
      xMm: x,
      yMm: top + ID_CARD_MM.h + GAP_MM,
      wMm: ID_CARD_MM.w,
      hMm: ID_CARD_MM.h,
    },
  ];
}

/**
 * Sole canvas preset: ID card photocopy on A4.
 */
export const ID_PRESET = {
  id: "id-card",
  name: "身份证复印",
  desc: "A4 正反面标准排版（85.6×54 mm）",
  pageMm: { w: 210, h: 297 },
  marginMm: 18,
  scanAspect: ID_ASPECT,
  scanLabel: "身份证",
  layout: "id-duo",
  guides: idGuides(),
};

export const CANVAS_PRESETS = { "id-card": ID_PRESET };
export const DEFAULT_PRESET_ID = "id-card";

export function getPreset() {
  return ID_PRESET;
}

export function pageSizePx(preset = ID_PRESET, dpi = PREVIEW_DPI) {
  return {
    w: Math.round(mmToPx(preset.pageMm.w, dpi)),
    h: Math.round(mmToPx(preset.pageMm.h, dpi)),
  };
}
