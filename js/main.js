import { A4Stage } from "./stage.js";
import { jpegToA4Pdf } from "./pdf.js";

const stage = new A4Stage(document.getElementById("stage"));
const toastEl = document.getElementById("toast");
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

stage.onSelectionChange = () => {
  document.getElementById("selectionLabel").textContent = stage.getSelectionLabel();
};

async function onFile(side, input, nameEl) {
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("请选择图片文件");
    input.value = "";
    return;
  }
  try {
    const name = await stage.setImage(side, file);
    nameEl.textContent = name;
    document.getElementById("selectionLabel").textContent = stage.getSelectionLabel();
    toast(side === "front" ? "正面已加载" : "反面已加载");
  } catch {
    toast("图片读取失败");
  }
}

document.getElementById("fileFront").addEventListener("change", (e) => {
  onFile("front", e.target, document.getElementById("nameFront"));
});
document.getElementById("fileBack").addEventListener("change", (e) => {
  onFile("back", e.target, document.getElementById("nameBack"));
});

for (const id of ["optEnhance", "optDocMode", "optStrength"]) {
  document.getElementById(id).addEventListener("input", syncOptions);
  document.getElementById(id).addEventListener("change", syncOptions);
}

document.getElementById("btnFit").addEventListener("click", () => {
  stage.resetLayout();
  toast("已恢复默认排版");
});

document.getElementById("btnCenter").addEventListener("click", () => {
  stage.centerHorizontally();
  toast("已水平居中");
});

document.getElementById("btnReset").addEventListener("click", () => {
  document.getElementById("fileFront").value = "";
  document.getElementById("fileBack").value = "";
  document.getElementById("nameFront").textContent = "未选择";
  document.getElementById("nameBack").textContent = "未选择";
  document.getElementById("optEnhance").checked = false;
  document.getElementById("optDocMode").checked = false;
  document.getElementById("optStrength").value = "60";
  if (stage.items.front?.objectUrl) URL.revokeObjectURL(stage.items.front.objectUrl);
  if (stage.items.back?.objectUrl) URL.revokeObjectURL(stage.items.back.objectUrl);
  stage.items.front = null;
  stage.items.back = null;
  stage.selected = null;
  stage._cache = { front: null, back: null, key: "" };
  stage.resetLayout();
  syncOptions();
  document.getElementById("selectionLabel").textContent = "未选中";
  toast("已重置");
});

document.getElementById("btnExport").addEventListener("click", async () => {
  if (!stage.items.front && !stage.items.back) {
    toast("请先上传身份证图片");
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

syncOptions();
