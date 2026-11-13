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

/** Segredos do Instagram por conta: elektro = nomes históricos; outras = sufixo _CONTA. */
export function credenciaisIg(env, conta = 'elektro') {
  const suf = conta === 'elektro' ? '' : `_${conta.toUpperCase()}`;
  const accessToken = env[`IG_ACCESS_TOKEN${suf}`];
  const userId = env[`IG_USER_ID${suf}`];
  if (!accessToken || !userId) return null;
  return { accessToken, userId };
}

// ---------- fila do dashboard (GET /api/conteudo/hoje?lista=1) ----------

// Lista de posts que podem sair agora (dashboard: só `aprovado`, do dia BRT, schedule_at já
// vencido). Erro de rede ou 5xx -> quem chama decide o fallback (o erro carrega `.status` quando
// veio do HTTP, undefined quando foi falha de rede). Resposta 200 sem `posts` (dashboard antigo,
// que só devolve `post` e ainda deixa passar a faixa auto e post de qualquer hora) é erro de
// contrato (`.contrato = true`): nunca cai no modo antigo nem no fallback.
export async function buscarPostsHoje({ apiBase, secret, conta = 'elektro', fetchImpl = fetch }) {
  const res = await fetchImpl(`${apiBase}/api/conteudo/hoje?rede=instagram&conta=${conta}&lista=1`, {
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
  if (!Array.isArray(body?.posts)) {
    const err = new Error('API conteudo respondeu sem a lista `posts` (dashboard sem ?lista=1?). Não publico.');
    err.contrato = true;
    throw err;
  }
  return body.posts;
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

// Decide a fonte da fila. Caminho manual (arg) ou API não configurada: pasta local
// (`pickPostLocal` devolve a lista de caminhos). API configurada: só a API. Se ela estiver fora
// do ar (rede/5xx), NÃO cai na pasta local: a pasta não passa pela aprovação do dono no
// dashboard e uma legenda editada lá escaparia da checagem de duplicata; o run sai com erro e o
// da hora seguinte tenta de novo. 4xx e resposta fora do contrato também estouram.
export async function resolverPosts({ apiBase, secret, conta = 'elektro', arg = null, fetchImpl = fetch, pickPostLocal, log = console.log }) {
  if (arg || !apiBase || !secret) {
    if (!arg) log('Sem CONTEUDO_API_BASE/CONTEUDO_SECRET: uso a fila local (posts/).');
    return { origem: 'local', posts: pickPostLocal() };
  }
  try {
    return { origem: 'api', posts: await buscarPostsHoje({ apiBase, secret, conta, fetchImpl }) };
  } catch (err) {
    if (!err.contrato && !(err.status && err.status < 500)) err.indisponivel = true;
    throw err;
  }
}

// Defesa em profundidade sobre a lista da API: só `aprovado` e só com schedule_at já vencido
// (comparado como instante). O dashboard já filtra; se um dia mudar, o publicador não segue.
export function filtrarProntos(posts, agoraMs, log = console.log) {
  return posts.filter((p) => {
    if (p.status !== 'aprovado') { log(`aviso: ${p.id} veio com status ${p.status}, não aprovado pelo dono. Pulo.`); return false; }
    // Sem fuso explícito, Date.parse leria a hora no fuso do runner (UTC): 3 h adiantado.
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(p.schedule_at || '')) { log(`aviso: ${p.id} com schedule_at sem fuso (${p.schedule_at}). Pulo.`); return false; }
    const quando = Date.parse(p.schedule_at);
    if (Number.isNaN(quando) || quando > agoraMs) { log(`aviso: ${p.id} agendado para ${p.schedule_at}, ainda não chegou. Pulo.`); return false; }
    return true;
  });
}

// Lista da API -> posts no formato do laço de publicação (já filtrados por filtrarProntos).
export function paraPublicar(postsDaApi, agoraMs, log = console.log) {
  return filtrarProntos(postsDaApi, agoraMs, log)
    .sort((a, b) => Date.parse(a.schedule_at) - Date.parse(b.schedule_at))
    .map((p) => ({ id: p.id, caption: p.caption, images: p.imagens, video: p.video, schedule_at: p.schedule_at }));
}

// ---------- relógio e janela ----------

// Relógio de Brasília: dia (YYYY-MM-DD), hora (0-23) e "HH:MM" de um instante.
export function relogioBR(now = new Date()) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  const hora = partes.hour === '24' ? '00' : partes.hour;
  return { hojeBR: `${partes.year}-${partes.month}-${partes.day}`, brtHour: Number(hora), agoraBR: `${hora}:${partes.minute}` };
}

// IG_FAKE_HOUR (só no dry): "19" vira 19:00, "19:30" vira 19:30. Devolve "HH:MM" ou lança.
export function horaSimulada(valor) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(valor).trim());
  const h = m ? Number(m[1]) : NaN;
  const min = m && m[2] != null ? Number(m[2]) : 0;
  if (!m || h > 23 || min > 59) throw new Error('IG_FAKE_HOUR exige a hora 0-23 ou HH:MM');
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Guarda de janela do cron: só publica de 8h a 23h BRT. Fora disso é cron atrasado (ou
// madrugada) e não publica, pra não pegar o dia errado.
export const JANELA_BRT = { de: 8, ate: 23 };
export function dentroDaJanela(brtHour) {
  return brtHour >= JANELA_BRT.de && brtHour <= JANELA_BRT.ate;
}

// ---------- laço de publicação ----------

// Idempotência: procura nas últimas `limite` mídias do feed uma com a MESMA legenda.
// Devolve o id da mídia ou null. Erro do Graph propaga (quem chama decide).
export async function idNoFeed({ graph, igUserId, caption, limite = 25 }) {
  const recent = await graph(`${igUserId}/media`, { params: { fields: 'id,caption', limit: String(limite) } });
  const alvo = (caption || '').trim();
  const igual = (recent.data || []).find((m) => (m.caption || '').trim() === alvo);
  return igual ? igual.id : null;
}

// Publica a lista em ordem. Antes de cada post, checa a legenda no feed: se já está, reporta
// `publicado` com o media id existente e pula (é o que impede duplicata quando o reporte do run
// anterior falhou). Se a checagem falhar fora do --dry, para o run inteiro (lança, `.checagem`)
// sem publicar este nem os seguintes. Se a publicação de um post falhar, reporta `erro` (o post
// vira `falhou` e sai da lista) e para o run (lança, `.publicacao`): os seguintes ficam
// `aprovado` para o run da hora seguinte, e uma falha geral (token, limite da Meta) não derruba
// o dia inteiro de uma vez. Espera `esperaMs` entre duas publicações do mesmo run.
// `publicar(post)` monta e publica (no --dry só loga e devolve null); `reportar(post, campos)`
// avisa o dashboard (no-op na fila local) e nunca lança.
export async function publicarLista({ posts, graph, igUserId, dry = false, publicar, reportar, sleepFn = sleep, esperaMs = 60000, log = console.log, logErro = console.error }) {
  const publicados = [];
  const pulados = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const nome = post.file || post.id;

    let mediaIdExistente = null;
    try {
      mediaIdExistente = await idNoFeed({ graph, igUserId, caption: post.caption });
    } catch (e) {
      log('aviso: não deu pra checar duplicado:', formatarErro(e));
      if (!dry) {
        logErro('Checagem de duplicado falhou: não publico este post nem os seguintes do run, pra não arriscar duplicata.');
        const err = new Error('checagem de duplicado falhou');
        err.checagem = true;
        throw err;
      }
    }

    if (mediaIdExistente) {
      logErro(`Já está no feed uma mídia com a mesma legenda (${mediaIdExistente}): ${nome}. Pulo pra não duplicar e reporto como publicado. Se for outro post com legenda repetida, ele não sai.`);
      if (!dry) await reportar(post, { ig_media_id: mediaIdExistente });
      pulados.push(nome);
      continue;
    }

    let id;
    try {
      if (!post.images?.length && !post.video) throw new Error('Post sem imagens nem vídeo: ' + nome);
      id = await publicar(post);
    } catch (e) {
      logErro(`Falha ao publicar ${nome}:`, formatarErro(e));
      await reportar(post, { erro: String(e?.message || e).slice(0, 500) });
      const err = new Error(`falha ao publicar ${nome}`);
      err.publicacao = true;
      err.publicados = publicados;
      throw err;
    }
    if (dry) continue;
    log('PUBLICADO. media id:', id);
    await reportar(post, { ig_media_id: id });
    publicados.push({ nome, id });

    // Entre duas publicações do mesmo run, esperar (rate limit / não sobrecarregar o Graph).
    if (i < posts.length - 1) await sleepFn(esperaMs);
  }
  return { publicados, pulados };
}

// ---------- fila local (fallback / histórico) ----------

// Varre posts/*/post-*.json e devolve TODOS os de hoje (BR) cujo horário ("HH:MM", em BRT) já
// chegou, em ordem de horário: com o cron de hora em hora, o post das 19h não sai às 8h. Sem
// agoraBR, só pelo dia. arg explícito (caminho do post) tem prioridade e volta sozinho na lista,
// igual ao comportamento manual de sempre.
export function pickPostLocal({ todayBR, agoraBR, arg, postsDir = 'posts', readdirSyncFn = readdirSync, readFileSyncFn = readFileSync, joinFn = join }) {
  if (arg) return [arg];
  const doDia = [];
  for (const week of readdirSyncFn(postsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const dir = joinFn(postsDir, week.name);
    for (const f of readdirSyncFn(dir).filter((f) => /^post-.*\.json$/.test(f))) {
      const schedule = JSON.parse(readFileSyncFn(joinFn(dir, f), 'utf8')).scheduleAt || '';
      if (schedule.slice(0, 10) !== todayBR) continue;
      const temHora = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(schedule);
      if (agoraBR != null && !(temHora && schedule.slice(11, 16) <= agoraBR)) continue;
      doDia.push({ caminho: joinFn(dir, f), horaMin: temHora ? schedule.slice(11, 16) : '' });
    }
  }
  doDia.sort((a, b) => (a.horaMin < b.horaMin ? -1 : a.horaMin > b.horaMin ? 1 : (a.caminho < b.caminho ? -1 : 1)));
  return doDia.map((x) => x.caminho);
}

// Parâmetros do container de reel. Com capa, manda cover_url (imagens[0] do post).
// Sem capa, fixa o primeiro quadro via thumb_offset em vez de deixar o Instagram escolher.
export function paramsDoReel({ videoUrl, coverUrl, caption }) {
  const params = { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' };
  if (coverUrl) params.cover_url = coverUrl;
  else params.thumb_offset = '0';
  return params;
}
