import { A4Stage } from "./stage.js";
import { jpegToA4Pdf } from "./pdf.js";

const stage = new A4Stage(document.getElementById("stage"));
const toastEl = document.getElementById("toast");
const layerList = document.getElementById("layerList");
const fileInput = document.getElementById("fileImages");
const uploadLabel = fileInput.closest(".upload");
const rotSlider = document.getElementById("optRotation");
let toastTimer = 0;
let syncingRot = false;

function toast(msg) {
  toastEl.hidden = false;
  toastEl.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

function syncOptions() {
  stage.setOptions({
    enhance: document.getElementById("optEnhance").checked,
    docMode: document.getElementById("optDocMode").checked,
    strength: Number(document.getElementById("optStrength").value),
  });
  document.getElementById("strengthVal").textContent = String(
    document.getElementById("optStrength").value
  );
}

function syncChrome() {
  const hasSel = !!stage.selected;
  document.getElementById("selectionLabel").textContent = stage.getSelectionLabel();
  document.getElementById("itemCount").textContent = `${stage.items.length} 张图片`;
  for (const id of [
    "btnDelete",
    "btnDuplicate",
    "btnBringFront",
    "btnSendBack",
    "btnRemoveBg",
    "btnRotateL",
    "btnRotateR",
  ]) {
    document.getElementById(id).disabled = !hasSel;
  }
  document.getElementById("btnUndoBg").disabled = !(hasSel && stage.selected?._backup);
  rotSlider.disabled = !hasSel;
  syncingRot = true;
  rotSlider.value = String(Math.round(stage.selected?.rotation || 0) % 360);
  document.getElementById("rotVal").textContent = rotSlider.value;
  syncingRot = false;
  renderLayerList();
}

function renderLayerList() {
  layerList.innerHTML = "";
  const ordered = [...stage.items].reverse();
  for (const it of ordered) {
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
    name.textContent = it.bgRemoved ? `${it.name} · 已去背景` : it.name;
    name.title = name.textContent;
    li.append(thumb, name);
    li.addEventListener("click", () => {
      stage.select(it.id);
    });
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
    toast(`已添加 ${n} 张图片`);
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

for (const id of ["optEnhance", "optDocMode", "optStrength"]) {
  document.getElementById(id).addEventListener("input", syncOptions);
  document.getElementById(id).addEventListener("change", syncOptions);
}

document.getElementById("btnFit").addEventListener("click", () => {
  if (!stage.items.length) {
    toast("请先添加图片");
    return;
  }
  stage.autoLayout();
  toast("已自动排版");
  syncChrome();
});

document.getElementById("btnCenter").addEventListener("click", () => {
  if (!stage.items.length) {
    toast("请先添加图片");
    return;
  }
  const moved = stage.centerHorizontally();
  toast(moved ? "已水平居中" : "已经在水平居中位置");
  syncChrome();
});

document.getElementById("btnBringFront").addEventListener("click", () => {
  if (stage.bringToFront()) {
    toast("已图层置顶（列表最上）");
    syncChrome();
  }
});

document.getElementById("btnSendBack").addEventListener("click", () => {
  if (stage.sendToBack()) {
    toast("已图层置底（列表最下，重叠时才看得出）");
    syncChrome();
  }
});

document.getElementById("btnRotateL").addEventListener("click", () => {
  stage.rotateSelected(-90);
  toast("已旋转 -90°");
  syncChrome();
});

document.getElementById("btnRotateR").addEventListener("click", () => {
  stage.rotateSelected(90);
  toast("已旋转 +90°");
  syncChrome();
});

rotSlider.addEventListener("input", () => {
  if (syncingRot) return;
  const deg = Number(rotSlider.value);
  document.getElementById("rotVal").textContent = String(deg);
  stage.setSelectedRotation(deg);
  document.getElementById("selectionLabel").textContent = stage.getSelectionLabel();
});

document.getElementById("btnRemoveBg").addEventListener("click", () => {
  if (!stage.selected) {
    toast("请先选中一张图片");
    return;
  }
  const btn = document.getElementById("btnRemoveBg");
  btn.disabled = true;
  btn.textContent = "处理中…";
  // Turn off live filters first — cleanup is baked into the result
  document.getElementById("optDocMode").checked = false;
  document.getElementById("optEnhance").checked = false;
  syncOptions();
  setTimeout(() => {
    try {
      const result = stage.removeSelectedBackground();
      if (!result.ok) {
        toast(result.message);
      } else {
        const pct = result.meta?.contentRatio
          ? `（保留主体 ${Math.round(result.meta.contentRatio * 100)}%）`
          : "";
        toast(`去背景完成${pct}`);
      }
      syncChrome();
    } catch (err) {
      console.error(err);
      toast("去背景失败");
    } finally {
      btn.textContent = "一键去除背景";
      syncChrome();
    }
  }, 40);
});

document.getElementById("btnUndoBg").addEventListener("click", () => {
  if (stage.undoBackground()) {
    toast("已恢复去背景前的图片");
    syncChrome();
  }
});

document.getElementById("btnDelete").addEventListener("click", () => {
  if (stage.removeSelected()) {
    toast("已删除");
    syncChrome();
  }
});

document.getElementById("btnDuplicate").addEventListener("click", async () => {
  await stage.duplicateSelected();
  toast("已复制");
  syncChrome();
});

document.getElementById("btnReset").addEventListener("click", () => {
  document.getElementById("optEnhance").checked = false;
  document.getElementById("optDocMode").checked = false;
  document.getElementById("optStrength").value = "70";
  stage.clear();
  syncOptions();
  syncChrome();
  toast("已重置");
});

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "Delete" || e.key === "Backspace") {
    if (stage.removeSelected()) {
      e.preventDefault();
      toast("已删除");
      syncChrome();
    }
  }
  if (e.key === "[" && stage.selected) {
    stage.rotateSelected(-90);
    syncChrome();
  }
  if (e.key === "]" && stage.selected) {
    stage.rotateSelected(90);
    syncChrome();
  }
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
        0.92
      );
    });
    const pdf = await jpegToA4Pdf(jpegBlob, page.width, page.height);
    const a = document.createElement("a");
    const url = URL.createObjectURL(pdf);
    a.href = url;
    a.download = `a4-compose_${dpi}dpi.pdf`;
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

syncOptions();
syncChrome();
