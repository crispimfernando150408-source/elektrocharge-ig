// Testes das funções extraídas pra ig/lib.mjs, todos com fetch/sleep injetados (sem rede).
// publish-ci.mjs em si é um script de topo de nível (efeitos colaterais no import); a lógica
// que importa (escolha da fonte, retry, reporte) mora em lib.mjs e é testada aqui direto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credenciaisIg, buscarPostsHoje, comRetry, criarGraph, dentroDaJanela, filtrarProntos, horaSimulada, paraPublicar, paramsDoReel, pickPostLocal, pollContainer, publicarLista, relogioBR, reportarPublicado, resolverPosts } from './lib.mjs';

function respostaJson(status, corpo) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(corpo), json: async () => corpo };
}

// ---------- resolverPosts: escolha da fonte ----------

test('resolverPosts usa a API e devolve a lista', async () => {
  const fetchImpl = async () => respostaJson(200, { post: { id: 'p1' }, posts: [{ id: 'p1' }, { id: 'p2' }] });
  const { origem, posts } = await resolverPosts({ apiBase: 'http://api', secret: 's', fetchImpl, pickPostLocal: () => { throw new Error('não devia chamar o fallback'); } });
  assert.equal(origem, 'api');
  assert.deepEqual(posts.map((p) => p.id), ['p1', 'p2']);
});

test('resolverPosts usa a API e repassa lista vazia (nada pra agora)', async () => {
  const fetchImpl = async () => respostaJson(200, { post: null, posts: [] });
  const { origem, posts } = await resolverPosts({ apiBase: 'http://api', secret: 's', fetchImpl, pickPostLocal: () => { throw new Error('não devia chamar o fallback'); } });
  assert.equal(origem, 'api');
  assert.deepEqual(posts, []);
});

test('resolverPosts NÃO aceita resposta sem `posts` (dashboard antigo): nem modo antigo nem fallback', async () => {
  const fetchImpl = async () => respostaJson(200, { post: { id: 'velho', status: 'proposto' } });
  await assert.rejects(
    () => resolverPosts({ apiBase: 'http://api', secret: 's', fetchImpl, pickPostLocal: () => { throw new Error('não devia cair aqui'); } }),
    (err) => { assert.equal(err.contrato, true); assert.match(err.message, /sem a lista/); return true; }
  );
});

test('resolverPosts cai no fallback local em erro de rede', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  const logs = [];
  const { origem, posts } = await resolverPosts({ apiBase: 'http://api', secret: 's', fetchImpl, log: (m) => logs.push(m), pickPostLocal: () => 'posts/semana1/post-x.json' });
  assert.equal(origem, 'local');
  assert.deepEqual(posts, ['posts/semana1/post-x.json']);
  assert.match(logs[0], /indisponível/);
});

test('resolverPosts cai no fallback local em 5xx do dashboard', async () => {
  const fetchImpl = async () => respostaJson(503, { error: 'fora do ar' });
  const { origem, posts } = await resolverPosts({ apiBase: 'http://api', secret: 's', fetchImpl, log: () => {}, pickPostLocal: () => null });
  assert.equal(origem, 'local');
  assert.deepEqual(posts, []);
});

test('resolverPosts NÃO cai no fallback em 4xx (erro de config, não de disponibilidade)', async () => {
  const fetchImpl = async () => respostaJson(401, { error: 'secret errado' });
  await assert.rejects(
    () => resolverPosts({ apiBase: 'http://api', secret: 'errado', fetchImpl, pickPostLocal: () => { throw new Error('não devia cair aqui'); } }),
    /401/
  );
});

test('resolverPosts usa o fallback local direto quando as envs não existem', async () => {
  const { origem, posts } = await resolverPosts({ apiBase: undefined, secret: undefined, pickPostLocal: () => 'posts/semana1/post-x.json' });
  assert.equal(origem, 'local');
  assert.deepEqual(posts, ['posts/semana1/post-x.json']);
});

// ---------- buscarPostsHoje ----------

test('buscarPostsHoje pede ?lista=1 com o Bearer e devolve `posts`', async () => {
  const posts = [{ id: 'abc', caption: 'x', imagens: ['https://s/1.jpg'], video: null, schedule_at: '2026-11-11T11:00:00+00:00', status: 'aprovado' }];
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'http://api/api/conteudo/hoje?rede=instagram&conta=elektro&lista=1');
    assert.equal(opts.headers.authorization, 'Bearer segredo');
    return respostaJson(200, { post: posts[0], posts });
  };
  assert.deepEqual(await buscarPostsHoje({ apiBase: 'http://api', secret: 'segredo', fetchImpl }), posts);
});

test('buscarPostsHoje marca err.status em resposta de erro HTTP', async () => {
  const fetchImpl = async () => respostaJson(500, { error: 'boom' });
  await assert.rejects(
    () => buscarPostsHoje({ apiBase: 'http://api', secret: 's', fetchImpl }),
    (err) => { assert.equal(err.status, 500); return true; }
  );
});

// ---------- filtrarProntos (defesa em profundidade sobre a lista) ----------

test('filtrarProntos: só aprovado e só com schedule_at já vencido', () => {
  const agora = Date.parse('2026-11-11T22:17:00Z'); // 19:17 BRT
  const r = filtrarProntos([
    { id: 'ok', status: 'aprovado', schedule_at: '2026-11-11T22:00:00+00:00' },
    { id: 'auto', status: 'proposto', schedule_at: '2026-11-11T12:00:00+00:00' },
    { id: 'futuro', status: 'aprovado', schedule_at: '2026-11-11T22:30:00+00:00' },
    { id: 'sem-data', status: 'aprovado', schedule_at: null },
  ], agora, () => {});
  assert.deepEqual(r.map((p) => p.id), ['ok']);
});

// ---------- relógio, janela, fila local ----------

test('relogioBR: 01:17 UTC do dia 12 ainda é 22:17 do dia 11 em Brasília', () => {
  assert.deepEqual(relogioBR(new Date('2026-11-12T01:17:00Z')), { hojeBR: '2026-11-11', brtHour: 22, agoraBR: '22:17' });
  assert.deepEqual(relogioBR(new Date('2026-11-11T11:17:00Z')), { hojeBR: '2026-11-11', brtHour: 8, agoraBR: '08:17' });
});

test('horaSimulada e guarda de janela (8h a 23h BRT)', () => {
  assert.equal(horaSimulada('8'), '08:00');
  assert.equal(horaSimulada('19:30'), '19:30');
  assert.throws(() => horaSimulada('25'), /IG_FAKE_HOUR/);
  for (let h = 0; h <= 23; h++) assert.equal(dentroDaJanela(h), h >= 8 && h <= 23, `hora ${h}`);
});

test('pickPostLocal (fallback): o post das 19h não sai antes das 19h', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-'));
  mkdirSync(join(dir, 's1'));
  const f = join(dir, 's1', 'post-a.json');
  writeFileSync(f, JSON.stringify({ scheduleAt: '2026-10-29T19:00' }));
  assert.equal(pickPostLocal({ todayBR: '2026-10-29', agoraBR: '08:17', postsDir: dir }), null);
  assert.equal(pickPostLocal({ todayBR: '2026-10-29', agoraBR: '18:59', postsDir: dir }), null);
  assert.equal(pickPostLocal({ todayBR: '2026-10-29', agoraBR: '19:17', postsDir: dir }), f);
  assert.equal(pickPostLocal({ todayBR: '2026-10-30', agoraBR: '19:17', postsDir: dir }), null);
  assert.equal(pickPostLocal({ todayBR: '2026-10-29', postsDir: dir }), f); // sem hora: só pelo dia
});

test('publish.yml: crons de hora em hora das 8h às 22h BRT, minuto quebrado, matriz e concurrency por conta', () => {
  const yml = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const horas = [...yml.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1].split(/\s+/)).map(([min, hora, ...resto]) => {
    assert.equal(resto.join(' '), '* * *');
    assert.notEqual(Number(min), 0);
    return (Number(hora) + 21) % 24;
  }).sort((a, b) => a - b);
  assert.deepEqual(horas, Array.from({ length: 15 }, (_, i) => i + 8));
  assert.match(yml, /group: publish-ig-\$\{\{ matrix\.conta \}\}\s*\n\s*cancel-in-progress: false/);
});

// ---------- publicarLista: vários runs de hora em hora sem duplicar ----------

// Dashboard falso (só `aprovado` com schedule_at vencido; /publicado troca o status) e conta do
// Instagram falsa (feed em memória). Simula o que acontece entre runs seguidos.
function cenario({ reporteFalha = () => false } = {}) {
  const feed = [];
  const banco = [];
  const graph = async (path, opts = {}) => {
    assert.equal(path, 'u/media');
    return { data: feed.slice(0, Number(opts.params.limit)) };
  };
  let n = 0;
  const publicar = async (post) => { const id = `m${++n}`; feed.unshift({ id, caption: post.caption }); return id; };
  const reportes = [];
  const reportar = async (post, campos) => {
    reportes.push({ id: post.id, ...campos });
    if (reporteFalha(post)) return; // o publicador engole o erro do reporte; o banco não muda
    const linha = banco.find((p) => p.id === post.id);
    linha.status = campos.erro ? 'falhou' : 'publicado';
  };
  // o que a rota ?lista=1 devolve, passado pelo mesmo paraPublicar do script
  const listaAgora = (agoraMs) => paraPublicar(banco
    .filter((p) => p.status === 'aprovado' && Date.parse(p.schedule_at) <= agoraMs)
    .sort((a, b) => Date.parse(a.schedule_at) - Date.parse(b.schedule_at))
    .map((p) => ({ id: p.id, caption: p.caption, imagens: p.imagens, video: p.video, schedule_at: p.schedule_at, status: p.status })), agoraMs, () => {});
  return { feed, banco, graph, publicar, reportar, reportes, listaAgora };
}
const utcDeBRT = (h, m = 0) => Date.UTC(2026, 10, 11, h + 3, m);

test('runs de hora em hora (08:17 a 22:17): 15 aprovados saem uma vez cada, no run do seu horário; proposto não sai', async () => {
  const c = cenario();
  for (let h = 8; h <= 22; h++) c.banco.push({ id: `p${h}`, status: 'aprovado', caption: `legenda ${h}`, imagens: ['https://s/1.jpg'], video: null, schedule_at: new Date(utcDeBRT(h)).toISOString() });
  c.banco.push({ id: 'auto', status: 'proposto', faixa: 'auto', caption: 'auto', imagens: ['https://s/1.jpg'], schedule_at: new Date(utcDeBRT(9)).toISOString() });
  for (let h = 8; h <= 22; h++) {
    const agora = utcDeBRT(h, 17);
    const posts = c.listaAgora(agora);
    const { publicados } = await publicarLista({ posts, graph: c.graph, igUserId: 'u', publicar: c.publicar, reportar: c.reportar, sleepFn: async () => {}, log: () => {} });
    assert.deepEqual(publicados.map((p) => p.nome), [`p${h}`], `run das ${h}:17`);
  }
  assert.equal(c.feed.length, 15);
  assert.equal(new Set(c.feed.map((m) => m.caption)).size, 15);
  assert.equal(c.banco.find((p) => p.id === 'auto').status, 'proposto');
});

test('cron que falhou: o run seguinte publica o atrasado e o da hora, com espera entre eles', async () => {
  const c = cenario();
  for (const h of [8, 9]) c.banco.push({ id: `p${h}`, status: 'aprovado', caption: `legenda ${h}`, imagens: ['https://s/1.jpg'], schedule_at: new Date(utcDeBRT(h)).toISOString() });
  const esperas = [];
  const agora = utcDeBRT(9, 17);
  const { publicados } = await publicarLista({ posts: c.listaAgora(agora), graph: c.graph, igUserId: 'u', publicar: c.publicar, reportar: c.reportar, sleepFn: async (ms) => esperas.push(ms), log: () => {} });
  assert.deepEqual(publicados.map((p) => p.nome), ['p8', 'p9']);
  assert.deepEqual(esperas, [60000]);
});

test('reporte ao dashboard falhou: o post volta na lista, mas a checagem de legenda não republica e reporta o id existente', async () => {
  let falhar = true;
  const c = cenario({ reporteFalha: () => falhar });
  c.banco.push({ id: 'p8', status: 'aprovado', caption: 'legenda 8', imagens: ['https://s/1.jpg'], schedule_at: new Date(utcDeBRT(8)).toISOString() });
  const opts = { graph: c.graph, igUserId: 'u', publicar: c.publicar, reportar: c.reportar, sleepFn: async () => {}, log: () => {} };
  await publicarLista({ ...opts, posts: c.listaAgora(utcDeBRT(8, 17)) });
  assert.equal(c.banco[0].status, 'aprovado'); // o reporte se perdeu
  falhar = false;
  const r2 = await publicarLista({ ...opts, posts: c.listaAgora(utcDeBRT(9, 17)) });
  assert.deepEqual(r2.publicados, []);
  assert.deepEqual(r2.pulados, ['p8']);
  assert.equal(c.feed.length, 1);
  assert.equal(c.banco[0].status, 'publicado');
  assert.deepEqual(c.reportes.at(-1), { id: 'p8', ig_media_id: 'm1' });
});

test('checagem do feed falhando para o run sem publicar nem reportar', async () => {
  const c = cenario();
  c.banco.push({ id: 'p8', status: 'aprovado', caption: 'x', imagens: ['https://s/1.jpg'], schedule_at: new Date(utcDeBRT(8)).toISOString() });
  let publicou = 0;
  await assert.rejects(
    publicarLista({ posts: c.listaAgora(utcDeBRT(8, 17)), graph: async () => { throw new Error('Graph 500 em u/media: {}'); }, igUserId: 'u', publicar: async () => { publicou++; return 'x'; }, reportar: c.reportar, log: () => {}, logErro: () => {} }),
    (e) => e.checagem === true,
  );
  assert.equal(publicou, 0);
  assert.deepEqual(c.reportes, []);
});

test('publicação falhando: reporta erro desse post e para o run; os seguintes saem no run da hora seguinte', async () => {
  const c = cenario();
  for (const h of [8, 9, 10]) c.banco.push({ id: `p${h}`, status: 'aprovado', caption: `legenda ${h}`, imagens: h === 8 ? [] : ['https://s/1.jpg'], video: null, schedule_at: new Date(utcDeBRT(h)).toISOString() });
  const opts = { graph: c.graph, igUserId: 'u', publicar: c.publicar, reportar: c.reportar, sleepFn: async () => {}, log: () => {}, logErro: () => {} };
  await assert.rejects(publicarLista({ ...opts, posts: c.listaAgora(utcDeBRT(10, 17)) }), (e) => e.publicacao === true);
  assert.equal(c.banco.find((p) => p.id === 'p8').status, 'falhou');
  assert.match(c.reportes[0].erro, /sem imagens nem vídeo/);
  assert.equal(c.feed.length, 0);
  const r2 = await publicarLista({ ...opts, posts: c.listaAgora(utcDeBRT(11, 17)) });
  assert.deepEqual(r2.publicados.map((p) => p.nome), ['p9', 'p10']);
});

test('--dry: não publica, não reporta, e checagem falhando não para', async () => {
  const c = cenario();
  c.banco.push({ id: 'p8', status: 'aprovado', caption: 'x', imagens: ['https://s/1.jpg'], schedule_at: new Date(utcDeBRT(8)).toISOString() });
  const vistos = [];
  const r = await publicarLista({ posts: c.listaAgora(utcDeBRT(8, 17)), dry: true, graph: async () => { throw new Error('ENOTFOUND'); }, igUserId: 'u', publicar: async (p) => { vistos.push(p.id); return null; }, reportar: c.reportar, log: () => {} });
  assert.deepEqual(vistos, ['p8']);
  assert.deepEqual(r.publicados, []);
  assert.deepEqual(c.reportes, []);
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

// ---------- paramsDoReel ----------

test('paramsDoReel com capa inclui cover_url e não tem thumb_offset', () => {
  const params = paramsDoReel({
    videoUrl: 'https://cdn.example/reel.mp4',
    coverUrl: 'https://cdn.example/capa.jpg',
    caption: 'legenda intacta do reel',
  });
  assert.equal(params.media_type, 'REELS');
  assert.equal(params.video_url, 'https://cdn.example/reel.mp4');
  assert.equal(params.cover_url, 'https://cdn.example/capa.jpg');
  assert.equal(params.share_to_feed, 'true');
  assert.equal(params.caption, 'legenda intacta do reel');
  assert.equal('thumb_offset' in params, false);
});

test('paramsDoReel sem capa inclui thumb_offset e não tem cover_url', () => {
  const params = paramsDoReel({
    videoUrl: 'https://cdn.example/reel.mp4',
    coverUrl: null,
    caption: 'legenda intacta do reel',
  });
  assert.equal(params.media_type, 'REELS');
  assert.equal(params.video_url, 'https://cdn.example/reel.mp4');
  assert.equal(params.thumb_offset, '0');
  assert.equal(params.share_to_feed, 'true');
  assert.equal(params.caption, 'legenda intacta do reel');
  assert.equal('cover_url' in params, false);
});

test('credenciaisIg: elektro usa os nomes sem sufixo; kaffra usa sufixo; faltando, null', () => {
  const env = { IG_ACCESS_TOKEN: 'a', IG_USER_ID: '1', IG_ACCESS_TOKEN_KAFFRA: 'b', IG_USER_ID_KAFFRA: '2' };
  assert.deepEqual(credenciaisIg(env, 'elektro'), { accessToken: 'a', userId: '1' });
  assert.deepEqual(credenciaisIg(env, 'kaffra'), { accessToken: 'b', userId: '2' });
  assert.equal(credenciaisIg({ IG_ACCESS_TOKEN: 'a', IG_USER_ID: '1' }, 'kaffra'), null);
  assert.equal(credenciaisIg({ IG_ACCESS_TOKEN_KAFFRA: 'b' }, 'kaffra'), null);
});

test('buscarPostsHoje pede a conta certa', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return respostaJson(200, { post: null, posts: [] }); };
  await buscarPostsHoje({ apiBase: 'http://api', secret: 's', conta: 'kaffra', fetchImpl });
  assert.match(urls[0], /\/api\/conteudo\/hoje\?rede=instagram&conta=kaffra&lista=1$/);
  await buscarPostsHoje({ apiBase: 'http://api', secret: 's', fetchImpl });
  assert.match(urls[1], /conta=elektro&lista=1$/);
});
