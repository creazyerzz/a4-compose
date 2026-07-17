# a4-compose

Local tool for **Chinese ID card** A4 photocopy: crop to card edges, place front/back, export PDF.

## Features

- Upload front + back photos
- Smart crop to ID edges (CamScanner-style perspective)
- Auto rotate to landscape and fill 正面 / 反面 slots (85.6×54 mm on A4)
- Export PDF — all processing stays in the browser

## Quick start

```bash
python3 -m http.server 5173
```

Open `http://127.0.0.1:5173`

## License

MIT — see [LICENSE](LICENSE).

---

## 中文

上传身份证正反面 → 按边缘裁切 → 自动填入 A4 正面/反面槽位 → 导出 PDF。纯本地处理。
