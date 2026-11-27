'use strict';

SoundSpectrum.bindControls = function (app, view, audio, charts) {
  const { $, state, options, invalidate, clamp, persistSettings, layoutButtons, themeButtons, darkPreference, compactLayout, portraitLayout,
    minimumHeight, maximumHeight, validHeight, validHistory } = app;
  const { resetView } = view;
  const { setupAnalysis, collect, showNotice, stopMicrophone, refreshDevices, useMicrophone, togglePause,
    calibrateNoise, setNoiseFilter } = audio;
  const { waterFloor, updateWaterRamp, applyThemeColors } = charts;
  const overview = $("overview");
  const topActions = document.querySelector(".top-actions");
  const settingsLauncher = $("settings-button");
  const settingsDialog = $("settings-dialog");
  const settings = settingsDialog.querySelector(".settings");
  const metadata = overview.querySelector(".metadata");
  const help = overview.querySelector(".help");
  const instrument = overview.querySelector(".instrument");
  const splitter = $("chart-splitter");
  const spectrumCard = $("spectrum-section");
  const waterCard = $("water-section");
  const spectrumWrap = $("spectrum-wrap");
  const waterWrap = $("water-wrap");

  function syncSettings() {
    for (const [key, value] of Object.entries(options)) {
      const input = $(key);
      if (!input) continue;
      if (key.endsWith("-height")) continue;
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
    }
    $("multires-bands").disabled = !options.multires;
    $("axis-button").textContent = options.log ? "对数" : "线性";
    $("axis-button").setAttribute("aria-pressed", options.log);
    $("hold-button").setAttribute("aria-pressed", options.hold);
    $("hold-legend").hidden = !options.hold;
    $("water-section").hidden = !options["show-water"];
    $("scale-low").textContent = String(waterFloor()).replace("-", "−");
    $("meta-fft").textContent = options.fft;
    $("meta-interval").textContent = options.interval + " ms";
    updateWaterRamp();
  }

  function updateLayout() {
    const portrait = portraitLayout.matches;
    const fixedStack = portrait || compactLayout.matches || !options["show-water"];
    const layout = fixedStack ? "stack" : options.layout;
    overview.dataset.layout = layout;
    $("spectrum-height").disabled = portrait;
    $("water-height").disabled = portrait || layout === "side";
    splitter.hidden = !portrait || !options["show-water"];
    if (portrait && metadata.parentElement !== settings) {
      topActions.append(settingsLauncher);
      settings.prepend(metadata);
      settings.append(help);
    } else if (!portrait && metadata.parentElement !== overview) {
      overview.after(settingsLauncher);
      instrument.before(metadata);
      instrument.after(help);
    }
    updatePortraitSplit();
    updateWaterViewportHeight();
    for (const button of layoutButtons) {
      button.setAttribute("aria-pressed", button.dataset.layoutChoice === layout);
      button.disabled = button.dataset.layoutChoice === "side" && fixedStack;
    }
    invalidate();
  }

  function updateWaterViewportHeight() {
    if (overview.dataset.layout !== "side") return;
    const top = waterCard.getBoundingClientRect().top + window.scrollY;
    waterCard.style.setProperty("--water-viewport-height", Math.max(140, document.documentElement.clientHeight - top) + "px");
  }
  window.addEventListener("resize", updateWaterViewportHeight);

  for (const button of layoutButtons) {
    button.addEventListener("click", () => {
      options.layout = button.dataset.layoutChoice;
      updateLayout();
      persistSettings();
    });
  }
  compactLayout.addEventListener("change", updateLayout);
  portraitLayout.addEventListener("change", updateLayout);

  function panelControlsHeight(card, wrap) {
    let height = card.offsetHeight - card.clientHeight;
    for (const child of card.children) {
      if (child !== wrap) height += child.offsetHeight;
    }
    return height;
  }

  function updatePortraitSplit(requestedHeight) {
    if (splitter.hidden) return;
    const available = instrument.clientHeight - splitter.offsetHeight;
    if (available <= 0) return;
    const spectrumControls = panelControlsHeight(spectrumCard, spectrumWrap);
    const waterControls = panelControlsHeight(waterCard, waterWrap);
    const controlsHeight = spectrumControls + waterControls;
    // Leave room for both plots, including when controls wrap on a short screen.
    const minPlot = Math.min(96, Math.max(0, (available - controlsHeight) / 2));
    const minHeight = Math.min(spectrumControls, available * spectrumControls / Math.max(1, controlsHeight)) + minPlot;
    const maxHeight = Math.max(minHeight, available - waterControls - minPlot);
    const height = clamp(requestedHeight ?? available * options["portrait-split"], minHeight, maxHeight);
    const share = height / available;
    if (requestedHeight !== undefined) options["portrait-split"] = share;
    instrument.style.setProperty("--portrait-spectrum-share", share + "fr");
    instrument.style.setProperty("--portrait-water-share", (1 - share) + "fr");
    splitter.setAttribute("aria-valuemin", Math.round(minHeight));
    splitter.setAttribute("aria-valuemax", Math.round(maxHeight));
    splitter.setAttribute("aria-valuenow", Math.round(height));
    splitter.setAttribute("aria-valuetext", `频谱 ${Math.round(100 * share)}%，瀑布图 ${Math.round(100 * (1 - share))}%`);
  }

  let splitDrag = null;
  splitter.addEventListener("pointerdown", event => {
    if (event.button !== 0 || splitDrag) return;
    splitDrag = {id: event.pointerId, y: event.clientY, height: spectrumCard.getBoundingClientRect().height};
    splitter.setPointerCapture(event.pointerId);
  });
  splitter.addEventListener("pointermove", event => {
    if (splitDrag?.id !== event.pointerId) return;
    updatePortraitSplit(splitDrag.height + event.clientY - splitDrag.y);
  });
  splitter.addEventListener("lostpointercapture", event => {
    if (splitDrag?.id !== event.pointerId) return;
    splitDrag = null;
    persistSettings();
  });
  splitter.addEventListener("dblclick", () => {
    options["portrait-split"] = 0.5;
    updatePortraitSplit();
    persistSettings();
  });
  splitter.addEventListener("keydown", event => {
    const height = spectrumCard.getBoundingClientRect().height;
    const step = event.shiftKey ? 40 : 10;
    const heights = {ArrowUp: height - step, ArrowDown: height + step, Home: 0, End: instrument.clientHeight};
    if (!Object.hasOwn(heights, event.key)) return;
    event.preventDefault();
    updatePortraitSplit(heights[event.key]);
    persistSettings();
  });

  function applyTheme() {
    const resolved = options.theme === "system" ? (darkPreference.matches ? "dark" : "light") : options.theme;
    const root = document.documentElement;
    root.dataset.theme = resolved;
    applyThemeColors(getComputedStyle(root));
    for (const button of themeButtons) button.setAttribute("aria-pressed", button.dataset.themeChoice === options.theme);
    const selected = themeButtons.find(button => button.dataset.themeChoice === options.theme);
    $("theme-icon").setAttribute("href", "#i-" + (selected.dataset.icon || options.theme));
  }

  const themePicker = $("theme-picker");
  const themeButton = $("theme-button");
  const themeMenu = $("theme-menu");
  let themePinned = false;
  function setThemeMenu(open) {
    if (!open) themePinned = false;
    themeMenu.hidden = !open;
    themeButton.setAttribute("aria-expanded", open);
  }
  themePicker.addEventListener("pointerenter", event => {
    if (event.pointerType === "mouse") setThemeMenu(true);
  });
  themePicker.addEventListener("pointerleave", () => {
    if (!themePinned && !themeMenu.contains(document.activeElement)) setThemeMenu(false);
  });
  themeButton.addEventListener("click", () => {
    if (themePinned) {
      setThemeMenu(false);
    } else {
      themePinned = true;
      setThemeMenu(true);
    }
  });
  for (const button of themeButtons) {
    button.addEventListener("click", () => {
      options.theme = button.dataset.themeChoice;
      applyTheme();
      persistSettings();
      setThemeMenu(false);
      themeButton.focus();
    });
  }
  themePicker.addEventListener("keydown", event => {
    if (event.key !== "Escape" || themeMenu.hidden) return;
    setThemeMenu(false);
    themeButton.focus();
  });
  themePicker.addEventListener("focusout", event => {
    if (!themePicker.contains(event.relatedTarget)) setThemeMenu(false);
  });
  document.addEventListener("pointerdown", event => {
    if (!themePicker.contains(event.target)) setThemeMenu(false);
  });
  darkPreference.addEventListener("change", () => {
    if (options.theme === "system") applyTheme();
  });

  function configureChartHeight(chart) {
    const wrap = $(chart + "-wrap");
    const resizeHandle = $(chart + "-resize");
    const key = chart + "-height";
    const heightInput = $(key);
    resizeHandle.setAttribute("aria-valuemin", minimumHeight);
    resizeHandle.setAttribute("aria-valuemax", maximumHeight);
    function syncResizeHandle() {
      const height = Math.round(wrap.getBoundingClientRect().height);
      resizeHandle.setAttribute("aria-valuenow", height);
      resizeHandle.setAttribute("aria-valuetext", height + " 像素");
    }
    function setHeight(height) {
      options[key] = height;
      if (height) wrap.style.setProperty("--" + key, height + "px");
      else wrap.style.removeProperty("--" + key);
      heightInput.value = height || "";
      syncResizeHandle();
    }
    let heightDrag = null;
    resizeHandle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || heightDrag) return;
      heightDrag = {id: event.pointerId, y: event.clientY, height: wrap.getBoundingClientRect().height};
      resizeHandle.setPointerCapture(event.pointerId);
    });
    resizeHandle.addEventListener("pointermove", event => {
      if (heightDrag?.id !== event.pointerId) return;
      const height = Math.round(heightDrag.height + event.clientY - heightDrag.y);
      setHeight(clamp(height, minimumHeight, maximumHeight));
    });
    resizeHandle.addEventListener("lostpointercapture", event => {
      if (heightDrag?.id !== event.pointerId) return;
      heightDrag = null;
      persistSettings();
    });
    resizeHandle.addEventListener("dblclick", () => {
      setHeight(0);
      persistSettings();
    });
    resizeHandle.addEventListener("keydown", event => {
      const height = Math.round(wrap.getBoundingClientRect().height);
      const step = event.shiftKey ? 40 : 10;
      const heights = {ArrowUp: height - step, ArrowDown: height + step, Home: minimumHeight, End: maximumHeight};
      if (!Object.hasOwn(heights, event.key)) return;
      event.preventDefault();
      setHeight(clamp(heights[event.key], minimumHeight, maximumHeight));
      persistSettings();
    });
    heightInput.addEventListener("change", () => {
      const height = heightInput.valueAsNumber;
      setHeight(heightInput.value === "" ? 0 : validHeight(height) ? height : options[key]);
      persistSettings();
    });

    setHeight(options[key]);
    return {wrap, syncResizeHandle};
  }

  const chartHeights = ["spectrum", "water"].map(configureChartHeight);

  for (const key of Object.keys(options)) {
    if (key.endsWith("-height")) continue;
    $(key)?.addEventListener(key === "smoothing" ? "input" : "change", event => {
      const input = event.target;
      if (key === "history" && !validHistory(input.valueAsNumber)) {
        input.value = options.history;
        return;
      }
      options[key] = typeof options[key] === "number" ? Number(input.value)
        : typeof options[key] === "string" ? input.value
        : input.type === "checkbox" ? input.checked : input.value === "true";
      if (key === "interval") state.nextFrame = -Infinity;
      if (key === "frequency-range" || key === "log") resetView();
      if (key === "hold" && options.hold) state.held = state.current.slice();
      if (state.session && ["fft", "multires", "multires-bands", "remove-dc"].includes(key)) {
        setupAnalysis();
        if (state.paused) collect();
      }
      if (key === "smoothing" && state.session?.analyser) state.session.analyser.smoothingTimeConstant = options.smoothing;
      syncSettings();
      if (key === "show-water") updateLayout();
      persistSettings();
      if (key === "spectrum-smoothing") state.dirty = true;
      else invalidate();
    });
  }

  $("mic-button").addEventListener("click", () => {
    if (state.session) {
      showNotice();
      stopMicrophone();
    } else {
      useMicrophone(state.inputDevice);
    }
  });
  $("input-device").addEventListener("change", event => {
    const device = event.target.value;
    if (state.session) useMicrophone(device);
    else state.inputDevice = device;
  });
  navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
  $("settings-button").addEventListener("click", () => {
    settingsDialog.showModal();
    refreshDevices();
  });
  settingsDialog.addEventListener("close", () => $("settings-button").focus());
  $("clear-button").addEventListener("click", () => { state.history = []; state.waterHistoryOffset = 0; state.waterDirty = true; });
  $("water-history-position").addEventListener("input", event => {
    state.waterHistoryOffset = Number(event.currentTarget.value);
    state.waterDirty = true;
  });
  $("clear-peak-button").addEventListener("click", () => { state.held = state.current.slice(); state.dirty = true; });
  $("noise-calibrate").addEventListener("click", calibrateNoise);
  $("noise-filter").addEventListener("change", event => setNoiseFilter(event.target.checked));
  $("pause-button").addEventListener("click", togglePause);
  $("fit-button").addEventListener("click", resetView);
  $("axis-button").addEventListener("click", () => {
    options.log = !options.log;
    resetView();
    syncSettings();
    persistSettings();
  });
  $("hold-button").addEventListener("click", () => {
    options.hold = !options.hold;
    if (options.hold) state.held = state.current.slice();
    syncSettings();
    persistSettings();
    state.dirty = true;
  });

  document.addEventListener("keydown", event => {
    if (!state.session || settingsDialog.open || event.code !== "Space" || event.repeat || event.target.closest("button, input, select")) return;
    event.preventDefault();
    togglePause();
  });
  const observer = new ResizeObserver(() => {
    for (const chart of chartHeights) chart.syncResizeHandle();
    updatePortraitSplit();
    invalidate();
  });
  observer.observe(instrument);
  for (const chart of chartHeights) observer.observe(chart.wrap);
  const viewportObserver = new ResizeObserver(updateWaterViewportHeight);
  viewportObserver.observe(document.querySelector(".top"));
  viewportObserver.observe($("notice"));

  syncSettings();
  updateLayout();
  applyTheme();
};
