/*!
 * embed-worker.js — NakliOS semantic-index embedding worker.
 *
 * Loads all-MiniLM-L6-v2 (384-dim) through Transformers.js and mean-pools
 * normalized sentence embeddings, mirroring the VaultMind indexer that proved
 * the pipeline. One request at a time; the host serializes calls.
 *
 * Protocol (structured clone):
 *   → { type:'load', device:'webgpu'|'wasm' }
 *   ← { type:'progress', data:{ status, progress?, file? } }
 *   ← { type:'ready' } | { type:'error', message }
 *   → { type:'embed', id, texts:[string] }
 *   ← { type:'embeddings', id, vectors:[Float32Array(384)] } | { type:'error', id?, message }
 */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm';

env.allowLocalModels = false;

let extractor = null;

self.addEventListener('message', async event => {
  const msg = event.data || {};
  if (msg.type === 'load'){
    if (extractor){ self.postMessage({ type:'ready' }); return; }
    try {
      extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        device: msg.device === 'webgpu' ? 'webgpu' : 'wasm',
        dtype: msg.device === 'webgpu' ? 'fp16' : 'q8',
        progress_callback: p => {
          self.postMessage({
            type:'progress',
            data:{ status:p.status, progress:p.progress, file:p.file },
          });
        },
      });
      self.postMessage({ type:'ready' });
    } catch (err){
      extractor = null;
      self.postMessage({ type:'error', message:String(err?.message || err) });
    }
    return;
  }
  if (msg.type === 'embed'){
    if (!extractor){
      self.postMessage({ type:'error', id:msg.id, message:'Embedding model is not loaded' });
      return;
    }
    try {
      const texts = Array.isArray(msg.texts) ? msg.texts.map(String) : [];
      if (!texts.length){
        self.postMessage({ type:'embeddings', id:msg.id, vectors:[] });
        return;
      }
      const out = await extractor(texts, { pooling:'mean', normalize:true });
      const dims = out.dims || [texts.length, 384];
      const dim = dims[dims.length - 1] || 384;
      const vectors = [];
      for (let i = 0; i < texts.length; i++){
        vectors.push(out.data.slice(i * dim, (i + 1) * dim));
      }
      self.postMessage({ type:'embeddings', id:msg.id, vectors });
    } catch (err){
      self.postMessage({ type:'error', id:msg.id, message:String(err?.message || err) });
    }
  }
});
