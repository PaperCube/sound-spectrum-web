'use strict';

SoundSpectrum.createAudio = function (app, view) {
  const { $, state, options, clamp, hz, invalidate, mix, waterLevelsPerDecibel } = app;
  const { frequencyAt, resetView } = view;
  const spectrum = $("spectrum");
  const waterfall = $("waterfall");
  let pausedAt = null;
  let totalPausedTime = 0;
  let pauseRevision = 0;
  const multiresUnavailable = "当前浏览器无法启动逐级降采样，已使用标准（单 FFT）。";
  const calibrationMs = 3000;
  const minNoiseGain = 10 ** (-12 / 10);
  const noiseGainRecoveryMs = 40;
  const noiseGainSmoothingMs = 150;
  let noiseWindowMs = 0;
  let noiseCalibration = null;
  let noisePower = null;
  let filterNoise = false;
  let rawSpectrum = state.current;
  let filteredSpectrum = null;
  let noiseGainDb = null;
  let lastFilteredAt = null;

  function setupAnalysis() {
    const record = state.session;
    const {context, source, highpass, mute} = record;
    record.multires?.close();
    record.multires = null;
    record.analyser?.disconnect();
    record.analyser = null;
    source.disconnect();
    highpass.disconnect();
    const input = options["remove-dc"] ? highpass : source;
    if (input === highpass) source.connect(highpass);

    const size = options.fft;
    const firstBin = options["remove-dc"] ? 1 : 0;
    let bands = [{rate: state.sampleRate, first: firstBin, end: size / 2}];
    if (options.multires && record.multiresReady) {
      const count = options["multires-bands"];
      // Splice at 40% of the lower sampling rate, inside the filter passband.
      // Align each boundary to a bin shared by both rates.
      const crossoverBin = Math.floor(size / 5);
      const plan = Array.from({length: count}, (_, index) => ({
        rate: state.sampleRate / 2 ** (count - 1 - index),
        first: index ? crossoverBin : firstBin,
        end: index === count - 1 ? size / 2 : 2 * crossoverBin
      }));
      try {
        const branch = SoundSpectrum.createMultires(context, size, plan, () => {
          if (state.session !== record || record.multires !== branch) return;
          record.multiresReady = false;
          setupAnalysis();
          if (state.paused) collect();
        });
        record.multires = branch;
        input.connect(branch.node);
        branch.node.connect(mute);
        bands = plan;
      } catch {
        record.multires?.close();
        record.multires = null;
        record.multiresReady = false;
      }
    }
    if (!record.multires) {
      const analyser = context.createAnalyser();
      analyser.fftSize = size;
      analyser.smoothingTimeConstant = options.smoothing;
      input.connect(analyser);
      analyser.connect(mute);
      record.analyser = analyser;
      record.data = new Float32Array(analyser.frequencyBinCount);
    }
    if (options.multires && !record.multires) showNotice(multiresUnavailable);
    else if ($("notice").textContent === multiresUnavailable) showNotice();

    const frequencies = [];
    for (const {rate, first, end} of bands) {
      for (let bin = first; bin < end; bin++) frequencies.push(bin * rate / size);
    }
    state.frequencies = Float32Array.from(frequencies);
    rawSpectrum = state.current = new Float32Array(state.frequencies.length).fill(-160);
    state.held = state.current.slice();
    state.peak = null;
    state.history = [];
    state.waterHistoryOffset = 0;
    state.cursor = null;
    state.hover = null;
    state.nextFrame = -Infinity;
    noiseWindowMs = 1000 * size / bands[0].rate;
    resetNoiseProfile();
    $("sample-rate").textContent = +(state.sampleRate / 1000).toFixed(3);
    $("resolution").textContent = +(bands[0].rate / size).toPrecision(3);
    $("resolution").parentElement.title = bands.map(({rate, first, end}) =>
      `${hz(first * rate / size)}–${hz(end * rate / size)} · 采样率 ${hz(rate)} · 间隔 ${+(rate / size).toPrecision(4)} Hz · 窗口 ${+(size / rate).toPrecision(3)} s`
    ).join("\n");
    invalidate();
  }

  function indexAt(frequency, frequencies = state.frequencies) {
    let low = 0, high = frequencies.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (frequencies[middle] < frequency) low = middle + 1;
      else high = middle;
    }
    return low && frequency - frequencies[low - 1] < frequencies[low] - frequency ? low - 1 : low;
  }

  function interpolatePeak(index) {
    const frequency = state.frequencies[index];
    let level = state.current[index];
    const step = frequency - state.frequencies[index - 1];
    const nextStep = state.frequencies[index + 1] - frequency;
    if (!Number.isFinite(step + nextStep) || Math.abs(nextStep - step) > step * 0.001) return {frequency, level};
    const left = state.current[index - 1], right = state.current[index + 1];
    const curvature = left - 2 * level + right;
    if (curvature >= 0) return {frequency, level};
    const offset = clamp(0.5 * (left - right) / curvature, -0.5, 0.5);
    level -= 0.25 * (left - right) * offset;
    return {frequency: frequency + offset * step, level: Math.min(0, level)};
  }

  function visiblePeaks() {
    if (!state.session || !options["peak-count"]) return [];
    const minimum = frequencyAt(state.range[0]);
    const maximum = frequencyAt(state.range[1]);
    const threshold = Math.max(options.floor, options["peak-floor"]);
    const candidates = [];
    for (let index = Math.max(0, indexAt(minimum) - 1); index < state.current.length; index++) {
      const frequency = state.frequencies[index];
      if (frequency > maximum && state.frequencies[index - 1] > maximum) break;
      const level = state.current[index];
      const left = state.current[index - 1] ?? -Infinity;
      const right = state.current[index + 1] ?? -Infinity;
      if (level < threshold || level <= left || level < right) continue;
      const candidate = interpolatePeak(index);
      if (candidate.frequency >= minimum && candidate.frequency <= maximum) candidates.push(candidate);
    }
    candidates.sort((a, b) => b.level - a.level);
    const selected = [];
    const spacing = options["peak-spacing"];
    for (const candidate of candidates) {
      if (spacing && selected.some(other => Math.abs(Math.log2(candidate.frequency / other.frequency)) < 1 / spacing)) continue;
      selected.push(candidate);
      if (selected.length === options["peak-count"]) break;
    }
    return selected;
  }

  function collect() {
    const {multires, analyser, data} = state.session;
    const capturedAt = pausedAt ?? performance.now();
    // Start calibration from the first fresh FFT window without carrying over earlier smoothed levels.
    const firstNoiseFrame = noiseCalibration && !noiseCalibration.frames && capturedAt >= noiseCalibration.start;
    if (multires) {
      const revision = pauseRevision;
      multires.read(firstNoiseFrame ? 0 : options.smoothing, spectrum => {
        if (state.session?.multires !== multires || revision !== pauseRevision) return;
        rawSpectrum = spectrum;
        storeSpectrum(capturedAt);
      });
      return;
    }
    if (firstNoiseFrame) analyser.smoothingTimeConstant = 0;
    analyser.getFloatFrequencyData(data);
    if (firstNoiseFrame) analyser.smoothingTimeConstant = options.smoothing;
    const first = options["remove-dc"] ? 1 : 0;
    for (let bin = first; bin < data.length; bin++) {
      // Web Audio uses a Blackman window and a two-sided FFT. Normalize to
      // the peak amplitude of a full-scale, bin-centred sinusoid.
      const correction = bin === 0 ? 7.54 : 13.56;
      rawSpectrum[bin - first] = clamp(data[bin] + correction, -160, 0);
    }
    storeSpectrum(capturedAt);
  }

  function refreshNoiseControls() {
    const active = Boolean(state.session) && !state.pending;
    $("noise-filter").checked = filterNoise;
    $("noise-filter").disabled = !active || !noisePower;
    $("noise-calibrate").disabled = !active || state.paused || Boolean(noiseCalibration);
    const status = $("noise-status");
    if (!active) status.textContent = "请先启用麦克风";
    else if (noiseCalibration) status.textContent = noiseCalibration.frames
      ? "正在采集底噪，请让目标声源保持安静"
      : `等待分析窗口更新（${Math.ceil(noiseWindowMs / 1000)} 秒），请让目标声源保持安静`;
    else if (noisePower) status.textContent = "底噪已校准";
    else status.textContent = state.paused ? "继续分析后可采集底噪" : "让目标声源停下，再采集底噪";
  }

  function resetNoiseProfile() {
    noiseCalibration = null;
    noisePower = null;
    filterNoise = false;
    filteredSpectrum = null;
    noiseGainDb = null;
    lastFilteredAt = null;
    refreshNoiseControls();
  }

  function calibrateNoise() {
    if (!state.session || state.pending || state.paused || noiseCalibration) return;
    noiseCalibration = {
      start: performance.now() + noiseWindowMs, last: null, elapsed: 0, frames: 0,
      totalPower: new Float64Array(rawSpectrum.length)
    };
    refreshNoiseControls();
  }

  function captureNoise(time) {
    const calibration = noiseCalibration;
    if (!calibration || time < calibration.start) return false;
    if (calibration.last !== null) {
      // A long gap between frames does not count as observed background.
      calibration.elapsed += Math.min(time - calibration.last, options.interval * 2);
    }
    calibration.last = time;
    for (let bin = 0; bin < rawSpectrum.length; bin++) {
      calibration.totalPower[bin] += 10 ** (rawSpectrum[bin] / 10);
    }
    calibration.frames++;
    if (calibration.frames === 1) refreshNoiseControls();
    if (calibration.elapsed < calibrationMs) return false;
    const firstProfile = !noisePower;
    noisePower = calibration.totalPower.map(power => power / calibration.frames);
    noiseCalibration = null;
    filterNoise ||= firstProfile;
    refreshNoiseControls();
    return true;
  }

  function setNoiseFilter(enabled) {
    if (!noisePower || filterNoise === enabled) return;
    filterNoise = enabled;
    updateSpectrum(true, performance.now());
    refreshNoiseControls();
    invalidate();
  }

  function updateSpectrum(resetHold, capturedAt) {
    if (filterNoise) {
      filteredSpectrum ??= new Float32Array(rawSpectrum.length);
      noiseGainDb ??= new Float32Array(rawSpectrum.length);
      const elapsed = resetHold || lastFilteredAt === null ? Infinity : Math.max(0, capturedAt - lastFilteredAt);
      const recoveryWeight = Math.exp(-elapsed / noiseGainRecoveryMs);
      const suppressionWeight = Math.exp(-elapsed / noiseGainSmoothingMs);
      for (let bin = 0; bin < rawSpectrum.length; bin++) {
        const power = 10 ** (rawSpectrum[bin] / 10);
        // Fade the attenuation out as the signal rises above the calibrated background.
        const noise = 6 * noisePower[bin];
        const gain = (power + minNoiseGain * noise) / (power + noise);
        const targetGainDb = 10 * Math.log10(gain);
        const previousGainDb = noiseGainDb[bin];
        const gainDb = mix(targetGainDb, previousGainDb, targetGainDb > previousGainDb ? recoveryWeight : suppressionWeight);
        noiseGainDb[bin] = gainDb;
        filteredSpectrum[bin] = Math.max(-160, rawSpectrum[bin] + gainDb);
      }
      lastFilteredAt = capturedAt;
      state.current = filteredSpectrum;
    } else {
      state.current = rawSpectrum;
    }
    if (resetHold) state.held = state.current.slice();
    let strongest = 0;
    for (let index = 0; index < state.current.length; index++) {
      const level = state.current[index];
      if (options.hold && level > state.held[index]) state.held[index] = level;
      if (level > state.current[strongest]) strongest = index;
    }
    state.peak = state.current[strongest] > -159 ? interpolatePeak(strongest) : null;
  }

  function storeSpectrum(capturedAt) {
    updateSpectrum(captureNoise(capturedAt), capturedAt);
    // Store the waterfall's display levels as bytes to keep long histories compact.
    const levels = new Uint8Array(state.current.length);
    for (let index = 0; index < levels.length; index++) levels[index] = Math.round(-state.current[index] * waterLevelsPerDecibel);
    const time = capturedAt - totalPausedTime;
    state.history.push({ time, levels });
    state.latest = time;
    invalidate();
  }

  function showNotice(message = "") {
    for (const id of ["notice", "settings-notice"]) {
      $(id).textContent = message;
      $(id).hidden = !message;
    }
  }

  function refreshStatus() {
    const active = Boolean(state.session);
    $("overview").dataset.input = active ? "active" : "idle";
    $("status").dataset.state = state.paused ? "paused" : active ? "mic" : "idle";
    $("status").textContent = state.pending ? "正在连接麦克风" : state.paused ? "已冻结" : active ? "麦克风已启用" : "麦克风未启用";
    $("spectrum-empty").hidden = active;
    $("water-empty").hidden = active;
    $("water-history").hidden = !active;
    spectrum.tabIndex = waterfall.tabIndex = active ? 0 : -1;
    $("pause-button").disabled = !active;
    $("fit-button").disabled = !active;
    $("export-image-button").disabled = !active;
    $("clear-button").disabled = !active;
    $("clear-peak-button").disabled = !active;
    $("pause-button").textContent = state.paused ? "继续" : "冻结";
    $("pause-button").setAttribute("aria-pressed", state.paused);
    $("input-device").disabled = state.pending;
    const microphoneButton = $("mic-button");
    microphoneButton.disabled = state.pending;
    microphoneButton.dataset.active = active;
    microphoneButton.querySelector("span").textContent = state.pending ? "正在连接…" : active ? "停止麦克风" : "启用麦克风";
    refreshNoiseControls();
  }

  function stopSession(record) {
    record.multires?.close();
    record.stream.getTracks().forEach(track => track.stop());
    record.context.close().catch(() => {});
  }

  function stopMicrophone() {
    const previous = state.session;
    state.session = null;
    stopSession(previous);
    state.sampleRate = null;
    state.frequencies = new Float32Array(0);
    rawSpectrum = state.current = new Float32Array(0);
    state.held = new Float32Array(0);
    state.peak = null;
    state.history = [];
    state.paused = false;
    resetNoiseProfile();
    $("sample-rate").textContent = "—";
    $("resolution").textContent = "—";
    $("resolution").parentElement.removeAttribute("title");
    resetView();
    refreshStatus();
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default");
      $("input-device").replaceChildren(new Option("系统默认", ""), ...devices.map((device, index) =>
        new Option(device.label || `麦克风 ${index + 1}`, device.deviceId)));
      $("input-device").value = devices.some(device => device.deviceId === state.inputDevice) ? state.inputDevice : "";
    } catch { /* The default input still works if enumeration is unavailable. */ }
  }

  async function useMicrophone(device) {
    if (state.pending) return;
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
      showNotice("当前页面无法访问麦克风。请使用支持 Web Audio 的浏览器，通过 localhost 或 HTTPS 打开。");
      return;
    }
    state.pending = true;
    refreshStatus();
    showNotice();
    let context, stream;
    try {
      context = new (window.AudioContext || window.webkitAudioContext)();
      const ready = context.resume();
      // Register a rejection handler immediately while the permission prompt is open.
      ready.catch(() => {});
      stream = await navigator.mediaDevices.getUserMedia({audio: {
        ...(device ? {deviceId: {exact: device}} : {}),
        channelCount: {ideal: 1}, echoCancellation: false, noiseSuppression: false, autoGainControl: false
      }});
      await ready;
      const multiresReady = await SoundSpectrum.prepareMultires(context);
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState === "ended") throw new DOMException("Audio input unavailable", "NotReadableError");
      const source = context.createMediaStreamSource(stream);
      const highpass = context.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 5;
      highpass.Q.value = Math.SQRT1_2;
      // Keep the processing graph active without playing the microphone back.
      const mute = context.createGain();
      mute.gain.value = 0;
      mute.connect(context.destination);
      const previous = state.session;
      const record = {context, stream, source, highpass, mute, multiresReady};
      state.session = record;
      state.inputDevice = device;
      state.sampleRate = context.sampleRate;
      state.paused = false;
      pausedAt = null;
      totalPausedTime = 0;
      setupAnalysis();
      resetView();
      if (previous) stopSession(previous);
      track.addEventListener("ended", () => {
        if (state.session !== record) return;
        stopMicrophone();
        showNotice("麦克风已断开。");
        refreshDevices();
      });
      refreshDevices();
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      context?.close().catch(() => {});
      const messages = {
        NotAllowedError: "麦克风权限未开启。请在浏览器的站点设置中允许麦克风，再试一次。",
        NotFoundError: "找不到可用的麦克风。",
        NotReadableError: "无法读取麦克风，请检查设备是否可用。",
        OverconstrainedError: "所选麦克风已不可用，请切换输入设备。"
      };
      showNotice(messages[error.name] || "连接麦克风失败，请检查浏览器权限和输入设备。");
      refreshDevices();
    } finally {
      state.pending = false;
      refreshStatus();
    }
  }

  function togglePause() {
    const now = performance.now();
    pauseRevision++;
    if (state.paused) {
      // Exclude manual freezes from the waterfall clock. Live sampling gaps still use elapsed time.
      totalPausedTime += now - pausedAt;
      pausedAt = null;
      state.nextFrame = -Infinity;
    } else {
      pausedAt = now;
      noiseCalibration = null;
    }
    state.paused = !state.paused;
    refreshStatus();
  }

  return { setupAnalysis, indexAt, visiblePeaks, collect, showNotice, refreshStatus, stopMicrophone, refreshDevices,
    useMicrophone, togglePause, calibrateNoise, setNoiseFilter };
};
