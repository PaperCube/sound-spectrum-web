'use strict';

SoundSpectrum.createCharts = function (app, view, audio) {
  const { $, state, options, clamp, mix, dB, hz, invalidate, waterLevelsPerDecibel } = app;
  const { positionOf, frequencyAt, plotPosition } = view;
  const { indexAt, visiblePeaks } = audio;

  const spectrum = $("spectrum");
  const waterfall = $("waterfall");
  const spectrumContext = spectrum.getContext("2d");
  const waterContext = waterfall.getContext("2d");
  const waterImage = document.createElement("canvas");
  const imageContext = waterImage.getContext("2d");

  const paletteStops = {
    blue: [[241, 242, 239], [203, 221, 235], [131, 176, 202], [71, 109, 156], [32, 45, 74]],
    heat: [[250, 243, 224], [246, 192, 124], [222, 109, 67], [156, 48, 64], [64, 27, 60]],
    gray: [[246, 246, 245], [205, 205, 203], [148, 148, 146], [89, 89, 88], [30, 30, 30]]
  };
  const darkPaletteStops = {
    blue: [[37, 42, 49], [54, 84, 116], [69, 131, 177], [119, 179, 211], [214, 238, 255]],
    heat: [[40, 30, 40], [104, 43, 75], [177, 66, 78], [232, 125, 75], [255, 223, 155]],
    gray: [[37, 39, 38], [73, 74, 73], [123, 124, 122], [181, 182, 179], [240, 241, 238]]
  };
  const palettes = new Map();
  for (const stops of [...Object.values(paletteStops), ...Object.values(darkPaletteStops)]) {
    palettes.set(stops, Array.from({length: 256}, (_, index) => {
      const step = index / 255 * (stops.length - 1);
      const left = Math.min(stops.length - 2, Math.floor(step));
      return stops[left].map((value, channel) => Math.round(mix(value, stops[left + 1][channel], step - left)));
    }));
  }

  const waterStops = () => (document.documentElement.dataset.theme === "dark" ? darkPaletteStops : paletteStops)[options["water-palette"]];
  const waterFloor = () => options["water-floor"] || options.floor;
  const waterResolutions = {
    "very-low": [0.25, 240, 110],
    low: [0.5, 480, 220],
    medium: [0.75, 720, 330],
    standard: [1, 1000, 440],
    high: [2, 1700, 780],
    "very-high": [3, 2400, 1100],
    ultra: [4, 3200, 1600]
  };

  let chartColors;
  let smoothedCurrent = new Float32Array(0);
  let smoothedHeld = new Float32Array(0);

  function syncWaterHistory(visibleSeconds) {
    const position = $("water-history-position");
    const capturedSeconds = state.history.length ? (state.latest - state.history[0].time) / 1000 : 0;
    const maxOffset = Math.floor(Math.max(0, capturedSeconds - visibleSeconds) * 10) / 10;
    state.waterHistoryOffset = clamp(state.waterHistoryOffset, 0, maxOffset);
    position.max = maxOffset;
    position.value = state.waterHistoryOffset;
    position.disabled = !maxOffset;
    $("water-history-age").textContent = state.waterHistoryOffset ? `−${state.waterHistoryOffset.toFixed(1)} s` : "实时";
  }

  function dimensions(canvas, context) {
    const {width, height} = canvas.getBoundingClientRect();
    const compact = document.documentElement.classList.contains("compact-charts");
    const left = compact ? (canvas === waterfall ? 44 : 31) : width < 500 ? 43 : 59;
    const top = compact ? 8 : 15;
    const plotWidth = width - left - (compact ? 4 : 18);
    const plotHeight = height - top - (compact ? 17 : 28);
    if (plotWidth <= 0 || plotHeight <= 0) return null;
    const ratio = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(width * ratio), h = Math.round(height * ratio);
    if (!w || !h) return null;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return {width, height, left, top, w: plotWidth, h: plotHeight, compact};
  }

  const plotX = (frequency, plot) => plot.left + (positionOf(frequency) - state.range[0]) / (state.range[1] - state.range[0]) * plot.w;
  const plotY = (level, plot) => plot.top + clamp(level / options.floor, 0, 1) * plot.h;

  function frequencyTicks(plot) {
    const min = frequencyAt(state.range[0]), max = frequencyAt(state.range[1]);
    if (options.log && max / min > 4) {
      const ticks = [];
      const multipliers = plot.w > 620 ? [1, 2, 5] : [1];
      if (multipliers.length === 1 && min <= 20.0002) ticks.push(20);
      for (let scale = 10; scale <= max; scale *= 10) {
        for (const multiplier of multipliers) {
          const f = scale * multiplier;
          if (f >= min * 0.99999 && f <= max) ticks.push(f);
        }
      }
      return ticks;
    }
    const target = (max - min) / Math.max(2, plot.w / 85);
    const magnitude = 10 ** Math.floor(Math.log10(target));
    const step = [1, 2, 5, 10].find(x => x * magnitude >= target) * magnitude;
    const ticks = [];
    for (let f = Math.ceil(min / step) * step; f <= max; f += step) ticks.push(f);
    return ticks;
  }

  function drawGrid(context, plot, isWater) {
    const showLines = !isWater || options["water-grid"];
    context.font = `${plot.compact ? 10 : 11}px "IBM Plex Mono", Menlo, monospace`;
    context.textBaseline = "middle";
    context.lineWidth = 1;
    context.textAlign = "right";
    context.strokeStyle = isWater && state.history.length ? chartColors["water-grid"] : chartColors.grid;
    context.fillStyle = chartColors["axis-ink"];
    const pixelsPerSecond = options["water-time-scale"];
    const secondsPerTick = [0.25, 0.5, 1, 2, 5].find(seconds => seconds * pixelsPerSecond >= 20);
    const tickSpacing = isWater ? secondsPerTick * pixelsPerSecond : plot.h / 5;
    const firstTick = isWater ? Math.ceil(state.waterHistoryOffset / secondsPerTick) : 0;
    const tickCount = isWater ? Math.floor((plot.h / pixelsPerSecond + state.waterHistoryOffset) / secondsPerTick) : 5;
    for (let step = firstTick; step <= tickCount; step++) {
      const y = Math.round(plot.top + step * tickSpacing - (isWater ? state.waterHistoryOffset * pixelsPerSecond : 0)) + .5;
      if (showLines) {
        context.beginPath();
        context.moveTo(plot.left, y);
        context.lineTo(plot.left + plot.w, y);
        context.stroke();
      }
      const value = isWater ? secondsPerTick * step : Math.round(-options.floor * step / 5);
      context.fillText(isWater ? (value ? `−${value}s` : "现在") : (value ? `−${value}` : "0"), plot.left - (plot.compact ? 4 : 8), y);
    }
    if (!state.session) {
      if (!showLines) return;
      context.beginPath();
      for (let step = 0; step <= 8; step++) {
        const x = Math.round(plot.left + plot.w * step / 8) + .5;
        context.moveTo(x, plot.top);
        context.lineTo(x, plot.top + plot.h);
      }
      context.stroke();
      return;
    }
    context.textAlign = "center";
    let lastLabel = -Infinity;
    for (const f of frequencyTicks(plot)) {
      const x = Math.round(plotX(f, plot)) + .5;
      if (showLines) {
        context.beginPath();
        context.moveTo(x, plot.top);
        context.lineTo(x, plot.top + plot.h);
        context.stroke();
      }
      const labelX = clamp(x, plot.left + 4, plot.width - 16);
      if (labelX - lastLabel < 34) continue;
      context.fillText(f >= 1000 ? `${+(f / 1000).toFixed(2)}k` : `${+f.toFixed(1)}`, labelX, plot.top + plot.h + (plot.compact ? 9 : 15));
      lastLabel = labelX;
    }
  }

  function trace(context, plot, values) {
    context.beginPath();
    let started = false;
    let previous = plot.left;
    for (let i = 0; i < state.frequencies.length; i++) {
      const x = plotX(state.frequencies[i], plot);
      if (x < plot.left - 25 || (options.log && state.frequencies[i] < 20)) continue;
      if (x > plot.left + plot.w + 25 && started) break;
      const y = plotY(values[i], plot);
      if (started) context.lineTo(x, y);
      else context.moveTo(x, y);
      started = true;
      previous = x;
    }
    return previous;
  }

  function smoothSpectrum(values, result, halfOctaveRatio) {
    const { frequencies } = state;
    if (result.length !== values.length) result = new Float32Array(values.length);
    let left = 0;
    let right = 0;
    let sum = 0;
    for (let index = 0; index < frequencies.length; index++) {
      const low = frequencies[index] / halfOctaveRatio;
      const high = frequencies[index] * halfOctaveRatio;
      while (right < frequencies.length && frequencies[right] <= high) sum += values[right++];
      while (frequencies[left] < low) sum -= values[left++];
      result[index] = sum / (right - left);
    }
    return result;
  }

  function drawPeakMarkers(context, plot, peaks, smoothedValues) {
    const occupied = [];
    context.save();
    context.font = '11px "IBM Plex Mono", Menlo, monospace';
    context.textAlign = "left";
    context.textBaseline = "top";
    context.lineWidth = 1;
    for (const [index, peak] of peaks.entries()) {
      const x = plotX(peak.frequency, plot);
      const y = plotY(peak.level, plot);
      if (smoothedValues) {
        const curveY = plotY(smoothedValues[indexAt(peak.frequency)], plot);
        if (Math.abs(curveY - y) > 2) {
          context.strokeStyle = chartColors["marker-line"];
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(x, curveY);
          context.stroke();
        }
      }
      const lines = [hz(peak.frequency), `${dB(peak.level)} dBFS`];
      const width = Math.ceil(Math.max(...lines.map(line => context.measureText(line).width))) + 12;
      const height = 30;
      const left = plot.left + 2;
      const right = plot.left + plot.w - width - 2;
      const top = plot.top + 2;
      const bottom = plot.top + plot.h - height - 2;
      const columns = [x - width / 2, x + 11, x - width - 11];
      const rows = [y - height - 10, y + 10];
      for (let row = top; row <= bottom; row += height + 4) rows.push(row);
      let box;
      for (const row of rows) {
        for (const column of columns) {
          const bx = clamp(column, left, right), by = clamp(row, top, bottom);
          if (occupied.some(other => bx < other.x + other.width + 3 && bx + width + 3 > other.x
            && by < other.y + height + 3 && by + height + 3 > other.y)) continue;
          box = {x: bx, y: by, width};
          break;
        }
        if (box) break;
      }
      context.fillStyle = chartColors.marker;
      context.beginPath();
      context.arc(x, y, 3.5, 0, Math.PI * 2);
      context.fill();
      if (!box) {
        context.fillText(String(index + 1), x + 4, y - 12);
        continue;
      }
      occupied.push(box);
      context.strokeStyle = chartColors["marker-line"];
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(clamp(x, box.x, box.x + width), clamp(y, box.y, box.y + height));
      context.stroke();
      context.fillStyle = chartColors["marker-bg"];
      context.strokeStyle = chartColors["marker-border"];
      context.fillRect(box.x, box.y, width, height);
      context.strokeRect(box.x, box.y, width, height);
      context.fillStyle = chartColors["marker-ink"];
      lines.forEach((line, row) => context.fillText(line, box.x + 6, box.y + 3 + 12 * row));
    }
    context.restore();
  }

  function updatePeakList(peaks) {
    const list = $("peak-list");
    const readings = state.peak && !peaks.some(item => item.frequency === state.peak.frequency) ? [state.peak, ...peaks] : peaks;
    list.hidden = !readings.length;
    while (list.children.length > readings.length) list.lastElementChild.remove();
    for (const [index, reading] of readings.entries()) {
      const isMain = reading.frequency === state.peak?.frequency;
      const marker = peaks.indexOf(reading);
      const text = `${isMain ? "主峰" : marker + 1 + "."} ${hz(reading.frequency)} · ${dB(reading.level)} dBFS`;
      const item = list.children[index] || list.appendChild(document.createElement("li"));
      item.classList.toggle("primary-peak", isMain);
      if (item.textContent !== text) item.textContent = text;
    }
  }

  function drawSpectrum(peaks) {
    const c = spectrumContext;
    const plot = dimensions(spectrum, c);
    if (!plot) return;
    c.clearRect(0, 0, plot.width, plot.height);
    c.fillStyle = chartColors["chart-bg"];
    c.fillRect(plot.left, plot.top, plot.w, plot.h);
    drawGrid(c, plot, false);
    if (!state.session) return;
    let current = state.current;
    let held = state.held;
    const smoothing = options["spectrum-smoothing"];
    if (smoothing) {
      // The smoothing bandwidth is 1/smoothing octaves, centered on the displayed frequency.
      const halfOctaveRatio = 2 ** (1 / (2 * smoothing));
      current = smoothedCurrent = smoothSpectrum(current, smoothedCurrent, halfOctaveRatio);
      if (options.hold) held = smoothedHeld = smoothSpectrum(held, smoothedHeld, halfOctaveRatio);
    }
    c.save();
    c.beginPath();
    c.rect(plot.left, plot.top, plot.w, plot.h);
    c.clip();
    if (options["spectrum-fill"]) {
      const end = trace(c, plot, current);
      const gradient = c.createLinearGradient(0, plot.top, 0, plot.top + plot.h);
      gradient.addColorStop(0, chartColors["fill-start"]);
      gradient.addColorStop(1, chartColors["fill-end"]);
      c.lineTo(end, plot.top + plot.h);
      c.lineTo(plot.left, plot.top + plot.h);
      c.closePath();
      c.fillStyle = gradient;
      c.fill();
    }
    if (options.hold) {
      trace(c, plot, held);
      c.strokeStyle = chartColors["held-trace"];
      c.lineWidth = 1;
      c.stroke();
    }
    trace(c, plot, current);
    c.strokeStyle = chartColors.trace;
    c.lineWidth = 1.6;
    c.stroke();
    const selected = state.hover ?? state.cursor;
    if (selected != null && plotPosition(selected) >= 0 && plotPosition(selected) <= 1) {
      const y = plotY(state.current[indexAt(selected)], plot);
      c.strokeStyle = chartColors.cursor;
      c.setLineDash([4, 4]);
      c.beginPath();
      c.moveTo(plot.left, y);
      c.lineTo(plot.left + plot.w, y);
      c.stroke();
    }
    c.restore();
    drawPeakMarkers(c, plot, peaks, smoothing ? current : null);
  }

  function drawWaterfall() {
    const c = waterContext;
    const plot = options["show-water"] ? dimensions(waterfall, c) : null;
    const visibleSeconds = plot ? plot.h / options["water-time-scale"] : 0;
    const cutoff = state.latest - Math.max(options.history, visibleSeconds) * 1000;
    while (state.history.length && state.history[0].time < cutoff) state.history.shift();
    if (!plot) return;
    syncWaterHistory(visibleSeconds);
    c.clearRect(0, 0, plot.width, plot.height);
    c.fillStyle = chartColors["chart-bg"];
    c.fillRect(plot.left, plot.top, plot.w, plot.h);
    if (!state.history.length) {
      drawGrid(c, plot, true);
      return;
    }
    const [resolutionScale, maxWidth, maxHeight] = waterResolutions[options["water-quality"]];
    const width = Math.max(1, Math.min(maxWidth, Math.round(plot.w * resolutionScale)));
    const height = Math.max(1, Math.min(maxHeight, Math.round(plot.h * resolutionScale)));
    if (waterImage.width !== width || waterImage.height !== height) {
      waterImage.width = width;
      waterImage.height = height;
    }
    const pixels = imageContext.createImageData(width, height);
    const palette = palettes.get(waterStops());
    const floor = -waterFloor() * waterLevelsPerDecibel;
    const bins = new Uint32Array(width + 1);
    for (let x = 0; x <= width; x++) bins[x] = indexAt(frequencyAt(mix(...state.range, x / width)));
    let row = state.history.length - 1;
    let previousRow = -1;
    const rowBytes = width * 4;
    const millisecondsPerRow = plot.h / height * 1000 / options["water-time-scale"];
    for (let y = 0; y < height; y++) {
      const time = state.latest - state.waterHistoryOffset * 1000 - y * millisecondsPerRow;
      if (time < cutoff) break;
      while (row > 0 && state.history[row - 1].time >= time) row--;
      const frame = state.history[row];
      const levels = frame && frame.time >= time && frame.time - time < Math.max(330, options.interval * 2)
        ? frame.levels : null;
      if (!levels) {
        previousRow = -1;
        continue;
      }
      if (row === previousRow) {
        pixels.data.copyWithin(y * rowBytes, (y - 1) * rowBytes, y * rowBytes);
        continue;
      }
      previousRow = row;
      for (let x = 0; x < width; x++) {
        let level = floor;
        for (let bin = bins[x]; bin <= bins[x + 1]; bin++) level = Math.min(level, levels[bin]);
        const rgb = palette[Math.round(clamp(1 - level / floor, 0, 1) * 255)];
        const offset = (y * width + x) * 4;
        pixels.data[offset] = rgb[0];
        pixels.data[offset + 1] = rgb[1];
        pixels.data[offset + 2] = rgb[2];
        pixels.data[offset + 3] = 255;
      }
    }
    imageContext.putImageData(pixels, 0, 0);
    c.drawImage(waterImage, plot.left, plot.top, plot.w, plot.h);
    drawGrid(c, plot, true);
  }

  function updateChartCursor(cursorNode, canvas, context, frequency) {
    const plot = frequency == null ? null : dimensions(canvas, context);
    const position = plot ? plotPosition(frequency) : -1;
    cursorNode.hidden = position < -1e-8 || position > 1 + 1e-8;
    if (cursorNode.hidden) return;
    const x = plot.left + clamp(position, 0, 1) * plot.w;
    const label = cursorNode.firstElementChild;
    const measureLevel = plot.compact && canvas === spectrum;
    label.textContent = measureLevel ? `${hz(frequency)} · ${dB(state.current[indexAt(frequency)])} dBFS` : hz(frequency);
    const margin = label.offsetWidth / 2 + 3;
    cursorNode.style.setProperty("--cursor-x", x + "px");
    cursorNode.style.setProperty("--cursor-top", plot.top + "px");
    cursorNode.style.setProperty("--cursor-height", plot.h + "px");
    cursorNode.style.setProperty("--cursor-label-offset", (clamp(x, margin, plot.width - margin) - x) + "px");
  }

  function updateReadouts() {
    const selected = state.hover ?? state.cursor;
    updateChartCursor($("spectrum-cursor"), spectrum, spectrumContext, selected);
    updateChartCursor($("water-cursor"), waterfall, waterContext, selected);
    $("cursor-text").textContent = !state.session ? "频率 Hz · 电平 dBFS" : selected == null
      ? "点击图表定位游标"
      : `${hz(selected)} · ${dB(state.current[indexAt(selected)])} dBFS`;
  }

  function updateWaterRamp() {
    const stops = waterStops();
    document.querySelector(".ramp").style.backgroundImage = `linear-gradient(90deg, ${stops.map(rgb => `rgb(${rgb.join(",")})`).join(",")})`;
  }

  function applyThemeColors(styles) {
    // Canvas and CSS use the same tokens for each theme.
    const tokens = ["paper", "chart-bg", "grid", "water-grid", "axis-ink", "trace", "held-trace", "cursor",
      "fill-start", "fill-end", "marker", "marker-line", "marker-border", "marker-ink", "marker-bg"];
    chartColors = Object.fromEntries(tokens.map(name => [name, styles.getPropertyValue("--" + name).trim()]));
    document.querySelector('meta[name="theme-color"]').content = chartColors.paper;
    updateWaterRamp();
    invalidate();
  }

  function render() {
    if (state.dirty) {
      const peaks = visiblePeaks();
      drawSpectrum(peaks);
      updatePeakList(peaks);
      updateReadouts();
      state.dirty = false;
    }
    if (state.waterDirty) {
      drawWaterfall();
      state.waterDirty = false;
    }
  }

  return { render, dimensions, waterFloor, updateWaterRamp, applyThemeColors, spectrum, spectrumContext, waterfall, waterContext };
};
