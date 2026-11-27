'use strict';

// The deferred classic scripts share one namespace so the app also loads from file://.
const SoundSpectrum = (() => {
  const $ = id => document.getElementById(id);

  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  const mix = (a, b, t) => a + (b - a) * t;
  const dB = value => value.toFixed(1).replace("-", "−");
  const hz = value => value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value.toFixed(1)} Hz`;
  const waterLevelsPerDecibel = 255 / 160;

  const options = {
    fft: 2048, multires: true, "multires-bands": 3, smoothing: 0.55, interval: 64, floor: -100,
    history: 20, "show-water": true, "remove-dc": true, log: true, hold: true,
    "peak-count": 3, "peak-floor": -100, "peak-spacing": 24, "frequency-range": "full",
    "spectrum-fill": true, "spectrum-smoothing": 24, "water-palette": "blue", "water-floor": 0, "water-grid": true,
    "spectrum-height": 0, "water-height": 0, "water-quality": "standard", "water-time-scale": 10,
    layout: "stack", "portrait-split": 0.5, theme: "system"
  };
  const layoutButtons = Array.from(document.querySelectorAll("[data-layout-choice]"));
  const themeButtons = Array.from(document.querySelectorAll("[data-theme-choice]"));
  const darkPreference = matchMedia("(prefers-color-scheme: dark)");
  const compactLayout = matchMedia("(max-width: 820px)");
  const portraitLayout = matchMedia("(orientation: portrait)");
  const minimumHeight = Number($("spectrum-height").min);
  const maximumHeight = Number($("spectrum-height").max);
  const validHeight = height => Number.isInteger(height) && height >= minimumHeight && height <= maximumHeight;
  const historyInput = $("history");
  const minimumHistory = Number(historyInput.min);
  const maximumHistory = Number(historyInput.max);
  const validHistory = seconds => Number.isInteger(seconds) && seconds >= minimumHistory && seconds <= maximumHistory;

  try {
    const saved = JSON.parse(localStorage.getItem("sound-spectrum-settings")) || {};
    for (const key of Object.keys(options)) {
      const input = $(key);
      if (typeof saved[key] !== typeof options[key]) continue;
      if (input?.tagName === "SELECT" && !Array.from(input.options).some(item => item.value === String(saved[key]))) continue;
      if (key === "theme" && !themeButtons.some(button => button.dataset.themeChoice === saved[key])) continue;
      if (key === "layout" && !layoutButtons.some(button => button.dataset.layoutChoice === saved[key])) continue;
      if (key === "portrait-split" && !(saved[key] >= 0 && saved[key] <= 1)) continue;
      if (key.endsWith("-height") && saved[key] !== 0 && !validHeight(saved[key])) continue;
      if (key === "history" && !validHistory(saved[key])) continue;
      if (key === "smoothing" && !(saved[key] >= 0 && saved[key] <= 0.95)) continue;
      options[key] = saved[key];
    }
  } catch { /* Storage can be disabled for local files. */ }

  const state = {
    sampleRate: null,
    frequencies: new Float32Array(0),
    current: new Float32Array(0),
    held: new Float32Array(0),
    peak: null,
    session: null,
    paused: false,
    pending: false,
    inputDevice: "",
    history: [],
    waterHistoryOffset: 0,
    cursor: null,
    hover: null,
    range: [0, 1],
    waterDirty: true,
    dirty: true,
    latest: performance.now(),
    nextFrame: 0
  };

  function invalidate() {
    state.dirty = true;
    state.waterDirty = true;
  }

  function persistSettings() {
    try { localStorage.setItem("sound-spectrum-settings", JSON.stringify(options)); } catch { /* Optional persistence. */ }
  }

  return { $, clamp, mix, dB, hz, options, state, invalidate, persistSettings, layoutButtons, themeButtons,
    darkPreference, compactLayout, portraitLayout, minimumHeight, maximumHeight, validHeight, validHistory, waterLevelsPerDecibel };
})();
