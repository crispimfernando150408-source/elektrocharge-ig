// x/lib.mjs
// Publicador do X para a fila do dashboard. Mesmo molde do ig/lib.mjs: tudo com
// fetch injetado, sem rede nos testes. Publicar usa OAuth 1.0a de usuário
// (POST /2/tweets); ler os próprios tweets usa Bearer app-only (US$ 0,001 por leitura).
import { createHmac, randomBytes } from 'node:crypto';

const API = 'https://api.x.com/2';

function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Header Authorization do OAuth 1.0a (HMAC-SHA1), determinístico dados nonce e timestamp. */
export function assinarOAuth1({ method, url, params = {}, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const todos = { ...params, ...oauth };
  const normalizado = Object.keys(todos).sort().map((k) => `${enc(k)}=${enc(todos[k])}`).join('&');
  const base = [method.toUpperCase(), enc(url), enc(normalizado)].join('&');
  const chave = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  const assinatura = createHmac('sha1', chave).update(base).digest('base64');
  const campos = { ...oauth, oauth_signature: assinatura };
  return 'OAuth ' + Object.keys(campos).sort().map((k) => `${enc(k)}="${enc(campos[k])}"`).join(', ');
}

/**
 * Segredos do X por conta. `fernando` = nomes históricos; outras contas usam sufixo _CONTA
 * nos tokens de usuário e no id, com o MESMO app (consumer key e secret únicos).
 */
export function credenciaisX(env, conta = 'fernando') {
  const suf = conta === 'fernando' ? '' : `_${conta.toUpperCase()}`;
  const token = env[`X_ACCESS_TOKEN${suf}`];
  const tokenSecret = env[`X_ACCESS_TOKEN_SECRET${suf}`];
  const userId = env[`X_USER_ID${suf}`];
  const consumerKey = env.X_CONSUMER_KEY;
  const consumerSecret = env.X_CONSUMER_SECRET;
  if (!token || !tokenSecret || !userId || !consumerKey || !consumerSecret) return null;
  return { consumerKey, consumerSecret, token, tokenSecret, userId };
}

async function lerCorpo(res) {
  const texto = await res.text();
  try { return JSON.parse(texto); } catch { return { raw: texto }; }
}

export async function buscarPostHojeRede({ apiBase, secret, rede, conta, fetchImpl = fetch }) {
  const res = await fetchImpl(`${apiBase}/api/conteudo/hoje?rede=${rede}&conta=${conta}`, { headers: { authorization: `Bearer ${secret}` } });
  const corpo = await lerCorpo(res);
  if (!res.ok) { const e = new Error(`API conteudo respondeu ${res.status}: ${JSON.stringify(corpo)}`); e.status = res.status; throw e; }
  return corpo?.post ?? null;
}

/** Últimos 20 tweets da conta (idempotência por texto). */
export async function tweetsRecentes({ userId, bearer, fetchImpl = fetch }) {
  const res = await fetchImpl(`${API}/users/${userId}/tweets?max_results=20&tweet.fields=text`, { headers: { authorization: `Bearer ${bearer}` } });
  const corpo = await lerCorpo(res);
  if (!res.ok) throw new Error(`X tweets recentes respondeu ${res.status}: ${JSON.stringify(corpo)}`);
  return (corpo.data ?? []).map((t) => ({ id: t.id, text: t.text }));
}

export async function publicarTweet({ texto, credenciais, fetchImpl = fetch, nonce, timestamp }) {
  const url = `${API}/tweets`;
  const authorization = assinarOAuth1({ method: 'POST', url, params: {}, ...credenciais, nonce, timestamp });
  const res = await fetchImpl(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ text: texto }) });
  const corpo = await lerCorpo(res);
  if (!res.ok) throw new Error(`X publicar respondeu ${res.status}: ${corpo.detail ?? corpo.title ?? JSON.stringify(corpo)}`);
  return { id: corpo.data.id };
}

export async function reportarPublicadoRede({ apiBase, secret, id, publicado_id, erro, fetchImpl = fetch }) {
  const body = publicado_id ? { publicado_id } : { erro };
  const res = await fetchImpl(`${apiBase}/api/conteudo/posts/${id}/publicado`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`API conteudo (publicado) respondeu ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

/** Normaliza para comparar legenda da fila com o `text` da API v2 (entidades HTML, t.co, espaços). */
function normalizarTexto(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Mesmo texto, ignorando escapes HTML, URLs (viram t.co no X) e espaços. */
export function mesmoTexto(a, b) {
  return normalizarTexto(a) === normalizarTexto(b);
}

/**
 * Adapta erro HTTP 5xx das nossas libs ("respondeu 503") ao `comRetry` da ig/lib.mjs,
 * que só reconhece "Graph 5xx" e falha de rede. 4xx segue direto, sem retry.
 */
export function comoTransiente(fn) {
  return async () => {
    try { return await fn(); }
    catch (e) {
      const m = /respondeu (\d{3})/.exec(e?.message ?? '');
      const status = e?.status ?? (m ? Number(m[1]) : undefined);
      if (status >= 500) { const novo = new Error(`Graph ${status} (transiente): ${e.message}`); novo.status = status; throw novo; }
      throw e;
    }
  };
}
