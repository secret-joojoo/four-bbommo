// Decodes the runner's color + matte video into one array of pre-composited
// frames, entirely off the main thread (so page load/interaction never
// blocks on it, and it runs on its own CPU core in parallel with everything
// else). See app.js for why this bakes frames up front instead of playing
// two <video> elements live.
importScripts('mp4box.all.min.js');

function getAvcCDescription(mp4boxfile, trackId) {
  const trak = mp4boxfile.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    if (entry.avcC) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      entry.avcC.write(stream);
      return new Uint8Array(stream.buffer, 8); // skip the box's size+type header
    }
  }
  throw new Error('no avcC box found');
}

function decodeVideoFrames(url, onFrame) {
  return fetch(url).then((r) => r.arrayBuffer()).then((buf) => new Promise((resolve, reject) => {
    buf.fileStart = 0;
    const mp4boxfile = MP4Box.createFile();
    let decoder, index = 0, total = 0, queued = 0;
    mp4boxfile.onError = (e) => reject(new Error(String(e)));
    mp4boxfile.onReady = (info) => {
      const track = info.videoTracks[0];
      total = track.nb_samples;
      const description = getAvcCDescription(mp4boxfile, track.id);
      decoder = new VideoDecoder({
        output: (frame) => {
          onFrame(index, frame);
          frame.close();
          index++;
        },
        error: (e) => reject(e)
      });
      decoder.configure({ codec: track.codec, codedWidth: track.track_width, codedHeight: track.track_height, description });
      mp4boxfile.setExtractionOptions(track.id, null, { nbSamples: total });
      mp4boxfile.start();
    };
    mp4boxfile.onSamples = (id, user, samples) => {
      for (const sample of samples) {
        decoder.decode(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: (sample.cts * 1e6) / sample.timescale,
          duration: (sample.duration * 1e6) / sample.timescale,
          data: sample.data
        }));
        queued++;
      }
      // A decoder can hold the last few frames in an internal reorder/lookahead
      // buffer and never emit them through `output` without an explicit
      // flush() — decode() alone is not enough to guarantee every frame comes
      // out. Only flush once every sample has actually been queued.
      if (queued === total) {
        decoder.flush().then(() => resolve(index)).catch(reject);
      }
    };
    mp4boxfile.appendBuffer(buf);
    mp4boxfile.flush();
  }));
}

function resizeImageBufferBilinear(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = srcW / dstW, yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, y * yRatio);
    const sy0 = Math.floor(sy), sy1 = Math.min(srcH - 1, sy0 + 1);
    const fy = sy - sy0;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, x * xRatio);
      const sx0 = Math.floor(sx), sx1 = Math.min(srcW - 1, sx0 + 1);
      const fx = sx - sx0;
      const i00 = (sy0 * srcW + sx0) * 4;
      const i01 = (sy0 * srcW + sx1) * 4;
      const i10 = (sy1 * srcW + sx0) * 4;
      const i11 = (sy1 * srcW + sx1) * 4;
      const di = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx;
        const bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx;
        dst[di + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return dst;
}

self.onmessage = async (e) => {
  const { colorUrl, matteUrl, displayHeight, dpr } = e.data;
  let dw = 0, dh = 0;
  let chain = null; // reused mip-chain canvases, built once native size is known
  let fallbackCtx = null; // used only if the native frame is already <= target size

  function buildChain(srcW, srcH) {
    const result = [];
    let w = srcW, h = srcH;
    while (w > dw * 2 && h > dh * 2) {
      w = Math.max(dw, Math.round(w / 2));
      h = Math.max(dh, Math.round(h / 2));
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      result.push({ canvas: c, ctx, w, h });
    }
    return result;
  }

  // Each stream is still fully opaque at this point (no alpha compositing
  // yet — that only happens in combine() below), so there's no
  // premultiplication concern here and plain drawImage scaling is safe.
  function captureDownscaled(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    if (!chain) {
      const aspect = w / h;
      const cssWidth = displayHeight * aspect;
      dw = Math.round(cssWidth * dpr);
      dh = Math.round(displayHeight * dpr);
      chain = buildChain(w, h);
    }
    let src = frame, sw = w, sh = h;
    for (const step of chain) {
      step.ctx.drawImage(src, 0, 0, sw, sh, 0, 0, step.w, step.h);
      src = step.canvas; sw = step.w; sh = step.h;
    }
    let finalCtx;
    if (chain.length) {
      finalCtx = chain[chain.length - 1].ctx;
    } else {
      if (!fallbackCtx) fallbackCtx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
      fallbackCtx.drawImage(frame, 0, 0);
      finalCtx = fallbackCtx;
    }
    return { data: finalCtx.getImageData(0, 0, sw, sh).data, w: sw, h: sh };
  }

  function combine(colorBuf, matteBuf) {
    const cd = colorBuf.data, ad = matteBuf.data;
    const premult = new Uint8ClampedArray(cd.length);
    for (let i = 0; i < cd.length; i += 4) {
      // Snap near-black matte noise to fully transparent instead of copying
      // the raw grayscale value straight across — compression noise on the
      // matte's black background otherwise survives as a faint patch.
      const raw = ad[i];
      const a = raw < 40 ? 0 : raw > 215 ? 255 : Math.round((raw - 40) * (255 / 175));
      premult[i]     = (cd[i]     * a) / 255;
      premult[i + 1] = (cd[i + 1] * a) / 255;
      premult[i + 2] = (cd[i + 2] * a) / 255;
      premult[i + 3] = a;
    }
    const final = resizeImageBufferBilinear(premult, colorBuf.w, colorBuf.h, dw, dh);
    for (let i = 0; i < final.length; i += 4) {
      const a = final[i + 3];
      if (a > 0) {
        const inv = 255 / a;
        final[i] = Math.min(255, final[i] * inv);
        final[i + 1] = Math.min(255, final[i + 1] * inv);
        final[i + 2] = Math.min(255, final[i + 2] * inv);
      }
    }
    return final;
  }

  try {
    const colorBufs = [];
    const matteBufs = [];
    const [colorCount, matteCount] = await Promise.all([
      decodeVideoFrames(colorUrl, (i, frame) => { colorBufs[i] = captureDownscaled(frame); }),
      decodeVideoFrames(matteUrl, (i, frame) => { matteBufs[i] = captureDownscaled(frame); })
    ]);
    const count = Math.min(colorCount, matteCount);
    const buffers = new Array(count);
    for (let i = 0; i < count; i++) buffers[i] = combine(colorBufs[i], matteBufs[i]).buffer;
    self.postMessage({ ok: true, count, dw, dh, buffers }, buffers);
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
