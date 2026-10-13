// x/lib.test.mjs
// Run: node --test x/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assinarOAuth1, buscarPostHojeRede, comoTransiente, mesmoTexto, publicarTweet, reportarPublicadoRede, tweetsRecentes } from './lib.mjs';

function respostaJson(status, corpo, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(corpo), json: async () => corpo };
}
const cred = { consumerKey: 'ck', consumerSecret: 'cs', token: 'tk', tokenSecret: 'ts' };

test('assinarOAuth1 é determinística e carrega os campos oauth_*', () => {
  const a = assinarOAuth1({ method: 'POST', url: 'https://api.x.com/2/tweets', params: {}, ...cred, nonce: 'n1', timestamp: '1700000000' });
  const b = assinarOAuth1({ method: 'POST', url: 'https://api.x.com/2/tweets', params: {}, ...cred, nonce: 'n1', timestamp: '1700000000' });
  assert.equal(a, b);
  assert.match(a, /^OAuth /);
  for (const campo of ['oauth_consumer_key="ck"', 'oauth_token="tk"', 'oauth_signature_method="HMAC-SHA1"', 'oauth_nonce="n1"', 'oauth_timestamp="1700000000"', 'oauth_version="1.0"', 'oauth_signature="']) {
    assert.ok(a.includes(campo), campo);
  }
});

test('assinarOAuth1 muda a assinatura quando o método ou a URL mudam', () => {
  const base = { params: {}, ...cred, nonce: 'n', timestamp: '1' };
  const post = assinarOAuth1({ method: 'POST', url: 'https://api.x.com/2/tweets', ...base });
  const get = assinarOAuth1({ method: 'GET', url: 'https://api.x.com/2/tweets', ...base });
  assert.notEqual(post, get);
});

test('buscarPostHojeRede chama hoje com rede e conta e devolve o post', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return respostaJson(200, { post: { id: 'p9', caption: 'oi', rede: 'x', conta: 'fernando' } }); };
  const post = await buscarPostHojeRede({ apiBase: 'http://api', secret: 's', rede: 'x', conta: 'fernando', fetchImpl });
  assert.equal(post.id, 'p9');
  assert.match(urls[0], /\/api\/conteudo\/hoje\?rede=x&conta=fernando$/);
});

test('tweetsRecentes devolve id e texto', async () => {
  const fetchImpl = async () => respostaJson(200, { data: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }] });
  const lista = await tweetsRecentes({ userId: 'u', bearer: 'b', fetchImpl });
  assert.deepEqual(lista, [{ id: '1', text: 'a' }, { id: '2', text: 'b' }]);
});

test('publicarTweet envia JSON com text e devolve o id', async () => {
  let pedido;
  const fetchImpl = async (url, init) => { pedido = { url, init }; return respostaJson(201, { data: { id: '777', text: 'oi' } }); };
  const r = await publicarTweet({ texto: 'oi', credenciais: cred, fetchImpl, nonce: 'n', timestamp: '1' });
  assert.equal(r.id, '777');
  assert.equal(pedido.url, 'https://api.x.com/2/tweets');
  assert.equal(JSON.parse(pedido.init.body).text, 'oi');
  assert.match(pedido.init.headers.authorization, /^OAuth /);
});

test('publicarTweet estoura com o corpo do erro em 4xx', async () => {
  const fetchImpl = async () => respostaJson(403, { title: 'Forbidden', detail: 'sem permissão' });
  await assert.rejects(() => publicarTweet({ texto: 'oi', credenciais: cred, fetchImpl, nonce: 'n', timestamp: '1' }), /403.*sem permissão/);
});

test('reportarPublicadoRede manda publicado_id ou erro, nunca os dois', async () => {
  const corpos = [];
  const fetchImpl = async (url, init) => { corpos.push(JSON.parse(init.body)); return respostaJson(200, { post: {} }); };
  await reportarPublicadoRede({ apiBase: 'http://api', secret: 's', id: 'p', publicado_id: '777', fetchImpl });
  await reportarPublicadoRede({ apiBase: 'http://api', secret: 's', id: 'p', erro: 'x', fetchImpl });
  assert.deepEqual(corpos, [{ publicado_id: '777' }, { erro: 'x' }]);
});

// Review Focus 4 (idempotência por texto): a decisão "já está no X" vive em mesmoTexto.
test('mesmoTexto reconhece legenda com & que a API devolve como &amp;', () => {
  assert.equal(mesmoTexto('P&D em eletroposto', 'P&amp;D em eletroposto'), true);
  assert.equal(mesmoTexto('a < b > c', 'a &lt; b &gt; c'), true);
});

test('mesmoTexto ignora URL que o X troca por t.co e espaços sobrando', () => {
  assert.equal(mesmoTexto('Veja https://elektrocharge.com.br/blog/x  agora', 'Veja https://t.co/AbC123 agora'), true);
});

test('mesmoTexto distingue textos diferentes', () => {
  assert.equal(mesmoTexto('Carregar em casa', 'Carregar na rua'), false);
});

test('comoTransiente marca 5xx para retry e deixa 4xx passar', async () => {
  const { comRetry } = await import('../ig/lib.mjs');
  let n = 0;
  const r = await comRetry(comoTransiente(async () => { n++; if (n < 3) throw new Error('X publicar respondeu 503: x'); return 'ok'; }), { sleepFn: async () => {}, log: () => {} });
  assert.equal(r, 'ok'); assert.equal(n, 3);
  let m = 0;
  await assert.rejects(comRetry(comoTransiente(async () => { m++; throw new Error('X publicar respondeu 403: dup'); }), { sleepFn: async () => {}, log: () => {} }));
  assert.equal(m, 1);
});
