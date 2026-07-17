# a4-compose

Local-first tool to arrange **any images** on an **A4 canvas** and export a PDF — entirely in the browser.

[中文说明](#中文)

## Features

- **Canvas templates**: ID card photocopy, hukou page, residence permit, business license, free A4
- Upload one or many images (file picker or drag-and-drop)
- Drag to move, scroll to scale, Shift+scroll / ±90° / slider to rotate
- **Smart document crop** (CamScanner-style): detect 4 corners → perspective warp (aspect follows template)
- Optional document mode (shadow flatten) and clarity enhance
- Layer list: select, delete, duplicate, bring to front / send to back
- Export single-page A4 PDF at 150 / 200 / 300 DPI
- Privacy: images never leave your machine

## Quick start

ES modules require a local static server (opening `file://` may be blocked):

```bash
python3 -m http.server 5173
```

Open `http://127.0.0.1:5173`

## Stack

- Static HTML / CSS / JS (no build step, no backend)
- Image processing via Canvas 2D
- Minimal JPEG-in-PDF writer

## Test

```bash
python3 scripts/test_bg_remove.py
# optional browser selftest:
python3 -m http.server 5173
# open http://127.0.0.1:5173/test/bg-remove-selftest.html
```


---

## 中文

把任意图片放到多种画布模板（身份证 / 户口页 / 居住证 / 执照 / A4 通用）上排版，支持智能裁切与 PDF 导出。纯前端本地处理。

```bash
python3 -m http.server 5173
# 浏览器打开 http://127.0.0.1:5173
```
