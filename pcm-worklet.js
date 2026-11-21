/**
 * 音频采集器：把麦克风的声音转成 Soniox 需要的格式
 * （16kHz 采样率、16位整数、单声道 PCM）
 */
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.buffer = [];
    this.bufferLen = 0;
    // 每约 120 毫秒发送一包
    this.chunkSize = Math.round(this.targetRate * 0.12);
    this._resamplePos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const data = input[0]; // 单声道 Float32

    // 从当前采样率重采样到 16kHz（线性插值）
    const ratio = sampleRate / this.targetRate;
    const out = [];
    let pos = this._resamplePos;
    while (pos < data.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(data[i] * (1 - frac) + data[i + 1] * frac);
      pos += ratio;
    }
    this._resamplePos = pos - data.length;

    if (out.length) {
      this.buffer.push(out);
      this.bufferLen += out.length;
    }

    while (this.bufferLen >= this.chunkSize) {
      const flat = [];
      let need = this.chunkSize;
      while (need > 0 && this.buffer.length) {
        const head = this.buffer[0];
        if (head.length <= need) {
          flat.push(...head);
          need -= head.length;
          this.buffer.shift();
        } else {
          flat.push(...head.slice(0, need));
          this.buffer[0] = head.slice(need);
          need = 0;
        }
      }
      this.bufferLen -= this.chunkSize;

      // Float32 → Int16
      const pcm = new Int16Array(flat.length);
      for (let i = 0; i < flat.length; i++) {
        const s = Math.max(-1, Math.min(1, flat[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
