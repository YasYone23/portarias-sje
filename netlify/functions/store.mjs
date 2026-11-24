// Camada de armazenamento: Netlify Blobs em produção, memória nos testes locais.
const NAME = 'gestao-portarias';
const mem = new Map();
let n = 0;
const memStore = {
  async getWithMetadata(k, o = {}) {
    const e = mem.get(k); if (!e) return null;
    const data = o.type === 'json' ? JSON.parse(Buffer.from(e.data).toString()) : o.type === 'arrayBuffer' ? e.data.slice(0) : Buffer.from(e.data).toString();
    return { data, etag: e.etag, metadata: e.metadata };
  },
  async set(k, v, o = {}) {
    const e = mem.get(k);
    if (o.onlyIfNew && e) return { modified: false };
    if (o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false };
    const buf = typeof v === 'string' ? Buffer.from(v) : Buffer.from(v);
    const etag = 'e' + (++n);
    mem.set(k, { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), etag, metadata: o.metadata || {} });
    return { modified: true, etag };
  },
  async delete(k) { mem.delete(k); },
};
let real;
async function st() {
  if (process.env.PORTARIAS_MEMORY) return memStore;
  if (!real) { const { getStore } = await import('@netlify/blobs'); real = getStore({ name: NAME, consistency: 'strong' }); }
  return real;
}
export async function getJSON(key, def = null) {
  const r = await (await st()).getWithMetadata(key, { type: 'json' });
  return r ? r.data : def;
}
// Atualização com tentativa de nova leitura se outra pessoa gravou ao mesmo tempo.
export async function update(key, def, fn) {
  const s = await st();
  for (let i = 0; i < 6; i++) {
    const r = await s.getWithMetadata(key, { type: 'json' });
    const cur = r ? r.data : structuredClone(def);
    const out = await fn(cur);
    if (out && out.__abort) return out.value;
    const opt = r && r.etag ? { onlyIfMatch: r.etag } : { onlyIfNew: true };
    const res = await s.set(key, JSON.stringify(cur), opt);
    if (res && res.modified === false) { await new Promise(y => setTimeout(y, 40 + Math.random() * 80)); continue; }
    return out;
  }
  throw new Error('Conflito de gravação, tente novamente.');
}
export async function putBytes(key, buf, metadata) { await (await st()).set(key, buf, { metadata }); }
export async function getBytes(key) { return (await st()).getWithMetadata(key, { type: 'arrayBuffer' }); }
export async function del(key) { await (await st()).delete(key); }
