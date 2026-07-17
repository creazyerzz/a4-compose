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
  }, 2200);
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
  document.getElementById("btnDelete").disabled = !hasSel;
  document.getElementById("btnDuplicate").disabled = !hasSel;
  document.getElementById("btnBringFront").disabled = !hasSel;
  document.getElementById("btnSendBack").disabled = !hasSel;
  renderLayerList();
}

function renderLayerList() {
  layerList.innerHTML = "";
  // Show top layer first in the list
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
    tctx.drawImage(it.img, (28 - dw) / 2, (28 - dh) / 2, dw, dh);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.name;
    name.title = it.name;
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
  stage.autoLayout();
  toast("已自动排版");
});

document.getElementById("btnCenter").addEventListener("click", () => {
  stage.centerHorizontally();
  toast("已水平居中");
});

document.getElementById("btnBringFront").addEventListener("click", () => {
  stage.bringToFront();
  syncChrome();
});

document.getElementById("btnSendBack").addEventListener("click", () => {
  stage.sendToBack();
  syncChrome();
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
  document.getElementById("optStrength").value = "60";
  stage.clear();
  syncOptions();
  syncChrome();
  toast("已重置");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (stage.removeSelected()) {
      e.preventDefault();
      toast("已删除");
      syncChrome();
    }
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
