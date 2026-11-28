'use strict';

SoundSpectrum.bindChartGestures = function (app, view, charts) {
  const { state, clamp, mix } = app;
  const { frequencyAt, positionOf, plotPosition, zoom, resetView, changeWindow } = view;
  const { dimensions, spectrum, spectrumContext, waterfall, waterContext } = charts;
  const longPressMs = 500;

  function attachGestures(canvas, context) {
    const pointers = new Map();
    let gesture = "pending";
    let longPressTimer = null;

    function fraction(x) {
      const plot = dimensions(canvas, context);
      return plot ? clamp((x - canvas.getBoundingClientRect().left - plot.left) / plot.w, 0, 1) : 0.5;
    }

    function moveCursor(x) {
      state.cursor = frequencyAt(mix(...state.range, fraction(x)));
      state.hover = null;
      state.dirty = true;
    }

    function cancelLongPress() {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    function releasePointer(event) {
      if (!pointers.delete(event.pointerId)) return false;
      cancelLongPress();
      if (gesture === "pinch" && pointers.size === 1) gesture = "pan";
      return true;
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
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY});
      canvas.setPointerCapture(event.pointerId);
      if (pointers.size === 2) {
        cancelLongPress();
        gesture = "pinch";
        return;
      }
      gesture = "pending";
      if (event.pointerType !== "touch") return;
      const session = state.session;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const pointer = pointers.get(event.pointerId);
        if (!pointer || state.session !== session) return;
        gesture = "cursor";
        moveCursor(pointer.x);
      }, longPressMs);
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
      const next = {...previous, x: event.clientX, y: event.clientY};
      pointers.set(event.pointerId, next);
      if (gesture === "cursor") {
        moveCursor(next.x);
        return;
      }
      if (longPressTimer !== null && Math.abs(next.y - next.startY) > 8) cancelLongPress();
      const plot = dimensions(canvas, context);
      if (!plot) return;
      const length = state.range[1] - state.range[0];
      if (gesture === "pinch") {
        const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
        const before = Math.max(8, Math.hypot(previous.x - other.x, previous.y - other.y));
        const after = Math.max(8, Math.hypot(next.x - other.x, next.y - other.y));
        const anchor = mix(...state.range, fraction((previous.x + other.x) / 2));
        const nextLength = clamp(length * before / after, 0.002, 1);
        changeWindow(anchor - fraction((next.x + other.x) / 2) * nextLength, nextLength);
      } else if (gesture === "pan" || Math.abs(next.x - next.startX) > 4) {
        cancelLongPress();
        const oldX = gesture === "pan" ? previous.x : next.startX;
        changeWindow(state.range[0] - (next.x - oldX) / plot.w * length, length);
        gesture = "pan";
      }
    });
    canvas.addEventListener("pointerup", event => {
      if (!releasePointer(event) || !state.session || pointers.size) return;
      if (gesture === "cursor") {
        moveCursor(event.clientX);
        return;
      }
      if (gesture !== "pending") return;
      const selected = frequencyAt(mix(...state.range, fraction(event.clientX)));
      state.cursor = state.cursor !== null && Math.abs(plotPosition(selected) - plotPosition(state.cursor)) < 0.009 ? null : selected;
      state.dirty = true;
    });
    canvas.addEventListener("lostpointercapture", releasePointer);
    canvas.addEventListener("pointercancel", releasePointer);
    canvas.addEventListener("contextmenu", event => {
      if (state.session && event.pointerType === "touch") event.preventDefault();
    });
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
