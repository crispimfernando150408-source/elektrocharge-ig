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
