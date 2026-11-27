'use strict';

(() => {
  const app = SoundSpectrum;
  const { state, options } = app;
  const view = app.createView(app);
  const audio = app.createAudio(app, view);
  const charts = app.createCharts(app, view, audio);

  app.bindSettingsHelp(app);
  app.bindControls(app, view, audio, charts);
  app.bindChartGestures(app, view, charts);

  window.addEventListener("pagehide", () => {
    if (state.session) audio.stopMicrophone();
  });

  function animate(now) {
    if (state.session && !state.paused && now >= state.nextFrame) {
      const delay = now - state.nextFrame;
      state.nextFrame = now + options.interval - (Number.isFinite(delay) ? delay % options.interval : 0);
      audio.collect();
    }
    charts.render();
    requestAnimationFrame(animate);
  }

  audio.refreshStatus();
  audio.refreshDevices();
  requestAnimationFrame(animate);
})();
