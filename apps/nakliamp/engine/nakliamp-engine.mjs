import { createReelEngine } from './reel-engine.mjs';

export class NakliAmpError extends Error {
  constructor(name, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = name;
    this.code = code;
  }
}

const DEFAULT_CONFIG = Object.freeze({
  version: '0.1.0-m0',
  sync: { decodeAheadMs: 300, videoDropGraceMs: 20, audioRingSeconds: 1 },
  decode: {
    maxPacketsPerSample: 4096,
    videoLookaheadUs: 750_000,
    audioLookaheadUs: 250_000,
    queueFlushSize: 16,
  },
  demux: {
    probeTimeoutMs: 30_000,
    packetReadTimeoutMs: 30_000,
    subtitleScanTimeoutMs: 120_000,
    maxTrackCount: 256,
    ebmlWindowBytes: 4096,
    maxEbmlElements: 2_000_000,
    maxSubtitleCueBytes: 1024 * 1024,
    maxSubtitleCues: 100_000,
    maxSubtitleTextBytes: 64 * 1024 * 1024,
    maxCodecPrivateBytes: 256 * 1024,
  },
});

const MIME_BY_EXTENSION = Object.freeze({
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  wav: 'audio/wav',
  wave: 'audio/wav',
  mka: 'audio/x-matroska',
});

function eventHub(externalEvents) {
  const listeners = new Map();
  const history = [];
  function emit(type, detail = {}) {
    const entry = { type, detail: structuredClone(detail), atMs: performance.now() };
    history.push(entry);
    if (history.length > 100) history.shift();
    for (const listener of listeners.get(type) || []) {
      try { listener(structuredClone(entry.detail)); } catch (_) {}
    }
    for (const listener of listeners.get('*') || []) {
      try { listener(structuredClone(entry)); } catch (_) {}
    }
    try { externalEvents?.emit?.(type, structuredClone(entry.detail)); } catch (_) {}
  }
  function on(type, listener) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
    return () => listeners.get(type)?.delete(listener);
  }
  return Object.freeze({ emit, on, history: () => structuredClone(history) });
}

async function fingerprint(file) {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', head);
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${file.size}-${hex.slice(0, 24)}`;
}

async function localFile(value) {
  if (value instanceof Blob) return value;
  if (value && typeof value.getFile === 'function') return value.getFile();
  throw new NakliAmpError(
    'InvalidMediaInputError',
    'ERR_NAKLIAMP_LOCAL_INPUT',
    'NakliAmp accepts a local File, Blob, or file handle.',
  );
}

function extensionOf(name = '') {
  return String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

function nativeMime(file) {
  return file.type || MIME_BY_EXTENSION[extensionOf(file.name)] || '';
}

function defaultNativeAudioFactory({ url }) {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = url;
  return audio;
}

function waitForNativeMetadata(audio, timeoutMs) {
  if (audio.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', onReady);
      audio.removeEventListener('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new NakliAmpError(
        'NativePlaybackError',
        'ERR_NAKLIAMP_NATIVE_LOAD',
        'The browser native audio path could not read this file.',
      ));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new NakliAmpError(
        'NativePlaybackTimeoutError',
        'ERR_NAKLIAMP_NATIVE_TIMEOUT',
        `The browser native audio path exceeded ${timeoutMs} ms.`,
      ));
    }, timeoutMs);
    audio.addEventListener('loadedmetadata', onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.load();
  });
}

function assertAudioOnly(metadata) {
  const audioTrack = metadata.tracks.find(track => track.type === 'audio');
  if (!audioTrack) {
    throw new NakliAmpError(
      'AudioTrackUnavailableError',
      'ERR_NAKLIAMP_NO_AUDIO',
      'NakliAmp could not find an audio track in this file.',
    );
  }
  if (metadata.tracks.some(track => track.type === 'video')) {
    throw new NakliAmpError(
      'VideoMediaRefusedError',
      'ERR_NAKLIAMP_VIDEO_MEDIA',
      'NakliAmp accepts audio files; open video media in Reel.',
    );
  }
  return audioTrack;
}

export function createNakliAmpEngine({
  version = DEFAULT_CONFIG.version,
  forcePath = 'auto',
  nativeAudioFactory = defaultNativeAudioFactory,
  events: externalEvents = null,
} = {}) {
  if (!['auto', 'r1', 'r2'].includes(forcePath)) {
    throw new TypeError(`Unknown NakliAmp playback path: ${forcePath}`);
  }

  const events = eventHub(externalEvents);
  const store = {
    media: { handle: null, name: null, fingerprint: null, duration: null },
    tracks: { audio: [], video: [], subtitle: [], selected: { video: 0, audio: 0, subtitle: -1 } },
    clock: { positionS: 0, playing: false, rate: 1, volume: 1, muted: false },
    ui: { screen: 'empty', devAgentFace: false },
  };
  const reel = createReelEngine({
    config: { ...DEFAULT_CONFIG, version },
    store,
    storage: { fingerprint },
    metadataSync: { state: () => ({ mode: 'local', lastError: null }) },
    events,
  });

  let mode = null;
  let status = 'idle';
  let nativeAudio = null;
  let nativeUrl = null;
  let nativeMetadata = null;
  let nativeFingerprint = null;
  let lastError = null;
  let latestLoadId = 0;

  function preferredMode() {
    if (forcePath === 'r1') return 'r1';
    if (forcePath === 'r2') return 'r2';
    return reel.caps().audioDecoder ? 'r1' : 'r2';
  }

  function disposeNative() {
    try { nativeAudio?.pause(); } catch (_) {}
    try { nativeAudio?.removeAttribute?.('src'); } catch (_) {}
    try { nativeAudio?.load(); } catch (_) {}
    if (nativeUrl) URL.revokeObjectURL(nativeUrl);
    nativeAudio = null;
    nativeUrl = null;
  }

  function disposeNativeCandidate(audio, url) {
    try { audio?.pause?.(); } catch (_) {}
    URL.revokeObjectURL(url);
  }

  function recordError(error) {
    lastError = {
      name: error?.name || 'Error',
      code: error?.code || 'ERR_NAKLIAMP_UNKNOWN',
      message: error?.message || String(error),
    };
    status = 'refused';
    events.emit('playback:refused', lastError);
  }

  async function loadR1(input, loadId) {
    const metadata = await reel.load(input);
    if (loadId !== latestLoadId) {
      throw new NakliAmpError(
        'SupersededLoadError',
        'ERR_NAKLIAMP_LOAD_SUPERSEDED',
        'A newer track selection replaced this request.',
      );
    }
    const track = assertAudioOnly(metadata);
    disposeNative();
    mode = 'r1';
    status = 'ready';
    nativeMetadata = null;
    nativeFingerprint = null;
    lastError = null;
    events.emit('track:loaded', {
      name: metadata.name,
      container: metadata.container,
      codec: track.codec,
      path: mode,
    });
    return structuredClone({ ...metadata, audioTrack: track, path: mode });
  }

  async function loadR2(input, loadId) {
    const file = await localFile(input);
    const metadata = await reel.probe(file);
    const track = assertAudioOnly(metadata);
    const mime = nativeMime(file);
    const candidateUrl = URL.createObjectURL(file);
    let candidateAudio;
    let adopted = false;
    try {
      candidateAudio = nativeAudioFactory({ url: candidateUrl, file, metadata });
      if (!candidateAudio || typeof candidateAudio.play !== 'function') {
        throw new TypeError('nativeAudioFactory must return an audio-like playback object.');
      }
      if (mime && typeof candidateAudio.canPlayType === 'function' && !candidateAudio.canPlayType(mime)) {
        throw new NakliAmpError(
          'NativeCodecUnsupportedError',
          'ERR_NAKLIAMP_NATIVE_UNSUPPORTED',
          `The browser native audio path does not support ${track.codec || extensionOf(file.name) || 'this codec'}.`,
        );
      }
      await waitForNativeMetadata(candidateAudio, DEFAULT_CONFIG.demux.probeTimeoutMs);
      const nextFingerprint = await fingerprint(file);
      if (loadId !== latestLoadId) {
        throw new NakliAmpError(
          'SupersededLoadError',
          'ERR_NAKLIAMP_LOAD_SUPERSEDED',
          'A newer track selection replaced this request.',
        );
      }
      reel.pause();
      disposeNative();
      nativeAudio = candidateAudio;
      nativeUrl = candidateUrl;
      nativeMetadata = {
        ...metadata,
        name: file.name || metadata.name,
        duration: Number.isFinite(candidateAudio.duration) ? candidateAudio.duration : metadata.duration,
      };
      nativeFingerprint = nextFingerprint;
      mode = 'r2';
      status = 'ready';
      lastError = null;
      adopted = true;
      events.emit('track:loaded', {
        name: nativeMetadata.name,
        container: metadata.container,
        codec: track.codec,
        path: mode,
      });
      return structuredClone({ ...nativeMetadata, audioTrack: track, path: mode });
    } catch (error) {
      if (!adopted) disposeNativeCandidate(candidateAudio, candidateUrl);
      throw error;
    }
  }

  async function load(input) {
    const loadId = ++latestLoadId;
    status = 'loading';
    const nextMode = preferredMode();
    try {
      return nextMode === 'r1' ? await loadR1(input, loadId) : await loadR2(input, loadId);
    } catch (error) {
      if (loadId !== latestLoadId) {
        throw new NakliAmpError(
          'SupersededLoadError',
          'ERR_NAKLIAMP_LOAD_SUPERSEDED',
          'A newer track selection replaced this request.',
          error,
        );
      }
      if (error?.code !== 'ERR_NAKLIAMP_LOAD_SUPERSEDED' && error?.code !== 'ERR_ENGINE_LOAD_SUPERSEDED') recordError(error);
      throw error;
    }
  }

  async function play() {
    if (mode === 'r1') await reel.play();
    else if (mode === 'r2' && nativeAudio) await nativeAudio.play();
    else throw new NakliAmpError('NoTrackError', 'ERR_NAKLIAMP_NO_TRACK', 'Open an audio file before playing.');
    status = 'playing';
    events.emit('transport:play', { positionS: state().clock.positionS, path: mode });
  }

  function pause() {
    if (mode === 'r1') reel.pause();
    if (mode === 'r2') nativeAudio?.pause();
    if (mode) status = 'paused';
    events.emit('transport:pause', { positionS: state().clock.positionS, path: mode });
  }

  async function seek(positionS) {
    const duration = state().media.duration;
    const next = Math.max(0, Math.min(Number.isFinite(duration) ? duration : Infinity, Number(positionS) || 0));
    if (mode === 'r1') await reel.seek(next);
    else if (mode === 'r2' && nativeAudio) nativeAudio.currentTime = next;
    else throw new NakliAmpError('NoTrackError', 'ERR_NAKLIAMP_NO_TRACK', 'Open an audio file before seeking.');
    events.emit('transport:seek', { positionS: next, path: mode });
  }

  function setVolume(value) {
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    if (mode === 'r1') reel.setVolume(next);
    if (nativeAudio) nativeAudio.volume = next;
  }

  function setMuted(value) {
    const next = !!value;
    if (mode === 'r1') reel.setMuted(next);
    if (nativeAudio) nativeAudio.muted = next;
  }

  function state() {
    if (mode === 'r1') {
      const upstream = reel.state();
      const track = upstream.tracks.audio[upstream.tracks.selected.audio] || null;
      return structuredClone({
        version,
        status,
        path: mode,
        media: upstream.media,
        track,
        clock: upstream.clock,
        honesty: {
          container: upstream.media.container,
          codec: track?.codec || null,
          decode: 'AudioDecoder',
          output: 'AudioWorklet · Web Audio',
          gapless: null,
          localOnly: true,
        },
        diagnostics: {
          consumedFrames: upstream.playback.audio.consumedFrames,
          droppedFrames: upstream.playback.audio.droppedFrames,
          lastError: upstream.playback.lastError,
        },
        error: lastError,
      });
    }
    if (mode === 'r2' && nativeAudio && nativeMetadata) {
      const track = nativeMetadata.tracks.find(candidate => candidate.type === 'audio') || null;
      return structuredClone({
        version,
        status: nativeAudio.paused ? (status === 'ready' ? 'ready' : 'paused') : 'playing',
        path: mode,
        media: {
          name: nativeMetadata.name,
          fingerprint: nativeFingerprint,
          duration: nativeMetadata.duration,
          size: nativeMetadata.size,
          container: nativeMetadata.container,
          mimeType: nativeMetadata.mimeType,
        },
        track,
        clock: {
          positionS: Number(nativeAudio.currentTime) || 0,
          playing: !nativeAudio.paused,
          rate: Number(nativeAudio.playbackRate) || 1,
          volume: Number(nativeAudio.volume) || 0,
          muted: !!nativeAudio.muted,
        },
        honesty: {
          container: nativeMetadata.container,
          codec: track?.codec || null,
          decode: 'browser native audio',
          output: 'native audio element',
          gapless: false,
          localOnly: true,
        },
        diagnostics: { consumedFrames: null, droppedFrames: null, lastError: null },
        error: lastError,
      });
    }
    return structuredClone({
      version,
      status,
      path: mode,
      media: { name: null, fingerprint: null, duration: null, size: null, container: null, mimeType: null },
      track: null,
      clock: { positionS: 0, playing: false, rate: 1, volume: 1, muted: false },
      honesty: null,
      diagnostics: { consumedFrames: null, droppedFrames: null, lastError: null },
      error: lastError,
    });
  }

  function destroy() {
    latestLoadId += 1;
    reel.pause();
    disposeNative();
    mode = null;
    status = 'idle';
  }

  return Object.freeze({
    version,
    caps: () => ({ ...reel.caps(), nativeAudio: typeof Audio === 'function', preferredPath: preferredMode() }),
    load,
    play,
    pause,
    seek,
    setVolume,
    setMuted,
    state,
    on: events.on,
    eventHistory: events.history,
    destroy,
  });
}
