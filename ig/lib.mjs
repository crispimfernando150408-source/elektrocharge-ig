// Funções extraídas de publish-ci.mjs pra ficarem testáveis sem rede real:
// injeção de fetch/fs/sleep em cada função, sem estado de módulo.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const GRAPH = 'https://graph.instagram.com/v21.0';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Formata erro de fetch com a causa (ECONNREFUSED, "bad port" etc.) quando existir, pra log claro.
export function formatarErro(err) {
  const causa = err?.cause?.code || err?.cause?.message;
  return `${err?.message || err}${causa ? ` (${causa})` : ''}`;
}

// Erros que valem retry: falha de rede (fetch failed/ECONNRESET/timeout) ou 5xx do Graph.
export function erroTransiente(err) {
  const msg = `${err?.message || ''} ${err?.cause?.code || ''} ${err?.cause?.message || ''}`;
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed/i.test(msg)) return true;
  const m = /Graph (\d{3})/.exec(msg);
  if (m && Number(m[1]) >= 500) return true;
  return false;
}

// Backoff fixo (2s, 8s, 20s) só pra erro transiente; erro definitivo (4xx, etc.) estoura na hora.
export async function comRetry(fn, { tentativas = 3, delays = [2000, 8000, 20000], sleepFn = sleep, log = console.log } = {}) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;
      if (i === tentativas - 1 || !erroTransiente(err)) throw err;
      const espera = delays[i] ?? delays[delays.length - 1];
      log(`  tentativa ${i + 1}/${tentativas} falhou (${formatarErro(err)}), nova tentativa em ${espera}ms`);
      await sleepFn(espera);
    }
  }
  throw ultimoErro;
}

// Fábrica do cliente do Graph API, com retry embutido em toda chamada.
export function criarGraph({ accessToken, fetchImpl = fetch, graphUrl = GRAPH, retryOpts = {} }) {
  async function chamada(path, { method = 'GET', params = {} } = {}) {
    const url = new URL(`${graphUrl}/${path}`);
    const opts = { method };
    const all = { ...params, access_token: accessToken };
    if (method === 'GET') for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    else opts.body = new URLSearchParams(all);
    const res = await fetchImpl(url, opts);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new Error(`Graph ${res.status} em ${path}: ${JSON.stringify(body?.error || body)}`);
    return body;
  }
  return (path, opts) => comRetry(() => chamada(path, opts), retryOpts);
}

// Poll do container com timeout total, pra nunca ficar preso esperando o Graph processar.
export async function pollContainer({ graph, containerId, maxPolls = 20, intervaloMs = 3000, timeoutMs, sleepFn = sleep }) {
  const inicio = Date.now();
  for (let i = 0; i < maxPolls; i++) {
    if (timeoutMs && Date.now() - inicio > timeoutMs) {
      throw new Error(`Timeout de ${timeoutMs}ms esperando o container processar (${containerId})`);
    }
    const { status_code } = await graph(containerId, { params: { fields: 'status_code' } });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR') throw new Error('Container deu ERROR no processamento.');
    await sleepFn(intervaloMs);
  }
  throw new Error(`Container não terminou de processar depois de ${maxPolls} consultas (${containerId})`);
}

// ---------- fila do dashboard (GET /api/conteudo/hoje) ----------

// `post: null` -> nada pra hoje. Erro de rede ou 5xx -> quem chama decide o fallback
// (o erro carrega `.status` quando veio do HTTP, undefined quando foi falha de rede).
export async function buscarPostHoje({ apiBase, secret, fetchImpl = fetch }) {
  const res = await fetchImpl(`${apiBase}/api/conteudo/hoje`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const err = new Error(`API conteudo respondeu ${res.status}${body ? `: ${JSON.stringify(body)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return body?.post ?? null;
}

// POST /api/conteudo/posts/<id>/publicado com ig_media_id (sucesso) ou erro (falha). Nunca os dois.
export async function reportarPublicado({ apiBase, secret, id, ig_media_id, erro, fetchImpl = fetch }) {
  const body = ig_media_id ? { ig_media_id } : { erro };
  const res = await fetchImpl(`${apiBase}/api/conteudo/posts/${id}/publicado`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`API conteudo (publicado) respondeu ${res.status}${texto ? `: ${texto}` : ''}`);
  }
  return res.json();
}

// Decide a fonte da fila: API do dashboard se configurada; fallback pra pasta local
// em erro de rede/5xx ou se as envs não existirem. Erro definitivo (4xx: secret errado,
// etc.) não cai no fallback: estoura, porque é config quebrada, não indisponibilidade.
export async function resolverPost({ apiBase, secret, fetchImpl = fetch, pickPostLocal, log = console.log }) {
  if (!apiBase || !secret) {
    return { origem: 'local', post: pickPostLocal() };
  }
  try {
    const post = await buscarPostHoje({ apiBase, secret, fetchImpl });
    return { origem: 'api', post };
  } catch (err) {
    if (err.status && err.status < 500) throw err;
    log(`API do dashboard indisponível (${formatarErro(err)}), caindo no fallback local.`);
    return { origem: 'local', post: pickPostLocal() };
  }
}

// ---------- fila local (fallback / histórico) ----------

// Varre posts/*/post-*.json e acha o cujo scheduleAt (data) == hoje (BR). arg explícito
// (caminho do post) tem prioridade, igual ao comportamento manual de sempre.
export function pickPostLocal({ todayBR, arg, postsDir = 'posts', readdirSyncFn = readdirSync, readFileSyncFn = readFileSync, joinFn = join }) {
  if (arg) return arg;
  for (const week of readdirSyncFn(postsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const dir = joinFn(postsDir, week.name);
    for (const f of readdirSyncFn(dir).filter((f) => /^post-.*\.json$/.test(f))) {
      const p = JSON.parse(readFileSyncFn(joinFn(dir, f), 'utf8'));
      if ((p.scheduleAt || '').slice(0, 10) === todayBR) return joinFn(dir, f);
    }
  }
  return null;
}
