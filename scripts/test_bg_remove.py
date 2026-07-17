#!/usr/bin/env python3
"""Validate document-friendly background removal (trimap + hole fill + crop)."""

from __future__ import annotations

import math
import sys
from pathlib import Path


def color_dist(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def saturation(rgb):
    r, g, b = rgb
    mx = max(r, g, b)
    mn = min(r, g, b)
    return 0 if mx == 0 else (mx - mn) / mx


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def region_mean(pixels, w, h, pred):
    rs = gs = bs = sat = n = 0
    for y in range(h):
        for x in range(w):
            if not pred(x, y):
                continue
            p = pixels[y * w + x]
            rs += p[0]
            gs += p[1]
            bs += p[2]
            sat += saturation(p)
            n += 1
    if not n:
        return (128, 128, 128), 0
    return (rs / n, gs / n, bs / n), sat / n


def variance_map(pixels, w, h):
    out = [0.0] * (w * h)
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            s = s2 = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    lum = luminance(pixels[(y + dy) * w + (x + dx)])
                    s += lum
                    s2 += lum * lum
            mean = s / 9
            out[y * w + x] = s2 / 9 - mean * mean
    return out


def build_fg(pixels, w, h):
    border = max(4, round(min(w, h) * 0.06))
    ix = round(w * 0.22)
    iy = round(h * 0.22)
    bg_mean, bg_sat = region_mean(
        pixels, w, h, lambda x, y: x < border or y < border or x >= w - border or y >= h - border
    )
    fg_mean, _ = region_mean(
        pixels, w, h, lambda x, y: ix <= x < w - ix and iy <= y < h - iy
    )
    var = variance_map(pixels, w, h)
    v_sum = v_n = 0
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if x < border or y < border or x >= w - border or y >= h - border:
                v_sum += var[y * w + x]
                v_n += 1
    v_border = v_sum / v_n if v_n else 20
    v_thresh = max(18, v_border * 2.2)

    fg = [0] * (w * h)
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            p = pixels[idx]
            if ix <= x < w - ix and iy <= y < h - iy:
                fg[idx] = 1
                continue
            on_border = x < border or y < border or x >= w - border or y >= h - border
            d_bg = color_dist(p, bg_mean)
            d_fg = color_dist(p, fg_mean)
            sat = saturation(p)
            vari = var[idx]
            if on_border and d_bg < 55 and vari < v_thresh * 1.5:
                fg[idx] = 0
                continue
            score = 0
            if d_fg + 8 < d_bg:
                score += 2
            if d_bg > 42:
                score += 1
            if vari > v_thresh:
                score += 2
            if bg_sat > 0.12 and sat + 0.06 < bg_sat:
                score += 1
            if d_bg < 28 and vari < v_thresh * 0.8:
                score -= 2
            fg[idx] = 1 if score >= 1 else 0

    for y in range(iy, h - iy):
        for x in range(ix, w - ix):
            fg[y * w + x] = 1

    # keep components touching center
    seen = [0] * (w * h)
    keep = [0] * (w * h)
    for start in range(w * h):
        if not fg[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        comp = []
        hit = False
        while stack:
            idx = stack.pop()
            comp.append(idx)
            x, y = idx % w, idx // w
            if ix <= x < w - ix and iy <= y < h - iy:
                hit = True
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if nx < 0 or ny < 0 or nx >= w or ny >= h:
                    continue
                nidx = ny * w + nx
                if seen[nidx] or not fg[nidx]:
                    continue
                seen[nidx] = 1
                stack.append(nidx)
        if hit:
            for idx in comp:
                keep[idx] = 1
    fg = keep

    # fill holes not reachable from border
    reach = [0] * (w * h)
    q = []
    def push(x, y):
        idx = y * w + x
        if fg[idx] or reach[idx]:
            return
        reach[idx] = 1
        q.append(idx)
    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)
    i = 0
    while i < len(q):
        idx = q[i]
        i += 1
        x, y = idx % w, idx // w
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                push(nx, ny)
    for idx in range(w * h):
        if not fg[idx] and not reach[idx]:
            fg[idx] = 1
    return fg, bg_mean


def bbox(fg, w, h):
    minx, miny, maxx, maxy, count = w, h, 0, 0, 0
    for y in range(h):
        for x in range(w):
            if not fg[y * w + x]:
                continue
            count += 1
            minx = min(minx, x)
            miny = min(miny, y)
            maxx = max(maxx, x)
            maxy = max(maxy, y)
    if not count:
        return None
    return minx, miny, maxx, maxy, count


def make_beige_card_on_wood(w=360, h=260):
    """Failure case: ID-like beige card (close to wood color) with internal patterns."""
    wood = (196, 150, 72)
    card = (210, 195, 160)  # close to wood — old flood-fill ate this
    ink = (40, 40, 40)
    emblem = (40, 110, 70)
    pixels = [wood] * (w * h)
    x0, y0, x1, y1 = int(w * 0.18), int(h * 0.2), int(w * 0.82), int(h * 0.8)
    for y in range(y0, y1):
        for x in range(x0, x1):
            pixels[y * w + x] = card
    # great-wall-like light bands (even closer to wood) inside card
    for y in range(y0 + 20, y1 - 20):
        for x in range(x0 + 15, x1 - 80):
            if (x + y) % 17 < 4:
                pixels[y * w + x] = (200, 175, 130)
    # emblem / text blocks
    for y in range(y0 + 30, y0 + 90):
        for x in range(x1 - 70, x1 - 20):
            pixels[y * w + x] = emblem
    for y in range(y1 - 50, y1 - 20):
        for x in range(x0 + 30, x0 + 140):
            pixels[y * w + x] = ink
    return pixels, w, h, (x0, y0, x1, y1)


def make_desk_cyan_card(w=320, h=240):
    desk = (196, 150, 72)
    card = (120, 190, 210)
    pixels = [desk] * (w * h)
    x0, y0, x1, y1 = int(w * 0.2), int(h * 0.22), int(w * 0.8), int(h * 0.78)
    for y in range(y0, y1):
        for x in range(x0, x1):
            pixels[y * w + x] = card
    return pixels, w, h, (x0, y0, x1, y1)


def write_ppm(path, pixels, w, h):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(f"P6\n{w} {h}\n255\n".encode())
        for r, g, b in pixels:
            f.write(bytes((int(r), int(g), int(b))))


def evaluate(name, pixels, w, h, rect):
    fg, _ = build_fg(pixels, w, h)
    box = bbox(fg, w, h)
    if not box:
        print(f"[{name}] FAIL: no bbox")
        return 1
    minx, miny, maxx, maxy, count = box
    ratio = count / (w * h)
    x0, y0, x1, y1 = rect
    # card interior must remain FG (not eaten)
    kept = 0
    total = 0
    for y in range(y0 + 8, y1 - 8):
        for x in range(x0 + 8, x1 - 8):
            total += 1
            if fg[y * w + x]:
                kept += 1
    # corners outside card should mostly be BG
    corners = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    bg_ok = sum(1 for x, y in corners if not fg[y * w + x])
    print(
        f"[{name}] contentRatio={ratio:.3f} cardInteriorKept={kept/total:.3f} "
        f"deskCornersCleared={bg_ok}/4 bbox=({minx},{miny})-({maxx},{maxy})"
    )
    if kept / total < 0.92:
        print("  FAIL: card interior eaten")
        return 1
    if bg_ok < 3:
        print("  FAIL: desk not cleared at borders")
        return 1
    if ratio < 0.08 or ratio > 0.95:
        print("  FAIL: bad content ratio")
        return 1
    print("  PASS")
    return 0


def main():
    out = Path(__file__).resolve().parent.parent / "test-output"
    fails = 0

    pixels, w, h, rect = make_beige_card_on_wood()
    write_ppm(out / "in_beige_wood.ppm", pixels, w, h)
    fails += evaluate("beige-on-wood", pixels, w, h, rect)

    pixels, w, h, rect = make_desk_cyan_card()
    write_ppm(out / "in_cyan_desk.ppm", pixels, w, h)
    fails += evaluate("cyan-on-desk", pixels, w, h, rect)

    if fails:
        print(f"\n{fails} failed")
        return 1
    print("\nAll checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
