'use strict';

SoundSpectrum.bindChartGestures = function (app, view, charts) {
  const { state, clamp, mix } = app;
  const { frequencyAt, positionOf, plotPosition, zoom, resetView, changeWindow } = view;
  const { dimensions, spectrum, spectrumContext, waterfall, waterContext } = charts;

  function attachGestures(canvas, context) {
    const pointers = new Map();
    let dragged = false;

    function fraction(x) {
      const plot = dimensions(canvas, context);
      return plot ? clamp((x - canvas.getBoundingClientRect().left - plot.left) / plot.w, 0, 1) : 0.5;
    }

    canvas.addEventListener("wheel", event => {
      if (!state.session) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 0.06 : event.deltaMode === 2 ? 0.8 : 0.002;
      zoom(fraction(event.clientX), Math.exp(clamp(event.deltaY * scale, -2, 2)));
    }, {passive: false});
    canvas.addEventListener("dblclick", resetView);
    canvas.addEventListener("pointerdown", event => {
      if (!state.session || event.button !== 0 || pointers.size >= 2) return;
      if (!pointers.size) dragged = false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, start: event.clientX });
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
      if (!state.session) return;
      const previous = pointers.get(event.pointerId);
      if (!previous) {
        if (event.pointerType !== "touch") {
          const plot = dimensions(canvas, context);
          if (!plot) return;
          const bounds = canvas.getBoundingClientRect();
          const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
          const inside = x >= plot.left && x <= plot.left + plot.w && y >= plot.top && y <= plot.top + plot.h;
          state.hover = inside ? frequencyAt(mix(...state.range, fraction(event.clientX))) : null;
          state.dirty = true;
        }
        return;
      }
      const next = { x: event.clientX, y: event.clientY, start: previous.start };
      const plot = dimensions(canvas, context);
      if (!plot) return;
      const length = state.range[1] - state.range[0];
      if (pointers.size === 2) {
        dragged = true;
        const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
        const before = Math.max(8, Math.hypot(previous.x - other.x, previous.y - other.y));
        const after = Math.max(8, Math.hypot(next.x - other.x, next.y - other.y));
        const anchor = mix(...state.range, fraction((previous.x + other.x) / 2));
        const nextLength = clamp(length * before / after, 0.002, 1);
        changeWindow(anchor - fraction((next.x + other.x) / 2) * nextLength, nextLength);
      } else if (dragged || Math.abs(next.x - previous.start) > 4) {
        const oldX = dragged ? previous.x : previous.start;
        changeWindow(state.range[0] - (next.x - oldX) / plot.w * length, length);
        dragged = true;
      }
      pointers.set(event.pointerId, next);
    });
    canvas.addEventListener("pointerup", event => {
      if (!pointers.delete(event.pointerId)) return;
      if (state.session && !dragged && !pointers.size) {
        const selected = frequencyAt(mix(...state.range, fraction(event.clientX)));
        state.cursor = state.cursor !== null && Math.abs(plotPosition(selected) - plotPosition(state.cursor)) < 0.009 ? null : selected;
        state.dirty = true;
      }
    });
    canvas.addEventListener("lostpointercapture", event => pointers.delete(event.pointerId));
    canvas.addEventListener("pointercancel", event => pointers.delete(event.pointerId));
    canvas.addEventListener("pointerleave", () => {
      state.hover = null;
      state.dirty = true;
    });
  }

  attachGestures(spectrum, spectrumContext);
  attachGestures(waterfall, waterContext);
  function handleChartKey(event) {
    if (!state.session) return;
    const midpoint = mix(...state.range, 0.5);
    if (event.key === "+" || event.key === "=") zoom(0.5, 0.75);
    else if (event.key === "-") zoom(0.5, 1.33);
    else if (event.key === "Home") resetView();
    else if (event.key === "Escape") { state.cursor = state.hover = null; state.dirty = true; }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const delta = (event.key === "ArrowLeft" ? -0.02 : 0.02) * (state.range[1] - state.range[0]);
      const selected = state.hover ?? state.cursor;
      state.cursor = frequencyAt(clamp((selected === null ? midpoint : positionOf(selected)) + delta, ...state.range));
      state.hover = null;
      state.dirty = true;
    } else return;
    event.preventDefault();
  }
  spectrum.addEventListener("keydown", handleChartKey);
  waterfall.addEventListener("keydown", handleChartKey);
};
