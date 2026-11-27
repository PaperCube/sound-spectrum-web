'use strict';

SoundSpectrum.bindSettingsHelp = function (app) {
  const { $, clamp } = app;

  const settingsDialog = $("settings-dialog");
  const settingsTooltip = $("settings-tooltip");

  const settingHelp = {
    fft: "分析每一帧使用的采样点数。数值越大，越容易分辨相近的频率，但对短暂变化的响应会变慢。",
    multires: "增强模式逐级滤波并将采样率减半，各段使用相同的 FFT 点数。低频的频点更密，分析窗口更长，响应较慢。",
    "multires-bands": "可设 2–6 段，包括原始采样率的一段。每增加一段，最低频段的采样率减半，分析窗口时长翻倍。",
    smoothing: "在连续采样之间平滑电平。数值越高，对突然变化的响应越慢。频谱图上方的平滑选项控制相邻频点之间的平滑。",
    interval: "两次频谱采样之间的目标间隔。数值越小，频谱和瀑布图更新越频繁。",
    "remove-dc": "滤除接近 0 Hz 的输入偏移。测量超低频时可以关闭。",
    "noise-filter": "让目标声源停下后，点击「采集底噪」。之后的频谱和瀑布图会将接近底噪的频点逐渐压低，最多衰减 12 dB。",
    "peak-floor": "低于此电平的峰值不会被标注。提高阈值可减少背景噪声的标注。",
    "peak-spacing": "仅标注间隔足够大的峰值。间隔越大，相邻峰值越容易只保留较强的一个。",
    hold: "用额外的曲线记录各频率达到过的最高电平。可在弹窗底部重置。",
    log: "对数轴让每个倍频程占相同宽度。线性轴让每一赫兹占相同宽度。",
    "frequency-range": "启用麦克风或点击频谱图的复位按钮时，应用这个频段。",
    floor: "频谱纵轴底部的电平。降低下限可以看到更微弱的信号。dBFS 以数字满刻度为 0。",
    "water-height": "横屏上下排布时可设置高度，留空使用自动值。竖屏请拖动两张图之间的分隔杆。",
    history: "可输入 10–300 秒之间的任意整数。图高和时间比例决定可见时长，需要时会保留更久。拖动图下的滑杆查看较早的记录。",
    "water-floor": "此电平对应色标最弱的一端。降低下限可以突出较微弱的信号。"
  };

  let helpAnchor = null;
  let helpPinned = false;
  let helpHideTimer;
  function hideSettingHelp() {
    clearTimeout(helpHideTimer);
    settingsTooltip.hidden = true;
    helpAnchor?.removeAttribute("aria-describedby");
    helpAnchor = null;
    helpPinned = false;
  }
  function showSettingHelp(button, description) {
    clearTimeout(helpHideTimer);
    if (helpAnchor !== button) {
      hideSettingHelp();
      helpAnchor = button;
      button.setAttribute("aria-describedby", settingsTooltip.id);
    }
    settingsTooltip.textContent = description;
    settingsTooltip.hidden = false;
    const anchor = button.getBoundingClientRect();
    const width = settingsTooltip.offsetWidth;
    const height = settingsTooltip.offsetHeight;
    const top = anchor.bottom + height + 12 <= innerHeight ? anchor.bottom + 4 : anchor.top - height - 4;
    settingsTooltip.style.left = clamp(anchor.left, 8, innerWidth - width - 8) + "px";
    settingsTooltip.style.top = Math.max(8, top) + "px";
  }
  function scheduleHelpHide() {
    if (!helpPinned) helpHideTimer = setTimeout(hideSettingHelp, 120);
  }
  for (const [id, description] of Object.entries(settingHelp)) {
    const control = $(id);
    const label = control.closest("label");
    const title = Array.from(label.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent.trim())
      .join(" ").trim();
    const name = document.createElement("span");
    name.className = "setting-name";
    label.before(name);
    name.append(label);
    if (!label.classList.contains("check")) {
      const row = document.createElement("div");
      row.className = "setting-with-help";
      name.before(row);
      row.append(name, control);
      label.htmlFor = id;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "setting-help";
    button.textContent = "?";
    button.setAttribute("aria-label", title + "说明");
    name.append(button);
    button.addEventListener("pointerenter", event => {
      if (event.pointerType !== "touch") showSettingHelp(button, description);
    });
    button.addEventListener("pointerleave", scheduleHelpHide);
    button.addEventListener("focus", () => showSettingHelp(button, description));
    button.addEventListener("blur", hideSettingHelp);
    button.addEventListener("click", () => {
      if (helpAnchor === button && helpPinned) {
        hideSettingHelp();
      } else {
        showSettingHelp(button, description);
        helpPinned = true;
      }
    });
  }
  settingsTooltip.addEventListener("pointerenter", () => clearTimeout(helpHideTimer));
  settingsTooltip.addEventListener("pointerleave", scheduleHelpHide);
  settingsDialog.querySelector(".settings").addEventListener("scroll", hideSettingHelp);
  settingsDialog.addEventListener("close", hideSettingHelp);
  settingsDialog.addEventListener("keydown", event => {
    if (event.key === "Escape" && !settingsTooltip.hidden) {
      event.preventDefault();
      hideSettingHelp();
    }
  });
};
