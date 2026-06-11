// assets/sounds/ にループ可能なノイズ WAV を生成する
import * as fs from 'node:fs';
import * as path from 'node:path';

const SR = 44100;
const SEC = 10;
const FADE = Math.floor(SR * 0.1);
const OUT = path.resolve(import.meta.dirname, '../assets/sounds');

function writeWav(name, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(OUT, name), Buffer.concat([h, data]));
  console.log(name, Math.round((44 + data.length) / 1024), 'KB');
}

// ループの継ぎ目をイコールパワーでクロスフェードして無音化
function loopable(gen, gain) {
  const n = SR * SEC + FADE;
  const raw = new Float32Array(n);
  gen(raw);
  const out = new Float32Array(SR * SEC);
  out.set(raw.subarray(0, SR * SEC));
  for (let i = 0; i < FADE; i++) {
    const t = i / FADE;
    out[i] = out[i] * Math.sqrt(t) + raw[SR * SEC + i] * Math.sqrt(1 - t);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * gain;
  return out;
}

writeWav('white-noise.wav', loopable(buf => {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.random() * 2 - 1;
}, 0.35));

writeWav('pink-noise.wav', loopable(buf => {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < buf.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    buf[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
}, 0.5));

writeWav('brown-noise.wav', loopable(buf => {
  let last = 0;
  for (let i = 0; i < buf.length; i++) {
    last = (last + (Math.random() * 2 - 1) * 0.02) * 0.998;
    buf[i] = last;
  }
}, 0.6));
