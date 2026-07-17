#!/usr/bin/env python3
"""Validate background-removal logic (mirrors js/enhance.js border-mean flood-fill)."""

from __future__ import annotations

import math
import struct
import zlib
import sys
from pathlib import Path


def color_dist(r1, g1, b1, r2, g2, b2):
    return math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)


def border_mean(pixels, w, h):
    strip = max(2, round(min(w, h) * 0.02))
    rs = gs = bs = count = 0
    for y in range(h):
        for x in range(w):
            if x < strip or y < strip or x >= w - strip or y >= h - strip:
                r, g, b = pixels[y * w + x]
                rs += r
                gs += g
                bs += b
                count += 1
    return rs / count, gs / count, bs / count


def build_bg_mask(pixels, w, h, mean, tolerance):
    mr, mg, mb = mean
    n = w * h
    mask = [0] * n
    queue = []

    def try_seed(x, y):
        idx = y * w + x
        if mask[idx]:
            return
        r, g, b = pixels[idx]
        if color_dist(r, g, b, mr, mg, mb) > tolerance + 10:
            return
        mask[idx] = 1
        queue.append(idx)

    for x in range(w):
        try_seed(x, 0)
        try_seed(x, h - 1)
    for y in range(h):
        try_seed(0, y)
        try_seed(w - 1, y)

    qh = 0
    while qh < len(queue):
        idx = queue[qh]
        qh += 1
        x = idx % w
        y = idx // w
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            nidx = ny * w + nx
            if mask[nidx]:
                continue
            r, g, b = pixels[nidx]
            if color_dist(r, g, b, mr, mg, mb) <= tolerance:
                mask[nidx] = 1
                queue.append(nidx)

    copy = mask[:]
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            idx = y * w + x
            if copy[idx]:
                continue
            if not (copy[idx - 1] or copy[idx + 1] or copy[idx - w] or copy[idx + w]):
                continue
            r, g, b = pixels[idx]
            if color_dist(r, g, b, mr, mg, mb) <= tolerance + 6:
                mask[idx] = 1

    bg = sum(mask)
    return mask, bg


def score_mask(content_ratio):
    if content_ratio < 0.08 or content_ratio > 0.9:
        return -1
    return 1 - abs(content_ratio - 0.4)


def remove_bg(pixels, w, h):
    mean = border_mean(pixels, w, h)
    best = None
    for tol in (26, 32, 38, 44, 52, 60):
        mask, bg = build_bg_mask(pixels, w, h, mean, tol)
        content_ratio = 1 - bg / (w * h)
        score = score_mask(content_ratio)
        if score < 0:
            continue
        if best is None or score > best[0]:
            best = (score, mask, content_ratio, tol)
        if 0.18 <= content_ratio <= 0.65:
            break
    if best is None:
        raise RuntimeError("BG_REMOVE_FAILED")
    _, mask, content_ratio, tol = best
    out = []
    for i, px in enumerate(pixels):
        out.append((255, 255, 255) if mask[i] else px)
    return out, content_ratio, tol


def make_desk_with_card(w=320, h=240):
    """Yellow desk + cyan ID-like card in center (simulates user photos)."""
    desk = (196, 150, 72)
    card = (120, 190, 210)  # ID blue-ish
    photo = (80, 60, 50)
    pixels = [desk] * (w * h)
    # card rect ~ 50% width
    x0, y0 = int(w * 0.2), int(h * 0.22)
    x1, y1 = int(w * 0.8), int(h * 0.78)
    for y in range(y0, y1):
        for x in range(x0, x1):
            pixels[y * w + x] = card
    # fake portrait block
    px0, py0 = int(w * 0.55), int(h * 0.32)
    px1, py1 = int(w * 0.74), int(h * 0.68)
    for y in range(py0, py1):
        for x in range(px0, px1):
            pixels[y * w + x] = photo
    return pixels, w, h, (x0, y0, x1, y1)


def make_gradient_trap(w=200, h=200):
    """Old algorithm would creep; new one should keep center blob."""
    pixels = []
    for y in range(h):
        for x in range(w):
            # desk-like around edges, gradual toward center
            t = min(x, y, w - 1 - x, h - 1 - y) / (min(w, h) / 2)
            t = max(0, min(1, t))
            r = int(190 + (40 - 190) * t)
            g = int(140 + (180 - 140) * t)
            b = int(70 + (200 - 70) * t)
            pixels.append((r, g, b))
    # strong subject in center
    for y in range(70, 130):
        for x in range(70, 130):
            pixels[y * w + x] = (30, 30, 30)
    return pixels, w, h


def content_inside_rect(out, w, h, rect, desk_like=(196, 150, 72)):
    x0, y0, x1, y1 = rect
    kept = 0
    total = 0
    wiped = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            total += 1
            r, g, b = out[y * w + x]
            if (r, g, b) == (255, 255, 255):
                wiped += 1
            else:
                kept += 1
    return kept / total, wiped / total


def desk_removed(out, w, h, rect):
    x0, y0, x1, y1 = rect
    # sample corners outside card
    samples = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, 2)]
    white = 0
    for x, y in samples:
        if out[y * w + x] == (255, 255, 255):
            white += 1
    return white >= 4


def write_ppm(path, pixels, w, h):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(f"P6\n{w} {h}\n255\n".encode())
        for r, g, b in pixels:
            f.write(bytes((r, g, b)))


def main():
    out_dir = Path(__file__).resolve().parent.parent / "test-output"
    fails = 0

    # Case 1: desk + card
    pixels, w, h, rect = make_desk_with_card()
    write_ppm(out_dir / "in_desk_card.ppm", pixels, w, h)
    out, ratio, tol = remove_bg(pixels, w, h)
    write_ppm(out_dir / "out_desk_card.ppm", out, w, h)
    kept, wiped = content_inside_rect(out, w, h, rect)
    ok_desk = desk_removed(out, w, h, rect)
    print(f"[desk+card] contentRatio={ratio:.3f} tol={tol} cardKept={kept:.3f} deskCleared={ok_desk}")
    if kept < 0.85 or not ok_desk:
        print("  FAIL: card should survive and desk should be white")
        fails += 1
    else:
        print("  PASS")

    # Case 2: gradient trap (old creep bug)
    pixels, w, h = make_gradient_trap()
    write_ppm(out_dir / "in_gradient.ppm", pixels, w, h)
    try:
        out, ratio, tol = remove_bg(pixels, w, h)
        write_ppm(out_dir / "out_gradient.ppm", out, w, h)
        # center 60x60 should mostly remain dark
        dark = 0
        total = 0
        for y in range(80, 120):
            for x in range(80, 120):
                total += 1
                r, g, b = out[y * w + x]
                if r < 80 and g < 80 and b < 80:
                    dark += 1
        print(f"[gradient] contentRatio={ratio:.3f} tol={tol} centerDark={dark/total:.3f}")
        if dark / total < 0.8:
            print("  FAIL: center subject wiped (creep)")
            fails += 1
        else:
            print("  PASS")
    except RuntimeError as e:
        print(f"[gradient] refused safely: {e}")
        print("  PASS (fail-closed)")

    # Case 3: almost full-bleed subject touching edges — should fail closed or keep most
    w, h = 180, 180
    pixels = [(40, 160, 200)] * (w * h)
    # only 1px yellow border
    for x in range(w):
        pixels[x] = (200, 160, 80)
        pixels[(h - 1) * w + x] = (200, 160, 80)
    for y in range(h):
        pixels[y * w] = (200, 160, 80)
        pixels[y * w + w - 1] = (200, 160, 80)
    write_ppm(out_dir / "in_fullbleed.ppm", pixels, w, h)
    try:
        out, ratio, tol = remove_bg(pixels, w, h)
        write_ppm(out_dir / "out_fullbleed.ppm", out, w, h)
        kept = sum(1 for p in out if p != (255, 255, 255)) / (w * h)
        print(f"[fullbleed] contentRatio={ratio:.3f} tol={tol} kept={kept:.3f}")
        if kept < 0.5:
            print("  FAIL: wiped full-bleed subject")
            fails += 1
        else:
            print("  PASS")
    except RuntimeError:
        print("[fullbleed] refused safely")
        print("  PASS (fail-closed)")

    if fails:
        print(f"\n{fails} test(s) failed")
        return 1
    print("\nAll background-removal checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
