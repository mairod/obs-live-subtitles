// Converts Float32 audio frames to Int16 PCM and posts them to the page.
// The AudioContext is created at 16000 Hz, so no resampling is needed here.
class PcmWriter extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch?.length) {
      const out = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-writer', PcmWriter);
