'use strict';
/*
 * Vercel Serverless Function: /api/history
 *
 * Menyimpan riwayat ke satu file JSON di repositori GitHub (default: data/history.json
 * di branch "data"). Token GitHub hanya ada di server (environment variable Vercel),
 * tidak pernah dikirim ke browser.
 *
 * GET  /api/history  -> baca riwayat (terbuka untuk siapa pun yang punya link situs)
 * POST /api/history  -> tulis riwayat (wajib header x-app-password = APP_PASSWORD)
 *
 * Environment variable:
 *   GITHUB_TOKEN      wajib  fine-grained token, izin Contents: Read and write, hanya untuk repositori ini
 *   APP_PASSWORD      wajib  kata sandi owner untuk menyimpan dan menghapus
 *   GITHUB_REPO       opsional "pemilik/nama-repo". Kalau kosong dipakai VERCEL_GIT_REPO_OWNER/SLUG
 *   GITHUB_BRANCH     opsional default "data"
 *   GITHUB_DATA_PATH  opsional default "data/history.json"
 */
const crypto = require('crypto');

const GH = 'https://api.github.com';
const DATA_PATH = process.env.GITHUB_DATA_PATH || 'data/history.json';
const BRANCH = process.env.GITHUB_BRANCH || 'data';
const MAX_ITEMS = 800; // Contents API hanya mengembalikan isi file sampai 1 MB

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function repoName() {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  if (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG) {
    return process.env.VERCEL_GIT_REPO_OWNER + '/' + process.env.VERCEL_GIT_REPO_SLUG;
  }
  return '';
}

function filePathUrl() {
  return DATA_PATH.split('/').map(encodeURIComponent).join('/');
}

async function gh(path, init) {
  const hasBody = init && init.body;
  const res = await fetch(GH + path, Object.assign({}, init, {
    headers: Object.assign({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'seed-profit-distribution'
    }, hasBody ? { 'Content-Type': 'application/json' } : {})
  }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { message: text }; }
  return { status: res.status, ok: res.ok, data: data };
}

function ghFail(r) {
  if (r.status === 401) return new HttpError(502, 'github_auth', 'Token GitHub ditolak. Periksa GITHUB_TOKEN di Vercel.');
  if (r.status === 403) return new HttpError(502, 'github_forbidden', 'Token GitHub tidak punya izin, atau batas permintaan GitHub tercapai.');
  if (r.status === 404) return new HttpError(502, 'github_not_found', 'Repositori tidak ditemukan. Periksa GITHUB_REPO dan akses token.');
  return new HttpError(502, 'github_error', (r.data && r.data.message) || ('GitHub membalas ' + r.status));
}

function emptyData() {
  return { version: 1, calcs: [], rates: [], config: null };
}

function normalize(d) {
  const out = emptyData();
  if (d && typeof d === 'object') {
    if (Array.isArray(d.calcs)) out.calcs = d.calcs;
    if (Array.isArray(d.rates)) out.rates = d.rates;
    if (d.config && typeof d.config === 'object') out.config = d.config;
  }
  return out;
}

async function readFile() {
  const repo = repoName();
  const r = await gh('/repos/' + repo + '/contents/' + filePathUrl() + '?ref=' + encodeURIComponent(BRANCH));
  if (r.status === 404) {
    // File atau branch belum ada. Pastikan repositorinya memang bisa diakses.
    const rr = await gh('/repos/' + repo);
    if (!rr.ok) throw ghFail(rr);
    return { data: emptyData(), sha: null };
  }
  if (!r.ok) throw ghFail(r);
  if (!r.data || !r.data.content || r.data.encoding === 'none') {
    throw new HttpError(500, 'too_large', 'File riwayat terlalu besar untuk dibaca. Hapus sebagian riwayat lama.');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
  } catch (_) {
    throw new HttpError(500, 'corrupt', 'File riwayat di GitHub rusak dan tidak bisa dibaca.');
  }
  return { data: normalize(parsed), sha: r.data.sha };
}

async function ensureBranch() {
  const repo = repoName();
  const b = await gh('/repos/' + repo + '/git/ref/heads/' + BRANCH);
  if (b.ok) return;
  if (b.status !== 404) throw ghFail(b);
  const info = await gh('/repos/' + repo);
  if (!info.ok) throw ghFail(info);
  const base = await gh('/repos/' + repo + '/git/ref/heads/' + info.data.default_branch);
  if (!base.ok) throw ghFail(base);
  const c = await gh('/repos/' + repo + '/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/' + BRANCH, sha: base.data.object.sha })
  });
  if (!c.ok && c.status !== 422) throw ghFail(c); // 422 = branch sudah dibuat oleh permintaan lain
}

async function writeFile(data, sha, message) {
  const body = {
    message: message,
    content: Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8').toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  return gh('/repos/' + repoName() + '/contents/' + filePathUrl(), { method: 'PUT', body: JSON.stringify(body) });
}

// Baca, ubah, tulis. Kalau ada yang menulis di antaranya (konflik), ulangi dari awal.
async function mutate(fn, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await readFile();
    if (cur.sha === null) await ensureBranch();
    const next = fn(cur.data);
    const r = await writeFile(next, cur.sha, message);
    if (r.ok) return next;
    if (r.status === 409 || r.status === 422) continue;
    throw ghFail(r);
  }
  throw new HttpError(409, 'conflict', 'Riwayat sedang diubah dari tempat lain. Coba lagi sebentar.');
}

function passwordOk(req) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) throw new HttpError(503, 'no_password', 'APP_PASSWORD belum diatur di Vercel.');
  const given = String(req.headers['x-app-password'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(pw).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- validasi: hanya bentuk data yang dikenal yang boleh masuk ----------
function invalid(msg) { return new HttpError(400, 'invalid', msg || 'Data tidak valid.'); }
function isNum(v, min, max) { return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max; }
function newId() { return Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function nowIso() { return new Date().toISOString(); }

function cleanRatePair(r, required) {
  if (r == null) {
    if (required) throw invalid('Rate tidak valid.');
    return null;
  }
  if (typeof r !== 'object' || !isNum(r.s, 1e-9, 1e12) || !isNum(r.w, 0, 1e12)) throw invalid('Rate tidak valid.');
  return { s: r.s, w: r.w };
}

function cleanPct(p) {
  if (!p || typeof p !== 'object') throw invalid('Persentase tidak valid.');
  const out = {};
  let sum = 0;
  ['modal', 'owner', 'worker'].forEach(function (k) {
    if (!isNum(p[k], 0, 100)) throw invalid('Persentase tidak valid.');
    out[k] = p[k];
    sum += p[k];
  });
  if (Math.abs(sum - 100) > 0.001) throw invalid('Total persentase harus 100%.');
  return out;
}

function cleanCalc(e) {
  if (!e || typeof e !== 'object') throw invalid();
  if (e.mode !== 'simple' && e.mode !== 'adv') throw invalid();
  if (['pasar', 'jual', 'beli'].indexOf(e.basis) === -1) throw invalid();
  if (!isNum(e.seeds, 1e-9, 1e12) || !isNum(e.gross, 0, 1e13) || !isNum(e.base, 0, 1e13)) throw invalid();
  const rate = cleanRatePair(e.rate, true);
  const pct = cleanPct(e.pct);
  if (!e.alloc || typeof e.alloc !== 'object') throw invalid();
  const alloc = {};
  let sumAlloc = 0;
  ['modal', 'owner', 'worker'].forEach(function (k) {
    if (!isNum(e.alloc[k], 0, 1e13)) throw invalid();
    alloc[k] = e.alloc[k];
    sumAlloc += e.alloc[k];
  });
  if (Math.abs(sumAlloc - e.base) > 0.02) throw invalid('Pembagian tidak cocok dengan dasar hitung.');
  let flow = null;
  if (e.flow != null) {
    const f = e.flow;
    if (typeof f !== 'object') throw invalid();
    ['modal', 'biaya', 'fee', 'returned', 'net'].forEach(function (k) {
      if (!isNum(f[k], 0, 1e13)) throw invalid();
    });
    if (!isNum(f.feePct, 0, 100)) throw invalid();
    flow = { modal: f.modal, biaya: f.biaya, feePct: f.feePct, fee: f.fee, returned: f.returned, net: f.net };
  }
  if (e.mode === 'adv' && !flow) throw invalid();
  return {
    id: newId(),
    t: nowIso(),
    label: String(e.label == null ? '' : e.label).replace(/[\r\n]+/g, ' ').slice(0, 80),
    mode: e.mode,
    seeds: e.seeds,
    basis: e.basis,
    rate: rate,
    gross: e.gross,
    base: e.base,
    flow: flow,
    pct: pct,
    alloc: alloc
  };
}

function cleanRateEntry(e) {
  if (!e || typeof e !== 'object') throw invalid();
  return {
    id: newId(),
    t: nowIso(),
    pasar: cleanRatePair(e.pasar, true),
    jual: cleanRatePair(e.jual, false),
    beli: cleanRatePair(e.beli, false)
  };
}

function cleanConfig(c) {
  const p = cleanPct(c);
  return { modal: p.modal, owner: p.owner, worker: p.worker, t: nowIso() };
}

function safeId(v) {
  return String(v == null ? '' : v).replace(/[^\w-]/g, '').slice(0, 40);
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.GITHUB_TOKEN || !repoName()) {
      throw new HttpError(503, 'not_configured', 'GITHUB_TOKEN atau GITHUB_REPO belum diatur di Vercel.');
    }

    if (req.method === 'GET') {
      const cur = await readFile();
      return send(res, 200, cur.data);
    }

    if (req.method === 'POST') {
      if (!passwordOk(req)) {
        await sleep(700);
        throw new HttpError(401, 'unauthorized', 'Kata sandi salah.');
      }
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (_) { throw invalid('Isi permintaan bukan JSON.'); }
      }
      body = body || {};

      switch (body.action) {
        case 'verify':
          return send(res, 200, { ok: true });

        case 'addCalc': {
          const e = cleanCalc(body.entry);
          const out = await mutate(function (d) {
            if (d.calcs.length >= MAX_ITEMS) throw new HttpError(400, 'full', 'Riwayat kalkulasi penuh (' + MAX_ITEMS + '). Hapus riwayat lama dulu.');
            d.calcs.unshift(e);
            return d;
          }, 'Riwayat: tambah kalkulasi ' + e.id);
          return send(res, 200, out);
        }

        case 'addRate': {
          const e = cleanRateEntry(body.entry);
          const out = await mutate(function (d) {
            if (d.rates.length >= MAX_ITEMS) throw new HttpError(400, 'full', 'Riwayat rate penuh (' + MAX_ITEMS + '). Hapus riwayat lama dulu.');
            d.rates.unshift(e);
            return d;
          }, 'Riwayat: catat rate ' + e.id);
          return send(res, 200, out);
        }

        case 'deleteCalc':
        case 'deleteRate': {
          const key = body.action === 'deleteCalc' ? 'calcs' : 'rates';
          const id = safeId(body.id);
          if (!id) throw invalid();
          const out = await mutate(function (d) {
            const n = d[key].length;
            d[key] = d[key].filter(function (x) { return x && x.id !== id; });
            if (d[key].length === n) throw new HttpError(404, 'not_found', 'Catatan tidak ditemukan.');
            return d;
          }, 'Riwayat: hapus ' + (key === 'calcs' ? 'kalkulasi ' : 'rate ') + id);
          return send(res, 200, out);
        }

        case 'clear': {
          if (body.kind !== 'calcs' && body.kind !== 'rates') throw invalid();
          const out = await mutate(function (d) {
            d[body.kind] = [];
            return d;
          }, 'Riwayat: hapus semua ' + (body.kind === 'calcs' ? 'kalkulasi' : 'rate'));
          return send(res, 200, out);
        }

        case 'saveConfig': {
          const cfg = cleanConfig(body.config);
          const out = await mutate(function (d) {
            d.config = cfg;
            return d;
          }, 'Riwayat: simpan konfigurasi persentase');
          return send(res, 200, out);
        }

        default:
          throw invalid('Aksi tidak dikenal.');
      }
    }

    res.setHeader('Allow', 'GET, POST');
    throw new HttpError(405, 'method', 'Metode tidak didukung.');
  } catch (e) {
    const known = e instanceof HttpError;
    if (!known) console.error(e);
    return send(res, known ? e.status : 500, {
      error: known ? e.code : 'server_error',
      message: known ? e.message : 'Terjadi kesalahan di server.'
    });
  }
};
