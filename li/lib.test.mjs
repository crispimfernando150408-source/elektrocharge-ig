// li/lib.test.mjs
// Run: node --test li/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credenciaisLi, diasAteVencer, publicarUgc } from './lib.mjs';

function resposta(status, corpo, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(corpo), json: async () => corpo };
}

test('publicarUgc monta o share de texto e devolve o id do header', async () => {
  let pedido;
  const fetchImpl = async (url, init) => { pedido = { url, init }; return resposta(201, {}, { 'x-restli-id': 'urn:li:share:123' }); };
  const r = await publicarUgc({ texto: 'oi', authorUrn: 'urn:li:person:abc', token: 't', fetchImpl });
  assert.equal(r.id, 'urn:li:share:123');
  assert.equal(pedido.url, 'https://api.linkedin.com/v2/ugcPosts');
  assert.equal(pedido.init.headers['x-restli-protocol-version'], '2.0.0');
  const corpo = JSON.parse(pedido.init.body);
  assert.equal(corpo.author, 'urn:li:person:abc');
  assert.equal(corpo.lifecycleState, 'PUBLISHED');
  assert.equal(corpo.specificContent['com.linkedin.ugc.ShareContent'].shareCommentary.text, 'oi');
  assert.equal(corpo.visibility['com.linkedin.ugc.MemberNetworkVisibility'], 'PUBLIC');
});

test('publicarUgc em 401 estoura com mensagem de token', async () => {
  const fetchImpl = async () => resposta(401, { message: 'Invalid access token' });
  await assert.rejects(() => publicarUgc({ texto: 'oi', authorUrn: 'urn:li:person:abc', token: 'velho', fetchImpl }), /401.*token/i);
});

test('diasAteVencer conta dias inteiros', () => {
  assert.equal(diasAteVencer('2026-11-01T00:00:00Z', '2026-10-25T00:00:00Z'), 7);
  assert.equal(diasAteVencer('2026-10-20T00:00:00Z', '2026-10-25T00:00:00Z'), -5);
});

test('credenciaisLi: fernando é pessoa; elektro é organização; faltando, null', () => {
  const env = { LI_ACCESS_TOKEN: 't', LI_PERSON_URN: 'urn:li:person:a', LI_ACCESS_TOKEN_ELEKTRO: 'te', LI_AUTHOR_URN_ELEKTRO: 'urn:li:organization:9', LI_PAGINA_API_ELEKTRO: '1' };
  assert.deepEqual(credenciaisLi(env, 'fernando'), { token: 't', authorUrn: 'urn:li:person:a' });
  assert.deepEqual(credenciaisLi(env, 'elektro'), { token: 'te', authorUrn: 'urn:li:organization:9' });
  assert.equal(credenciaisLi(env, 'kaffra'), null);
});

test('publicarUgc aceita autor organização', async () => {
  let corpo;
  const fetchImpl = async (_u, init) => { corpo = JSON.parse(init.body); return resposta(201, {}, { 'x-restli-id': 'urn:li:share:1' }); };
  await publicarUgc({ texto: 'oi', authorUrn: 'urn:li:organization:9', token: 't', fetchImpl });
  assert.equal(corpo.author, 'urn:li:organization:9');
});

test('publicarUgc rejeita autor fora de pessoa ou organização', async () => {
  await assert.rejects(() => publicarUgc({ texto: 'oi', authorUrn: 'abc', token: 't', fetchImpl: async () => { throw new Error('não devia chamar'); } }), /authorUrn inválido/);
});

test('página com token mas sem LI_PAGINA_API_<CONTA>=1 não publica por API', () => {
  assert.equal(credenciaisLi({ LI_ACCESS_TOKEN_KAFFRA: 'tk', LI_AUTHOR_URN_KAFFRA: 'urn:li:organization:5' }, 'kaffra'), null);
});
