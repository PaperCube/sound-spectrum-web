'use strict';

SoundSpectrum.createView = function (app) {
  const { state, options, clamp, mix, invalidate } = app;

  const frequencyRanges = { bass: [20, 250], voice: [100, 4000], treble: [2000, 20000] };

  function positionOf(f, log = options.log, sampleRate = state.sampleRate) {
    return log ? Math.log(Math.max(20, f) / 20) / Math.log(sampleRate / 40) : f / (sampleRate / 2);
  }

  function frequencyAt(position, log = options.log, sampleRate = state.sampleRate) {
    return log ? 20 * (sampleRate / 40) ** position : position * sampleRate / 2;
  }

  function changeWindow(left, length) {
    length = clamp(length, 0.002, 1);
    left = clamp(left, 0, 1 - length);
    state.range = [left, left + length];
    invalidate();
  }

  function zoom(fraction, factor) {
    const anchor = mix(...state.range, fraction);
    const length = clamp((state.range[1] - state.range[0]) * factor, 0.002, 1);
    changeWindow(anchor - length * fraction, length);
  }

  function resetView() {
    const preset = state.session && frequencyRanges[options["frequency-range"]];
    const start = preset ? positionOf(preset[0]) : 0;
    const end = preset ? Math.min(1, positionOf(preset[1])) : 1;
    if (end > start) changeWindow(start, end - start);
    else changeWindow(0, 1);
    state.cursor = state.hover = null;
  }

  function plotPosition(frequency) {
    return (positionOf(frequency) - state.range[0]) / (state.range[1] - state.range[0]);
  }

  return { positionOf, frequencyAt, changeWindow, zoom, resetView, plotPosition };
};
