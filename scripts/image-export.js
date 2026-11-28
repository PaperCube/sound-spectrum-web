'use strict';

SoundSpectrum.bindImageExport = function (app, charts) {
  const {$, clamp} = app;
  const {exportGeometry, captureImage} = charts;
  const {encodePNG, makeImageZIP} = SoundSpectrum;
  const dialog = $("image-export-dialog");
  const openButton = $("export-image-button");
  const menuButton = $("spectrum-section").querySelector(".chart-menu-toggle");
  const form = $("image-export-form");
  const content = $("image-export-content");
  const widthInput = $("image-export-width");
  const customWidth = $("image-export-custom");
  const layout = $("image-export-layout");
  const size = $("image-export-size");
  const status = $("image-export-status");
  const generate = $("image-export-generate");
  const cancel = $("image-export-cancel");
  const download = $("image-export-download");
  const preview = $("image-export-preview");
  const fields = [content, widthInput, customWidth, layout];
  const minWidth = Number(customWidth.min), maxWidth = Number(customWidth.max);
  const maxHistoryPixels = 64 * 1024 * 1024;
  let operation = null;
  let refreshTimer = null;
  let urls = [];

  function showStatus(message = "") {
    if (status.textContent !== message) status.textContent = message;
    status.hidden = !message;
  }

  function clearResult() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    for (const link of [download, preview]) {
      link.hidden = true;
      link.removeAttribute("href");
    }
  }

  function exportPlan(geometry) {
    if (!geometry) return null;
    const {plot, duration, offset} = geometry;
    const width = widthInput.value === "double" ? clamp(Math.round(plot.width * 2), minWidth, maxWidth)
      : widthInput.value === "custom" ? customWidth.valueAsNumber : Number(widthInput.value);
    if (!Number.isInteger(width) || width < minWidth || width > maxWidth) return null;

    const scale = width / plot.width;
    const margin = (plot.height - plot.h) * scale;
    const minHeight = Math.floor(margin) + 1;
    const targetHeight = Math.max(minHeight, Math.round(plot.height * scale));
    if (content.value !== "history") return {width, parts: [{height: targetHeight, duration, offset}]};
    const maxHeight = Math.min(32767, Math.floor(maxHistoryPixels / width));
    const count = layout.value === "split" ? Math.max(1, Math.ceil((targetHeight - margin) / (maxHeight - margin))) : 1;
    const partDuration = duration / count;
    const height = clamp(Math.round(margin + plot.h * scale / count), minHeight, maxHeight);
    return {
      width,
      compressed: count === 1 && targetHeight > maxHeight,
      parts: Array.from({length: count}, (_, index) => ({height, duration: partDuration, offset: offset + index * partDuration}))
    };
  }

  function refreshSize() {
    if (operation) return;
    for (const choice of content.options) choice.disabled = !exportGeometry(choice.value);
    $("image-export-custom-row").hidden = widthInput.value !== "custom";
    $("image-export-layout-row").hidden = content.value !== "history";
    const geometry = exportGeometry(content.value);
    const plan = exportPlan(geometry);
    generate.disabled = !plan || typeof CompressionStream === "undefined";
    if (typeof CompressionStream === "undefined") size.textContent = "当前浏览器的版本不支持 PNG 导出。";
    else if (!geometry) size.textContent = "当前没有可导出的图像。";
    else if (!plan) size.textContent = `请输入 ${minWidth}–${maxWidth} 之间的整数宽度。`;
    else {
      const {width, parts, compressed} = plan;
      const {height} = parts[0];
      const dimensions = `${width} × ${height} px`;
      const files = parts.length > 1 ? `${parts.length} 张，每张 ${dimensions}` : dimensions;
      const range = geometry.duration === undefined ? ""
        : ` · ${geometry.duration.toFixed(1)} 秒`;
      size.textContent = `${files}${range}${compressed ? " · 长图将压缩纵向时间比例" : ""}`;
    }
  }

  function resultLink(link, blob, label) {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    link.href = url;
    link.textContent = label;
    link.hidden = false;
  }

  openButton.addEventListener("click", () => {
    const menu = openButton.closest("[popover]");
    if (menu?.matches(":popover-open")) menu.hidePopover();
    clearResult();
    showStatus();
    content.value = "spectrum";
    refreshSize();
    dialog.showModal();
    refreshTimer = setInterval(() => {
      if (download.hidden) refreshSize();
    }, 500);
  });
  form.addEventListener("input", () => {
    clearResult();
    showStatus();
    refreshSize();
  });
  cancel.addEventListener("click", () => operation?.abort());
  dialog.addEventListener("close", () => {
    clearInterval(refreshTimer);
    operation?.abort();
    clearResult();
    showStatus();
    const menu = openButton.closest("[popover]");
    if (menu) menuButton.focus();
    else openButton.focus();
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (operation) return;
    const kind = content.value;
    const snapshot = captureImage(kind);
    const plan = exportPlan(snapshot);
    if (!plan) {
      refreshSize();
      return;
    }
    clearResult();
    const running = new AbortController();
    operation = running;
    const {signal} = running;
    for (const field of fields) field.disabled = true;
    generate.disabled = true;
    cancel.hidden = false;
    showStatus("正在生成图像…");
    const time = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    const basename = `sound-spectrum-${kind}-${time}`;
    const {width, parts} = plan;
    const count = parts.length;
    const suffix = count > 1 ? `${count} 张 · 每张 ${width} × ${parts[0].height} px` : `${width} × ${parts[0].height} px`;
    size.textContent = `${suffix}${snapshot.duration === undefined ? "" : ` · ${snapshot.duration.toFixed(1)} 秒`}${plan.compressed ? " · 已压缩纵向时间比例" : ""}`;

    try {
      const images = [];
      const totalRows = parts.reduce((total, part) => total + part.height, 0);
      let completedRows = 0;
      for (const [index, part] of parts.entries()) {
        signal.throwIfAborted();
        const painter = snapshot.painter(width, part);
        try {
          const sequence = count > 1 ? `-${String(index + 1).padStart(String(count).length, "0")}` : "";
          const blob = await encodePNG(width, part.height, painter.draw, signal, rows => {
            showStatus(`正在生成图像… ${Math.floor(100 * (completedRows + rows) / totalRows)}%`);
          });
          images.push({name: `${basename}${sequence}.png`, blob});
        } finally {
          painter.dispose?.();
        }
        completedRows += part.height;
      }
      const first = images[0];
      const multiple = images.length > 1;
      let file = first.blob;
      if (multiple) {
        showStatus("正在打包 ZIP…");
        file = await makeImageZIP(images, signal);
      }
      signal.throwIfAborted();
      download.download = multiple ? `${basename}.zip` : first.name;
      resultLink(download, file, multiple ? "下载 ZIP" : "下载 PNG");
      resultLink(preview, first.blob, multiple ? "预览首张 PNG" : "预览 PNG");
      showStatus("图像已生成。");
      if (window.matchMedia("(pointer: fine)").matches) download.click();
    } catch (error) {
      if (dialog.open) showStatus(signal.aborted ? "已取消生成。" : error.message || "生成失败，请重试。");
    } finally {
      operation = null;
      for (const field of fields) field.disabled = false;
      cancel.hidden = true;
      if (download.hidden) refreshSize();
      else generate.disabled = false;
    }
  });
};
