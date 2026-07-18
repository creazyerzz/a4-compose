import { A4Stage } from "./stage.js";
import { jpegToA4Pdf } from "./pdf.js";

const stage = new A4Stage(document.getElementById("stage"));
const toastEl = document.getElementById("toast");
const layerList = document.getElementById("layerList");
const fileInput = document.getElementById("fileImages");
const uploadLabel = fileInput.closest(".upload");
let toastTimer = 0;

function toast(msg) {
  toastEl.hidden = false;
  toastEl.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

function syncChrome() {
  const hasSel = !!stage.selected;
  document.getElementById("selectionLabel").textContent = stage.getSelectionLabel();
  document.getElementById("itemCount").textContent = `${stage.items.length} 张图片`;
  document.getElementById("btnDelete").disabled = !hasSel;
  document.getElementById("btnRemoveBg").disabled = !hasSel;
  document.getElementById("btnUndoBg").disabled = !(hasSel && stage.selected?._backup);
  renderLayerList();
}

function renderLayerList() {
  layerList.innerHTML = "";
  const labels = ["正面", "反面"];
  const ordered = [...stage.items];
  for (let i = 0; i < ordered.length; i++) {
    const it = ordered[i];
    const li = document.createElement("li");
    if (it.id === stage.selectedId) li.classList.add("active");
    const thumb = document.createElement("canvas");
    thumb.className = "thumb";
    thumb.width = 28;
    thumb.height = 28;
    const tctx = thumb.getContext("2d");
    const iw = it.img.naturalWidth || it.img.width;
    const ih = it.img.naturalHeight || it.img.height;
    const s = Math.max(28 / iw, 28 / ih);
    const dw = iw * s;
    const dh = ih * s;
    tctx.fillStyle = "#fff";
    tctx.fillRect(0, 0, 28, 28);
    tctx.drawImage(it.img, (28 - dw) / 2, (28 - dh) / 2, dw, dh);
    const name = document.createElement("span");
    name.className = "name";
    const slot = labels[i] || `图${i + 1}`;
    name.textContent = it.bgRemoved ? `${slot} · 扫描件` : `${slot} · ${it.name}`;
    name.title = it.name;
    li.append(thumb, name);
    li.addEventListener("click", () => stage.select(it.id));
    layerList.appendChild(li);
  }
}

stage.onChange = syncChrome;

async function addFiles(fileList) {
  try {
    const n = await stage.addImages(fileList);
    if (!n) {
      toast("请选择图片文件");
      return;
    }
    // Keep at most 2 images for front/back
    while (stage.items.length > 2) {
      stage.selectedId = stage.items[stage.items.length - 1].id;
      stage.removeSelected();
    }
    stage.autoLayout();
    syncChrome();
    toast("正在生成扫描件…");
    await new Promise((r) => setTimeout(r, 40));
    const result = stage.cropAllToSlots();
    if (!result.ok) toast(result.message || "扫描失败，可点「一键生成扫描件」重试");
    else toast(`已生成 ${result.done} 张扫描件（正反面）`);
    syncChrome();
  } catch {
    toast("图片读取失败");
  }
}

fileInput.addEventListener("change", async (e) => {
  await addFiles(e.target.files);
  e.target.value = "";
});

uploadLabel.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadLabel.classList.add("dragover");
});
uploadLabel.addEventListener("dragleave", () => {
  uploadLabel.classList.remove("dragover");
});
uploadLabel.addEventListener("drop", async (e) => {
  e.preventDefault();
  uploadLabel.classList.remove("dragover");
  await addFiles(e.dataTransfer.files);
});

document.getElementById("btnFit").addEventListener("click", () => {
  if (!stage.items.length) {
    toast("请先上传图片");
    return;
  }
  stage.autoLayout();
  toast("已填入正面 / 反面槽位");
  syncChrome();
});

document.getElementById("btnRemoveBg").addEventListener("click", () => {
  if (!stage.selected) {
    toast("请先选中一张图片");
    return;
  }
  const btn = document.getElementById("btnRemoveBg");
  btn.disabled = true;
    btn.textContent = "生成中…";
  setTimeout(() => {
    const result = stage.removeSelectedBackground();
    if (!result.ok) toast(result.message);
    else toast(result.recrop ? "已重新生成扫描件" : "已生成扫描件并填入槽位");
    btn.textContent = "生成选中扫描件";
    syncChrome();
  }, 40);
});

document.getElementById("btnCropAll").addEventListener("click", () => {
  if (!stage.items.length) {
    toast("请先上传正面、反面图片");
    return;
  }
  const btn = document.getElementById("btnCropAll");
  btn.disabled = true;
  btn.textContent = "生成中…";
  setTimeout(() => {
    const result = stage.cropAllToSlots();
    if (!result.ok) toast(result.message);
    else toast(`已生成 ${result.done} 张扫描件并排入正反面`);
    btn.disabled = false;
    btn.textContent = "一键生成扫描件并排版";
    syncChrome();
  }, 40);
});

document.getElementById("btnUndoBg").addEventListener("click", () => {
  if (stage.undoBackground()) {
    toast("已恢复裁切前");
    syncChrome();
  }
});

document.getElementById("btnDelete").addEventListener("click", () => {
  if (stage.removeSelected()) {
    toast("已删除");
    stage.autoLayout();
    syncChrome();
  }
});

document.getElementById("btnReset").addEventListener("click", () => {
  stage.clear();
  syncChrome();
  toast("已重置");
});

document.getElementById("btnExport").addEventListener("click", async () => {
  if (!stage.items.length) {
    toast("请先添加图片");
    return;
  }
  const dpi = Number(document.getElementById("optDpi").value) || 200;
  const btn = document.getElementById("btnExport");
  btn.disabled = true;
  btn.textContent = "导出中…";
  try {
    await new Promise((r) => setTimeout(r, 30));
    const page = stage.renderExport(dpi);
    const jpegBlob = await new Promise((resolve, reject) => {
      page.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("编码失败"))),
        "image/jpeg",
        0.95
      );
    });
    const pdf = await jpegToA4Pdf(jpegBlob, page.width, page.height);
    const a = document.createElement("a");
    const url = URL.createObjectURL(pdf);
    a.href = url;
    a.download = `身份证_A4_${dpi}dpi.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("PDF 已下载");
  } catch (err) {
    console.error(err);
    toast("导出失败");
  } finally {
    btn.disabled = false;
    btn.textContent = "导出 PDF";
  }
});

syncChrome();
