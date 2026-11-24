import crypto from 'node:crypto';
import { getJSON, update, putBytes, getBytes, del } from './store.mjs';

export const config = { path: '/api/*' };

const ROLES = ['admin', 'editor', 'consulta'];
const KINDS = ['assinada', 'publicacao'];
const MAX_FILE = 5 * 1024 * 1024;
const TTL = 12 * 3600 * 1000;
const fails = new Map();

const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const E = (msg, status = 400) => J({ erro: msg }, status);
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const b64u = b => Buffer.from(b).toString('base64url');
const pad = (s, a) => String(s).padStart(3, '0') + '/' + a;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function secret() {
  const s = await update('secret', { v: '' }, c => { if (!c.v) c.v = crypto.randomBytes(32).toString('hex'); return c.v; });
  return s;
}
const hashPw = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
async function mkUser({ nome, login, senha, role, rh }) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomUUID(), nome: str(nome, 80), login: str(login, 40).toLowerCase(), role, rh: !!rh, ativo: true, salt, hash: await hashPw(senha, salt), criado: new Date().toISOString() };
}
const pub = u => ({ id: u.id, nome: u.nome, login: u.login, role: u.role, rh: !!u.rh, ativo: u.ativo !== false, criado: u.criado, ultimo: u.ultimo || null });

async function sign(uid) {
  const p = b64u(JSON.stringify({ u: uid, e: Date.now() + TTL }));
  const sig = crypto.createHmac('sha256', await secret()).update(p).digest('base64url');
  return p + '.' + sig;
}
async function auth(req) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [p, sig] = t.split('.');
  if (!p || !sig) return null;
  const ok = crypto.createHmac('sha256', await secret()).update(p).digest('base64url');
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (!d.e || d.e < Date.now()) return null;
  const us = await getJSON('users', { list: [] });
  const u = us.list.find(x => x.id === d.u);
  return u && u.ativo !== false ? u : null;
}
async function log(u, a) {
  try { await update('log', { l: [] }, c => { c.l.unshift({ t: new Date().toISOString(), u: u.login || u, n: u.nome || '', a }); c.l = c.l.slice(0, 1500); }); } catch { /* registro é opcional */ }
}

function cleanP(b, base = {}, u, canRH) {
  const p = { ...base };
  const ano = parseInt(b.ano, 10), seq = parseInt(b.seq, 10);
  if (!(ano >= 2000 && ano <= 2100)) throw new Error('Ano inválido.');
  if (!(seq >= 1 && seq <= 99999)) throw new Error('Número inválido.');
  p.seq = seq; p.ano = ano; p.numero = pad(seq, ano);
  p.data = /^\d{4}-\d{2}-\d{2}$/.test(b.data || '') ? b.data : '';
  p.resp = str(b.resp, 100) || (base.resp || u.nome);
  p.assunto = str(b.assunto, 1500);
  if (!p.assunto) throw new Error('Informe o assunto da portaria.');
  p.assinada = b.assinada === 'Sim' ? 'Sim' : 'Não';
  p.link = str(b.link, 600);
  if (p.link && !/^https?:\/\//i.test(p.link)) throw new Error('O link da publicação deve começar com http:// ou https://');
  p.servidores = [...new Set((Array.isArray(b.servidores) ? b.servidores : []).map(x => str(x, 120)).filter(Boolean))].slice(0, 40);
  p.obs = str(b.obs, 1000);
  if (canRH) {
    const novo = b.rh === 'Sim' ? 'Sim' : 'Não';
    if (novo !== base.rh) { p.rh = novo; p.rhEm = novo === 'Sim' ? new Date().toISOString() : ''; p.rhPor = novo === 'Sim' ? u.nome : ''; }
    else p.rh = novo;
  } else p.rh = base.rh || 'Não';
  return p;
}

function parseLegacy(r) {
  const num = str(r.num ?? r.numero, 40);
  let seq = 0, ano = 0;
  const m = num.match(/(\d+)\s*[\/\-.]\s*(\d{4})/);
  if (m) { seq = +m[1]; ano = +m[2]; } else { const d = num.match(/\d+/); if (d) seq = +d[0]; }
  const data = /^\d{4}-\d{2}-\d{2}/.test(r.data || '') ? r.data.slice(0, 10) : '';
  if (!ano) ano = data ? +data.slice(0, 4) : new Date().getFullYear();
  const sv = str(r.env ?? r.servidores, 600);
  return {
    seq, ano, numero: seq ? pad(seq, ano) : num, data, assunto: str(r.ass ?? r.assunto, 1500) || '(sem assunto)',
    servidores: sv ? sv.split(/[;\n]+|,\s+/).map(x => x.trim()).filter(Boolean).slice(0, 40) : [],
    resp: str(r.resp, 100), rh: r.rh === 'Sim' ? 'Sim' : 'Não', assinada: (r.sig === 'Sim' || r.assinada === 'Sim') ? 'Sim' : 'Não',
    link: /^https?:\/\//i.test(r.link || '') ? str(r.link, 600) : '', pub: (r.sit === 'Publicada') ? 'Sim' : '', legado: true, obs: '', arqs: {},
  };
}

async function readJSON(req) { try { return await req.json(); } catch { return {}; } }

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const me = req.method;
  try {
    // ---------- público ----------
    if (path[0] === 'status' && me === 'GET') {
      const us = await getJSON('users', { list: [] });
      return J({ setup: us.list.length === 0, codigo: !!process.env.SETUP_CODE });
    }
    if (path[0] === 'setup' && me === 'POST') {
      const b = await readJSON(req);
      if (process.env.SETUP_CODE && b.codigo !== process.env.SETUP_CODE) return E('Código de instalação incorreto.', 403);
      if (str(b.senha, 100).length < 6) return E('A senha precisa ter ao menos 6 caracteres.');
      if (!str(b.login) || !str(b.nome)) return E('Informe nome e login.');
      const u = await mkUser({ nome: b.nome, login: b.login, senha: str(b.senha, 100), role: 'admin', rh: true });
      const done = await update('users', { list: [] }, c => { if (c.list.length) return { __abort: true, value: false }; c.list.push(u); return true; });
      if (done === false) return E('O administrador já foi criado.', 409);
      await log(u, 'Administrador criado');
      return J({ ok: true });
    }
    if (path[0] === 'login' && me === 'POST') {
      const b = await readJSON(req);
      const login = str(b.login, 40).toLowerCase();
      const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '-';
      const key = login + '|' + ip, f = fails.get(key) || { n: 0, t: Date.now() };
      if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 6) return E('Muitas tentativas. Aguarde alguns minutos.', 429);
      const us = await getJSON('users', { list: [] });
      const u = us.list.find(x => x.login === login);
      const ok = u && u.ativo !== false && (await hashPw(String(b.senha ?? ''), u.salt)) === u.hash;
      if (!ok) { f.n++; fails.set(key, f); await sleep(500); await log({ login: login || '?' }, 'Tentativa de acesso recusada'); return E('Login ou senha incorretos.', 401); }
      fails.delete(key);
      await update('users', { list: [] }, c => { const x = c.list.find(y => y.id === u.id); if (x) x.ultimo = new Date().toISOString(); });
      await log(u, 'Entrou no sistema');
      return J({ token: await sign(u.id), user: pub(u) });
    }

    // ---------- autenticado ----------
    const u = await auth(req);
    if (!u) return E('Sessão expirada. Entre novamente.', 401);
    const isAdmin = u.role === 'admin', canEdit = isAdmin || u.role === 'editor';

    if (path[0] === 'me') return J({ user: pub(u) });

    if (path[0] === 'portarias') {
      if (!path[1] && me === 'GET') { const d = await getJSON('data', { items: [] }); return J({ items: d.items }); }
      if (!canEdit && me !== 'GET') return E('Seu perfil é somente de consulta.', 403);

      if (!path[1] && me === 'POST') {
        const b = await readJSON(req);
        const out = await update('data', { items: [] }, c => {
          const p = cleanP(b, { rh: 'Não' }, u, isAdmin || u.rh);
          if (c.items.some(x => x.seq === p.seq && x.ano === p.ano)) throw new Error(`A portaria ${p.numero} já foi cadastrada.`);
          p.id = crypto.randomUUID(); p.arqs = {}; p.criadoEm = new Date().toISOString(); p.criadoPor = u.nome; p.respLogin = u.login;
          c.items.push(p); return p;
        });
        await log(u, 'Cadastrou a portaria ' + out.numero);
        return J({ item: out }, 201);
      }
      const id = path[1];
      if (path[2] === 'file') {
        const kind = path[3];
        if (!KINDS.includes(kind)) return E('Tipo de arquivo inválido.');
        const d = await getJSON('data', { items: [] });
        const p = d.items.find(x => x.id === id);
        if (!p) return E('Portaria não encontrada.', 404);
        if (me === 'GET') {
          const f = await getBytes(`f:${id}:${kind}`);
          if (!f) return E('Arquivo não encontrado.', 404);
          const nome = (f.metadata && f.metadata.name) || `${kind}.pdf`;
          return new Response(f.data, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(nome)}`, 'cache-control': 'no-store' } });
        }
        if (me === 'PUT') {
          const buf = Buffer.from(await req.arrayBuffer());
          if (!buf.length) return E('Arquivo vazio.');
          if (buf.length > MAX_FILE) return E('O PDF deve ter no máximo 5 MB.', 413);
          if (buf.subarray(0, 5).toString() !== '%PDF-') return E('Envie um arquivo PDF.');
          const nome = str(decodeURIComponent(req.headers.get('x-filename') || `${kind}.pdf`), 150) || `${kind}.pdf`;
          await putBytes(`f:${id}:${kind}`, buf, { name: nome });
          const out = await update('data', { items: [] }, c => { const x = c.items.find(y => y.id === id); if (!x) return null; x.arqs = x.arqs || {}; x.arqs[kind] = { name: nome, size: buf.length, em: new Date().toISOString(), por: u.nome }; x.atualizadoEm = new Date().toISOString(); x.atualizadoPor = u.nome; return x; });
          await log(u, `Anexou PDF (${kind === 'assinada' ? 'assinada' : 'publicação'}) à portaria ${p.numero}`);
          return J({ item: out });
        }
        if (me === 'DELETE') {
          await del(`f:${id}:${kind}`);
          const out = await update('data', { items: [] }, c => { const x = c.items.find(y => y.id === id); if (!x) return null; if (x.arqs) delete x.arqs[kind]; return x; });
          await log(u, `Removeu PDF (${kind}) da portaria ${p.numero}`);
          return J({ item: out });
        }
      }
      if (id && !path[2] && me === 'PUT') {
        const b = await readJSON(req);
        const out = await update('data', { items: [] }, c => {
          const i = c.items.findIndex(x => x.id === id); if (i < 0) throw new Error('Portaria não encontrada.');
          const p = cleanP(b, c.items[i], u, isAdmin || u.rh);
          if (c.items.some(x => x.id !== id && x.seq === p.seq && x.ano === p.ano)) throw new Error(`A portaria ${p.numero} já existe.`);
          p.atualizadoEm = new Date().toISOString(); p.atualizadoPor = u.nome; c.items[i] = p; return p;
        });
        await log(u, 'Alterou a portaria ' + out.numero);
        return J({ item: out });
      }
      if (id && !path[2] && me === 'DELETE') {
        if (!isAdmin) return E('Só o administrador pode excluir portarias.', 403);
        const gone = await update('data', { items: [] }, c => { const i = c.items.findIndex(x => x.id === id); if (i < 0) return null; return c.items.splice(i, 1)[0]; });
        if (!gone) return E('Portaria não encontrada.', 404);
        for (const k of KINDS) await del(`f:${id}:${k}`).catch(() => {});
        await log(u, 'Excluiu a portaria ' + gone.numero);
        return J({ ok: true });
      }
    }

    if (path[0] === 'resps' && me === 'GET') { const r = await getJSON('resps', { list: [] }); return J({ list: r.list }); }

    // ---------- administração ----------
    if (!isAdmin) return E('Acesso restrito ao administrador.', 403);

    if (path[0] === 'users') {
      if (!path[1] && me === 'GET') { const us = await getJSON('users', { list: [] }); return J({ users: us.list.map(pub) }); }
      if (!path[1] && me === 'POST') {
        const b = await readJSON(req);
        if (!str(b.nome) || !str(b.login)) return E('Informe nome e login.');
        if (str(b.senha, 100).length < 6) return E('A senha precisa ter ao menos 6 caracteres.');
        if (!ROLES.includes(b.role)) return E('Perfil inválido.');
        if (!/^[a-z0-9._-]{3,40}$/i.test(str(b.login, 40))) return E('O login deve ter de 3 a 40 letras, números, ponto, hífen ou sublinhado.');
        const nu = await mkUser({ nome: b.nome, login: b.login, senha: str(b.senha, 100), role: b.role, rh: b.rh });
        const r = await update('users', { list: [] }, c => { if (c.list.some(x => x.login === nu.login)) throw new Error('Esse login já existe.'); c.list.push(nu); return nu; });
        await log(u, `Cadastrou o usuário ${r.login} (${r.role})`);
        return J({ user: pub(r) }, 201);
      }
      if (path[1] && me === 'PUT') {
        const b = await readJSON(req);
        const r = await update('users', { list: [] }, async c => {
          const x = c.list.find(y => y.id === path[1]); if (!x) throw new Error('Usuário não encontrado.');
          if (b.nome !== undefined) x.nome = str(b.nome, 80) || x.nome;
          if (b.role !== undefined) { if (!ROLES.includes(b.role)) throw new Error('Perfil inválido.'); x.role = b.role; }
          if (b.rh !== undefined) x.rh = !!b.rh;
          if (b.ativo !== undefined) x.ativo = !!b.ativo;
          if (b.senha) { if (str(b.senha, 100).length < 6) throw new Error('A senha precisa ter ao menos 6 caracteres.'); x.salt = crypto.randomBytes(16).toString('hex'); x.hash = await hashPw(str(b.senha, 100), x.salt); }
          if (!c.list.some(y => y.role === 'admin' && y.ativo !== false)) throw new Error('Precisa existir ao menos um administrador ativo.');
          return x;
        });
        await log(u, 'Alterou o usuário ' + r.login);
        return J({ user: pub(r) });
      }
      if (path[1] && me === 'DELETE') {
        if (path[1] === u.id) return E('Você não pode excluir o seu próprio acesso.');
        const r = await update('users', { list: [] }, c => { const i = c.list.findIndex(y => y.id === path[1]); if (i < 0) throw new Error('Usuário não encontrado.'); return c.list.splice(i, 1)[0]; });
        await log(u, 'Excluiu o usuário ' + r.login);
        return J({ ok: true });
      }
    }
    if (path[0] === 'resps' && me === 'PUT') {
      const b = await readJSON(req);
      const list = [...new Set((Array.isArray(b.list) ? b.list : []).map(x => str(x, 100)).filter(Boolean))].slice(0, 200).sort((a, c) => a.localeCompare(c, 'pt-BR'));
      await update('resps', { list: [] }, c => { c.list = list; });
      await log(u, 'Atualizou a lista de responsáveis');
      return J({ list });
    }
    if (path[0] === 'log' && me === 'GET') { const l = await getJSON('log', { l: [] }); return J({ log: l.l.slice(0, 400) }); }
    if (path[0] === 'import' && me === 'POST') {
      const b = await readJSON(req);
      const src = Array.isArray(b.items) ? b.items : [];
      if (!src.length) return E('Nenhuma portaria encontrada no conteúdo enviado.');
      if (src.length > 5000) return E('Quantidade excessiva de portarias.');
      const stat = await update('data', { items: [] }, c => {
        let novas = 0, ign = 0, atual = 0;
        for (const r of src) {
          const p = parseLegacy(r);
          const ex = p.seq ? c.items.find(x => x.seq === p.seq && x.ano === p.ano) : null;
          if (ex) {
            if (b.sobrescrever) { Object.assign(ex, { ...p, id: ex.id, arqs: ex.arqs || {}, criadoEm: ex.criadoEm }); atual++; } else ign++;
          } else { p.id = crypto.randomUUID(); p.criadoEm = new Date().toISOString(); p.criadoPor = u.nome + ' (importação)'; c.items.push(p); novas++; }
        }
        return { novas, ign, atual };
      });
      await log(u, `Importou portarias: ${stat.novas} novas, ${stat.atual} atualizadas, ${stat.ign} já existentes`);
      return J(stat);
    }
    return E('Rota não encontrada.', 404);
  } catch (e) {
    return E(e.message || 'Erro inesperado.', 400);
  }
};
