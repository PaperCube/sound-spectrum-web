'use strict';

(() => {
  // Inline entry points also work when index.html is opened directly from disk.
  const scriptURL = entry => URL.createObjectURL(new Blob([`(${entry})();`], {type: "text/javascript"}));

  function captureProcessor() {
    class SpectrumCapture extends AudioWorkletProcessor {
      constructor() {
        super();
        this.block = new Float32Array(512);
        this.written = 0;
        this.port.onmessage = event => { this.sink = event.data; };
      }

      process(inputs) {
        const channel = inputs[0][0];
        if (!channel || !this.sink) return true;
        for (let index = 0; index < channel.length; index++) {
          this.block[this.written++] = channel[index];
          if (this.written === this.block.length) {
            this.sink.postMessage(this.block, [this.block.buffer]);
            this.block = new Float32Array(512);
            this.written = 0;
          }
        }
        return true;
      }
    }
    registerProcessor("spectrum-capture", SpectrumCapture);
  }

  function spectrumWorker() {
    function halfBandKernel() {
      const half = 31;
      const coefficients = new Float64Array(2 * half + 1);
      let sum = 0;
      for (let tap = 0; tap < coefficients.length; tap++) {
        const distance = tap - half;
        const phase = Math.PI * tap / half;
        const window = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
        const sinc = distance === 0 ? 0.5 : Math.sin(Math.PI * distance / 2) / (Math.PI * distance);
        coefficients[tap] = sinc * window;
        sum += coefficients[tap];
      }
      return coefficients.map(value => value / sum);
    }

    function createFFT(size) {
      const reversed = new Uint32Array(size);
      const window = new Float64Array(size);
      const cos = new Float64Array(size / 2);
      const sin = new Float64Array(size / 2);
      const real = new Float64Array(size);
      const imaginary = new Float64Array(size);
      for (let index = 0; index < size; index++) {
        reversed[index] = (reversed[index >>> 1] >>> 1) | ((index & 1) * (size / 2));
        const phase = 2 * Math.PI * index / size;
        window[index] = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
        if (index < size / 2) {
          cos[index] = Math.cos(phase);
          sin[index] = -Math.sin(phase);
        }
      }

      return function transform(stage) {
        const mask = size - 1;
        for (let index = 0; index < size; index++) {
          real[reversed[index]] = stage.samples[(stage.write + index) & mask] * window[index];
        }
        imaginary.fill(0);
        for (let width = 2; width <= size; width *= 2) {
          const half = width / 2;
          const stride = size / width;
          for (let start = 0; start < size; start += width) {
            for (let offset = 0; offset < half; offset++) {
              const left = start + offset;
              const right = left + half;
              const phase = offset * stride;
              const r = real[right] * cos[phase] - imaginary[right] * sin[phase];
              const i = real[right] * sin[phase] + imaginary[right] * cos[phase];
              real[right] = real[left] - r;
              imaginary[right] = imaginary[left] - i;
              real[left] += r;
              imaginary[left] += i;
            }
          }
        }
        return {real, imaginary};
      };
    }

    self.onmessage = ({data: config}) => {
      const {port, bands, fftSize} = config;
      const mask = fftSize - 1;
      const kernel = halfBandKernel();
      const center = (kernel.length - 1) / 2;
      const transform = createFFT(fftSize);
      let binCount = 0;
      const stages = bands.map(({first, end}) => {
        const offset = binCount;
        binCount += end - first;
        return {first, end, offset, samples: new Float32Array(fftSize), write: 0, smoothed: new Float64Array(end - first)};
      }).reverse();

      port.onmessage = ({data: block}) => {
        for (const input of block) {
          let sample = input;
          for (let index = 0; index < stages.length; index++) {
            const stage = stages[index];
            const latest = stage.write;
            const samples = stage.samples;
            samples[latest] = sample;
            stage.write = (latest + 1) & mask;
            if (index === stages.length - 1 || (stage.write & 1)) break;
            // The symmetric half-band filter has zero taps at all odd indices except its center.
            sample = kernel[center] * samples[(latest - center) & mask];
            for (let tap = 0; tap < center; tap += 2) {
              sample += kernel[tap] * (samples[(latest - tap) & mask] + samples[(latest - (2 * center - tap)) & mask]);
            }
          }
        }
      };

      self.onmessage = ({data: smoothing}) => {
        const spectrum = new Float32Array(binCount);
        const scale = 1 / (0.42 * fftSize);
        for (const stage of stages) {
          const {real, imaginary} = transform(stage);
          for (let bin = stage.first; bin < stage.end; bin++) {
            const index = bin - stage.first;
            const magnitude = Math.sqrt(real[bin] ** 2 + imaginary[bin] ** 2) * scale * (bin === 0 ? 1 : 2);
            const filtered = smoothing * stage.smoothed[index] + (1 - smoothing) * magnitude;
            stage.smoothed[index] = filtered;
            spectrum[stage.offset + index] = Math.max(-160, Math.min(0, 20 * Math.log10(filtered)));
          }
        }
        self.postMessage(spectrum, [spectrum.buffer]);
      };
    };
  }

  SoundSpectrum.prepareMultires = async function (context) {
    if (!context.audioWorklet || !window.Worker) return false;
    try {
      // Chromium rejects blob: worklet modules from file: pages.
      await context.audioWorklet.addModule(`data:text/javascript,${encodeURIComponent(`(${captureProcessor})();`)}`);
      return true;
    } catch {
      return false;
    }
  };

  SoundSpectrum.createMultires = function (context, fftSize, bands, onError) {
    const node = new AudioWorkletNode(context, "spectrum-capture", {channelCount: 1, channelCountMode: "explicit"});
    const url = scriptURL(spectrumWorker);
    let worker;
    let receive = null;
    try {
      worker = new Worker(url);
      const channel = new MessageChannel();
      worker.postMessage({port: channel.port2, fftSize, bands}, [channel.port2]);
      node.port.postMessage(channel.port1, [channel.port1]);
    } catch (error) {
      worker?.terminate();
      node.port.close();
      throw error;
    } finally {
      URL.revokeObjectURL(url);
    }
    worker.onmessage = ({data}) => {
      const callback = receive;
      receive = null;
      callback?.(data);
    };
    worker.onerror = node.onprocessorerror = onError;
    return {
      node,
      read(smoothing, callback) {
        if (receive) return;
        receive = callback;
        worker.postMessage(smoothing);
      },
      close() {
        worker.terminate();
        node.port.close();
        node.disconnect();
      }
    };
  };
})();
