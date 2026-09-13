// Testes das funções extraídas pra ig/lib.mjs, todos com fetch/sleep injetados (sem rede).
// publish-ci.mjs em si é um script de topo de nível (efeitos colaterais no import); a lógica
// que importa (escolha da fonte, retry, reporte) mora em lib.mjs e é testada aqui direto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buscarPostHoje, comRetry, criarGraph, pollContainer, reportarPublicado, resolverPost } from './lib.mjs';

function respostaJson(status, corpo) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(corpo), json: async () => corpo };
}

// ---------- resolverPost: escolha da fonte ----------

test('resolverPost usa a API quando ela responde um post', async () => {
  const fetchImpl = async () => respostaJson(200, { post: { id: 'p1', caption: 'oi', imagens: [], video: null } });
  const { origem, post } = await resolverPost({ apiBase: 'http://api', secret: 's', fetchImpl, pickPostLocal: () => { throw new Error('não devia chamar o fallback'); } });
  assert.equal(origem, 'api');
  assert.equal(post.id, 'p1');
});

test('resolverPost usa a API e repassa post:null (nada pra hoje)', async () => {
  const fetchImpl = async () => respostaJson(200, { post: null });
  const { origem, post } = await resolverPost({ apiBase: 'http://api', secret: 's', fetchImpl, pickPostLocal: () => { throw new Error('não devia chamar o fallback'); } });
  assert.equal(origem, 'api');
  assert.equal(post, null);
});

test('resolverPost cai no fallback local em erro de rede', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  const logs = [];
  const { origem, post } = await resolverPost({ apiBase: 'http://api', secret: 's', fetchImpl, log: (m) => logs.push(m), pickPostLocal: () => 'posts/semana1/post-x.json' });
  assert.equal(origem, 'local');
  assert.equal(post, 'posts/semana1/post-x.json');
  assert.match(logs[0], /indisponível/);
});

test('resolverPost cai no fallback local em 5xx do dashboard', async () => {
  const fetchImpl = async () => respostaJson(503, { error: 'fora do ar' });
  const { origem, post } = await resolverPost({ apiBase: 'http://api', secret: 's', fetchImpl, pickPostLocal: () => null });
  assert.equal(origem, 'local');
  assert.equal(post, null);
});

test('resolverPost NÃO cai no fallback em 4xx (erro de config, não de disponibilidade)', async () => {
  const fetchImpl = async () => respostaJson(401, { error: 'secret errado' });
  await assert.rejects(
    () => resolverPost({ apiBase: 'http://api', secret: 'errado', fetchImpl, pickPostLocal: () => { throw new Error('não devia cair aqui'); } }),
    /401/
  );
});

test('resolverPost usa o fallback local direto quando as envs não existem', async () => {
  const { origem, post } = await resolverPost({ apiBase: undefined, secret: undefined, pickPostLocal: () => 'posts/semana1/post-x.json' });
  assert.equal(origem, 'local');
  assert.equal(post, 'posts/semana1/post-x.json');
});

// ---------- buscarPostHoje ----------

test('buscarPostHoje devolve o post do corpo da resposta', async () => {
  const post = { id: 'abc', slug: 'seg', formato: 'reel', caption: 'x', imagens: [], video: null, schedule_at: '2026-09-13T19:00:00-03:00' };
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'http://api/api/conteudo/hoje');
    assert.equal(opts.headers.authorization, 'Bearer segredo');
    return respostaJson(200, { post });
  };
  const resultado = await buscarPostHoje({ apiBase: 'http://api', secret: 'segredo', fetchImpl });
  assert.deepEqual(resultado, post);
});

test('buscarPostHoje marca err.status em resposta de erro HTTP', async () => {
  const fetchImpl = async () => respostaJson(500, { error: 'boom' });
  await assert.rejects(
    () => buscarPostHoje({ apiBase: 'http://api', secret: 's', fetchImpl }),
    (err) => { assert.equal(err.status, 500); return true; }
  );
});

// ---------- reportarPublicado ----------

test('reportarPublicado manda ig_media_id no sucesso', async () => {
  let corpoEnviado;
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'http://api/api/conteudo/posts/p1/publicado');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers.authorization, 'Bearer s');
    corpoEnviado = JSON.parse(opts.body);
    return respostaJson(200, { post: {} });
  };
  await reportarPublicado({ apiBase: 'http://api', secret: 's', id: 'p1', ig_media_id: 'media123', fetchImpl });
  assert.deepEqual(corpoEnviado, { ig_media_id: 'media123' });
});

test('reportarPublicado manda erro na falha (nunca os dois campos)', async () => {
  let corpoEnviado;
  const fetchImpl = async (url, opts) => { corpoEnviado = JSON.parse(opts.body); return respostaJson(200, { post: {} }); };
  await reportarPublicado({ apiBase: 'http://api', secret: 's', id: 'p1', erro: 'Graph 500 em algo', fetchImpl });
  assert.deepEqual(corpoEnviado, { erro: 'Graph 500 em algo' });
});

test('reportarPublicado estoura se a API responder erro', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'falhou' });
  await assert.rejects(() => reportarPublicado({ apiBase: 'http://api', secret: 's', id: 'p1', ig_media_id: 'm', fetchImpl }), /500/);
});

// ---------- retry (comRetry / criarGraph) ----------

test('comRetry tenta de novo em erro transiente e devolve o resultado quando funciona', async () => {
  let chamadas = 0;
  const esperas = [];
  const resultado = await comRetry(
    async () => { chamadas++; if (chamadas < 3) { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; } return 'ok'; },
    { sleepFn: async (ms) => esperas.push(ms), log: () => {} }
  );
  assert.equal(resultado, 'ok');
  assert.equal(chamadas, 3);
  assert.deepEqual(esperas, [2000, 8000]);
});

test('comRetry não tenta de novo em erro definitivo (4xx)', async () => {
  let chamadas = 0;
  await assert.rejects(
    () => comRetry(async () => { chamadas++; throw new Error('Graph 400 em algo: {}'); }, { sleepFn: async () => {}, log: () => {} }),
    /Graph 400/
  );
  assert.equal(chamadas, 1);
});

test('comRetry desiste depois das tentativas e propaga o último erro', async () => {
  let chamadas = 0;
  await assert.rejects(
    () => comRetry(async () => { chamadas++; const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }, { sleepFn: async () => {}, log: () => {} }),
    (err) => { assert.equal(err.cause.code, 'ECONNRESET'); return true; }
  );
  assert.equal(chamadas, 3);
});

test('criarGraph aplica retry em ECONNRESET do Graph e depois publica normal', async () => {
  let chamadas = 0;
  const fetchImpl = async () => {
    chamadas++;
    if (chamadas === 1) { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }
    return respostaJson(200, { id: 'container1' });
  };
  const graph = criarGraph({ accessToken: 'tok', fetchImpl, retryOpts: { sleepFn: async () => {}, log: () => {} } });
  const resultado = await graph('123/media', { method: 'POST', params: { image_url: 'http://x/a.jpg' } });
  assert.equal(resultado.id, 'container1');
  assert.equal(chamadas, 2);
});

test('criarGraph propaga erro do Graph (status != 2xx) pro chamador', async () => {
  const fetchImpl = async () => respostaJson(400, { error: { message: 'parâmetro inválido' } });
  const graph = criarGraph({ accessToken: 'tok', fetchImpl, retryOpts: { sleepFn: async () => {}, log: () => {} } });
  await assert.rejects(() => graph('123/media', { method: 'POST' }), /Graph 400/);
});

// ---------- pollContainer ----------

test('pollContainer retorna assim que o container termina', async () => {
  let chamadas = 0;
  const graph = async () => { chamadas++; return { status_code: chamadas < 2 ? 'IN_PROGRESS' : 'FINISHED' }; };
  await pollContainer({ graph, containerId: 'c1', sleepFn: async () => {} });
  assert.equal(chamadas, 2);
});

test('pollContainer estoura em timeout total em vez de ficar preso', async () => {
  let agora = 0;
  const original = Date.now;
  Date.now = () => (agora += 1000);
  try {
    const graph = async () => ({ status_code: 'IN_PROGRESS' });
    await assert.rejects(
      () => pollContainer({ graph, containerId: 'c1', maxPolls: 1000, timeoutMs: 5000, sleepFn: async () => {} }),
      /Timeout/
    );
  } finally { Date.now = original; }
});

test('pollContainer estoura se o Graph reportar ERROR', async () => {
  const graph = async () => ({ status_code: 'ERROR' });
  await assert.rejects(() => pollContainer({ graph, containerId: 'c1', sleepFn: async () => {} }), /ERROR/);
});
