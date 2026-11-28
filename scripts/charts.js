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
  const yAxisWidth = 27;
  const yAxisFont = '10px "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", sans-serif';

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
  const waterFloor = (settings = options) => settings["water-floor"] || settings.floor;
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
    const plot = plotDimensions(width, height);
    if (!plot) return null;
    const ratio = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(width * ratio), h = Math.round(height * ratio);
    if (!w || !h) return null;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return plot;
  }

  function plotDimensions(width, height, compact = document.documentElement.classList.contains("compact-charts")) {
    const left = yAxisWidth;
    const top = compact ? 6 : 15;
    const w = width - left - (compact ? 4 : 18);
    const h = height - top - (compact ? 13 : 28);
    return w > 0 && h > 0 ? {width, height, left, top, w, h, compact} : null;
  }

  function chartFrame(data = state, settings = options) {
    return {
      data, settings, colors: chartColors, palette: palettes.get(waterStops()),
      positionOf: frequency => positionOf(frequency, settings.log, data.sampleRate),
      frequencyAt: position => frequencyAt(position, settings.log, data.sampleRate),
      indexAt: frequency => indexAt(frequency, data.frequencies)
    };
  }

  const plotX = (frequency, plot, frame) => {
    const [start, end] = frame.data.range;
    return plot.left + (frame.positionOf(frequency) - start) / (end - start) * plot.w;
  };
  const plotY = (level, plot, frame) => plot.top + clamp(level / frame.settings.floor, 0, 1) * plot.h;

  function frequencyTicks(plot, frame) {
    const {data: state, settings: options, frequencyAt} = frame;
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

  function drawGrid(context, plot, frame, timeline, tile) {
    const {data: state, settings: options, colors: chartColors} = frame;
    const isWater = Boolean(timeline);
    const showLines = !isWater || options["water-grid"];
    context.font = yAxisFont;
    context.textBaseline = "middle";
    context.lineWidth = 1;
    context.textAlign = "right";
    context.strokeStyle = isWater && state.history.length ? chartColors["water-grid"] : chartColors.grid;
    context.fillStyle = chartColors["axis-ink"];
    const pixelsPerSecond = timeline ? plot.h / timeline.duration : 0;
    const secondsPerTick = isWater ? [1, 2, 5].find(seconds => seconds * pixelsPerSecond >= 20)
      ?? Math.ceil(4 / pixelsPerSecond) * 5 : 0;
    const tickSpacing = isWater ? secondsPerTick * pixelsPerSecond : plot.h / 5;
    const offset = timeline?.offset ?? 0;
    const firstVisible = tile ? Math.max(0, tile.top - plot.top - 8) / pixelsPerSecond : 0;
    const lastVisible = tile ? Math.min(plot.h, tile.bottom - plot.top + 8) / pixelsPerSecond : timeline?.duration;
    const firstTick = isWater ? Math.ceil((offset + firstVisible) / secondsPerTick) : 0;
    const tickCount = isWater ? Math.floor((offset + lastVisible) / secondsPerTick) : 5;
    const labelRight = plot.left - 3;
    for (let step = firstTick; step <= tickCount; step++) {
      const y = Math.round(plot.top + step * tickSpacing - offset * pixelsPerSecond) + .5;
      if (showLines) {
        context.beginPath();
        context.moveTo(plot.left, y);
        context.lineTo(plot.left + plot.w, y);
        context.stroke();
      }
      const value = isWater ? secondsPerTick * step : Math.round(-options.floor * step / 5);
      const label = isWater ? (value ? `−${value}s` : "现在") : (value ? `−${value}` : "0");
      context.fillText(label, labelRight, y, labelRight);
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
    context.font = `${plot.compact ? 10 : 11}px "IBM Plex Mono", Menlo, monospace`;
    context.textAlign = "center";
    let lastLabel = -Infinity;
    for (const f of frequencyTicks(plot, frame)) {
      const x = Math.round(plotX(f, plot, frame)) + .5;
      if (showLines) {
        context.beginPath();
        context.moveTo(x, plot.top);
        context.lineTo(x, plot.top + plot.h);
        context.stroke();
      }
      const labelX = clamp(x, plot.left + 4, plot.width - 16);
      if (labelX - lastLabel < 34) continue;
      context.fillText(f >= 1000 ? `${+(f / 1000).toFixed(2)}k` : `${+f.toFixed(1)}`, labelX, plot.top + plot.h + (plot.compact ? 7 : 15));
      lastLabel = labelX;
    }
  }

  function trace(context, plot, values, frame) {
    const {data: state, settings: options} = frame;
    context.beginPath();
    let started = false;
    let previous = plot.left;
    for (let i = 0; i < state.frequencies.length; i++) {
      const x = plotX(state.frequencies[i], plot, frame);
      if (x < plot.left - 25 || (options.log && state.frequencies[i] < 20)) continue;
      if (x > plot.left + plot.w + 25 && started) break;
      const y = plotY(values[i], plot, frame);
      if (started) context.lineTo(x, y);
      else context.moveTo(x, y);
      started = true;
      previous = x;
    }
    return previous;
  }

  function smoothSpectrum(values, result, halfOctaveRatio, frequencies) {
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

  function drawPeakMarkers(context, plot, peaks, smoothedValues, frame) {
    const {colors: chartColors, indexAt} = frame;
    const occupied = [];
    context.save();
    context.font = '11px "IBM Plex Mono", Menlo, monospace';
    context.textAlign = "left";
    context.textBaseline = "top";
    context.lineWidth = 1;
    for (const [index, peak] of peaks.entries()) {
      const x = plotX(peak.frequency, plot, frame);
      const y = plotY(peak.level, plot, frame);
      if (smoothedValues) {
        const curveY = plotY(smoothedValues[indexAt(peak.frequency)], plot, frame);
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

  function spectrumCurves(frame) {
    const {data, settings} = frame;
    if (!settings["spectrum-smoothing"]) return {current: data.current, held: data.held};
    const halfOctaveRatio = 2 ** (1 / (2 * settings["spectrum-smoothing"]));
    const current = smoothSpectrum(data.current, data === state ? smoothedCurrent : new Float32Array(0), halfOctaveRatio, data.frequencies);
    const held = settings.hold ? smoothSpectrum(data.held, data === state ? smoothedHeld : new Float32Array(0), halfOctaveRatio, data.frequencies) : data.held;
    if (data === state) {
      smoothedCurrent = current;
      if (settings.hold) smoothedHeld = held;
    }
    return {current, held};
  }

  function drawSpectrum(c, plot, peaks, frame, curves, selected) {
    const {data: state, settings: options, colors: chartColors, indexAt} = frame;
    c.fillStyle = chartColors["chart-bg"];
    c.fillRect(plot.left, plot.top, plot.w, plot.h);
    drawGrid(c, plot, frame);
    if (!state.session) return;
    const {current, held} = curves;
    c.save();
    c.beginPath();
    c.rect(plot.left, plot.top, plot.w, plot.h);
    c.clip();
    if (options["spectrum-fill"]) {
      const end = trace(c, plot, current, frame);
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
      trace(c, plot, held, frame);
      c.strokeStyle = chartColors["held-trace"];
      c.lineWidth = 1;
      c.stroke();
    }
    trace(c, plot, current, frame);
    c.strokeStyle = chartColors.trace;
    c.lineWidth = 1.6;
    c.stroke();
    const cursorX = selected == null ? NaN : plotX(selected, plot, frame);
    if (cursorX >= plot.left && cursorX <= plot.left + plot.w) {
      const y = plotY(state.current[indexAt(selected)], plot, frame);
      c.strokeStyle = chartColors.cursor;
      c.setLineDash([4, 4]);
      c.beginPath();
      c.moveTo(plot.left, y);
      c.lineTo(plot.left + plot.w, y);
      c.stroke();
    }
    c.restore();
    drawPeakMarkers(c, plot, peaks, options["spectrum-smoothing"] ? current : null, frame);
  }

  function waterfallRaster(frame, timeline, width, height) {
    const {data, settings, frequencyAt, indexAt} = frame;
    const bins = new Uint32Array(width + 1);
    for (let x = 0; x <= width; x++) bins[x] = indexAt(frequencyAt(mix(...data.range, x / width)));
    return {
      bins, history: data.history, palette: frame.palette, cutoff: timeline.cutoff,
      floor: -waterFloor(settings) * waterLevelsPerDecibel,
      newest: data.latest - timeline.offset * 1000,
      millisecondsPerRow: timeline.duration * 1000 / height,
      maxGap: Math.max(330, settings.interval * 2)
    };
  }

  function paintWaterPixels(pixels, raster, startX = 0, startY = 0) {
    const {bins, history, palette, floor, cutoff, newest, millisecondsPerRow, maxGap} = raster;
    const {width, height, data} = pixels;
    const firstTime = newest - startY * millisecondsPerRow;
    let low = 0, high = history.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (history[middle].time < firstTime) low = middle + 1;
      else high = middle;
    }
    let row = low, previousRow = -1;
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const time = newest - (startY + y) * millisecondsPerRow;
      if (time < cutoff) break;
      while (row > 0 && history[row - 1].time >= time) row--;
      const frame = history[row];
      if (!frame || frame.time < time || frame.time - time >= maxGap) {
        previousRow = -1;
        continue;
      }
      if (row === previousRow) {
        data.copyWithin(y * rowBytes, (y - 1) * rowBytes, y * rowBytes);
        continue;
      }
      previousRow = row;
      for (let x = 0; x < width; x++) {
        let level = floor;
        for (let bin = bins[startX + x]; bin <= bins[startX + x + 1]; bin++) level = Math.min(level, frame.levels[bin]);
        const rgb = palette[Math.round(clamp(1 - level / floor, 0, 1) * 255)];
        const offset = y * rowBytes + x * 4;
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
        data[offset + 3] = 255;
      }
    }
  }

  function drawWaterfall() {
    const c = waterContext;
    const plot = options["show-water"] ? dimensions(waterfall, c) : null;
    const duration = plot ? plot.h / options["water-time-scale"] : 0;
    const cutoff = state.latest - Math.max(options.history, duration) * 1000;
    while (state.history.length && state.history[0].time < cutoff) state.history.shift();
    if (!plot) return;
    syncWaterHistory(duration);
    const frame = chartFrame();
    const timeline = {duration, cutoff, offset: state.waterHistoryOffset};
    c.clearRect(0, 0, plot.width, plot.height);
    c.fillStyle = chartColors["chart-bg"];
    c.fillRect(plot.left, plot.top, plot.w, plot.h);
    if (state.history.length) {
      const [resolutionScale, maxWidth, maxHeight] = waterResolutions[options["water-quality"]];
      const width = Math.max(1, Math.min(maxWidth, Math.round(plot.w * resolutionScale)));
      const height = Math.max(1, Math.min(maxHeight, Math.round(plot.h * resolutionScale)));
      if (waterImage.width !== width || waterImage.height !== height) {
        waterImage.width = width;
        waterImage.height = height;
      }
      const pixels = imageContext.createImageData(width, height);
      paintWaterPixels(pixels, waterfallRaster(frame, timeline, width, height));
      imageContext.putImageData(pixels, 0, 0);
      c.drawImage(waterImage, plot.left, plot.top, plot.w, plot.h);
    }
    drawGrid(c, plot, frame, timeline);
  }

  function exportGeometry(kind) {
    if (!state.session || !state.current.length) return null;
    const canvas = kind === "spectrum" ? spectrum : waterfall;
    const {width, height} = canvas.getBoundingClientRect();
    let plot = plotDimensions(width, height);
    if (kind === "spectrum") return plot ? {plot} : null;
    if (!state.history.length) return null;
    if (kind === "history" && !plot) plot = plotDimensions(spectrum.getBoundingClientRect().width, 196);
    if (!plot) return null;
    const pixelsPerSecond = options["water-time-scale"];
    const visibleDuration = plot.h / pixelsPerSecond;
    if (kind === "visible") {
      const cutoff = state.latest - Math.max(options.history, visibleDuration) * 1000;
      return {plot, offset: state.waterHistoryOffset, duration: visibleDuration, cutoff};
    }
    const duration = (state.latest - state.history[0].time + options.interval) / 1000;
    const cutoff = state.latest - duration * 1000;
    return {plot: {...plot, h: duration * pixelsPerSecond, height: duration * pixelsPerSecond + plot.height - plot.h},
      offset: 0, duration, cutoff};
  }

  function drawExportCursor(context, plot, frame) {
    const {cursor, current} = frame.data;
    if (cursor == null) return;
    const x = plotX(cursor, plot, frame);
    if (x < plot.left || x > plot.left + plot.w) return;
    const {colors, indexAt} = frame;
    context.save();
    context.strokeStyle = colors.cursor;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(x, plot.top);
    context.lineTo(x, plot.top + plot.h);
    context.stroke();
    context.setLineDash([]);
    const label = `${hz(cursor)} · ${dB(current[indexAt(cursor)])} dBFS`;
    context.font = '10px "IBM Plex Mono", Menlo, monospace';
    context.textBaseline = "middle";
    context.textAlign = "center";
    const width = Math.min(context.measureText(label).width + 8, plot.width - 4);
    const labelX = clamp(x, width / 2 + 2, plot.width - width / 2 - 2);
    const labelY = Math.max(plot.top, plot.top + plot.h - 16);
    context.fillStyle = colors["marker-bg"];
    context.fillRect(labelX - width / 2, labelY, width, 13);
    context.strokeStyle = colors["marker-line"];
    context.strokeRect(labelX - width / 2, labelY, width, 13);
    context.fillStyle = colors["marker-ink"];
    context.fillText(label, labelX, labelY + 7, width - 4);
    context.restore();
  }

  function captureImage(kind) {
    const geometry = exportGeometry(kind);
    if (!geometry) return null;
    const isSpectrum = kind === "spectrum";
    const frame = chartFrame({
      session: true, sampleRate: state.sampleRate, range: state.range.slice(), frequencies: state.frequencies,
      latest: state.latest, history: isSpectrum ? [] : state.history.slice(), cursor: state.cursor,
      current: isSpectrum ? state.current.slice() : null, held: isSpectrum ? state.held.slice() : null
    }, {...options});
    const peaks = isSpectrum ? visiblePeaks() : [];
    const curves = isSpectrum ? spectrumCurves(frame) : null;
    return {...geometry, painter(width, part) {
      const {plot: source} = geometry;
      const scale = width / source.width;
      const plot = plotDimensions(source.width, part.height / scale, source.compact);
      let paint;
      if (isSpectrum) {
        paint = context => {
          drawSpectrum(context, plot, peaks, frame, curves, frame.data.cursor);
          drawExportCursor(context, plot, frame);
        };
      } else {
        const timeline = {duration: part.duration, offset: part.offset, cutoff: geometry.cutoff};
        const left = Math.round(plot.left * scale), top = Math.round(plot.top * scale);
        const columns = Math.max(1, Math.round((plot.left + plot.w) * scale) - left);
        const rows = Math.max(1, Math.round((plot.top + plot.h) * scale) - top);
        const raster = waterfallRaster(frame, timeline, columns, rows);
        const buffer = document.createElement("canvas");
        const bufferContext = buffer.getContext("2d");
        paint = (context, tile) => {
          context.fillStyle = frame.colors["chart-bg"];
          context.fillRect(plot.left, plot.top, plot.w, plot.h);
          const x = Math.max(tile.x, left), y = Math.max(tile.y, top);
          const w = Math.min(tile.x + tile.width, left + columns) - x;
          const h = Math.min(tile.y + tile.height, top + rows) - y;
          if (w > 0 && h > 0) {
            if (buffer.width !== w || buffer.height !== h) {
              buffer.width = w;
              buffer.height = h;
            }
            const pixels = bufferContext.createImageData(w, h);
            paintWaterPixels(pixels, raster, x - left, y - top);
            bufferContext.putImageData(pixels, 0, 0);
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.drawImage(buffer, x - tile.x, y - tile.y);
            context.setTransform(scale, 0, 0, scale, -tile.x, -tile.y);
          }
          drawGrid(context, plot, frame, timeline, {top: tile.y / scale, bottom: (tile.y + tile.height) / scale});
        };
        return {
          draw: tilePainter(paint),
          dispose() { buffer.width = buffer.height = 0; }
        };
      }
      return {draw: tilePainter(paint)};
      function tilePainter(renderTile) {
        return (context, tile) => {
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.fillStyle = frame.colors.paper;
          context.fillRect(0, 0, tile.width, tile.height);
          context.setTransform(scale, 0, 0, scale, -tile.x, -tile.y);
          renderTile(context, tile);
        };
      }
    }};
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
      const plot = dimensions(spectrum, spectrumContext);
      if (plot) {
        const frame = chartFrame();
        spectrumContext.clearRect(0, 0, plot.width, plot.height);
        drawSpectrum(spectrumContext, plot, peaks, frame, spectrumCurves(frame), state.hover ?? state.cursor);
      }
      updatePeakList(peaks);
      updateReadouts();
      state.dirty = false;
    }
    if (state.waterDirty) {
      drawWaterfall();
      state.waterDirty = false;
    }
  }

  return { render, dimensions, waterFloor, updateWaterRamp, applyThemeColors, spectrum, spectrumContext, waterfall, waterContext,
    exportGeometry, captureImage };
};
