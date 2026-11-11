// Publica os posts do DIA no Instagram, rodando no GitHub Actions (sem Mac), de hora em hora
// das 8h às 22h BRT.
// - Fonte da fila: GET /api/conteudo/hoje?lista=1 no dashboard (CONTEUDO_API_BASE + CONTEUDO_SECRET):
//   TODOS os posts `aprovado` do dia cujo schedule_at já chegou. Publica a lista inteira, em ordem.
//   Se a API estiver fora do ar (erro de rede/5xx), sai com erro sem publicar (o run da hora
//   seguinte tenta de novo). Pasta local `posts/` só sem as envs da API ou no disparo manual
//   com o caminho do post (histórico/reserva).
// - Depois de tentar publicar cada post, reporta pra API: POST .../posts/<id>/publicado com
//   `ig_media_id` (sucesso) ou `erro` (falha). Só quando o post veio da API. O dashboard troca o
//   status e o post sai da lista: é isso que impede o run seguinte de publicar de novo (e a
//   checagem de legenda no feed cobre o reporte que falhou).
// - Token e IG_USER_ID vêm de Secrets (process.env). Endpoint: graph.instagram.com.
// Uso: node ig/publish-ci.mjs [caminho-do-post.json] [--dry] [--date YYYY-MM-DD]
//   sem arg = a lista do dia · --dry = resolve e loga, mas não publica, não cria container e não reporta.
//   --date e IG_FAKE_HOUR ("19" ou "19:30") só valem com --dry e só mudam a fila local e a
//   guarda de janela (a lista da API é sempre a de agora no dashboard).
import { readFileSync } from 'node:fs';
import {
  JANELA_BRT, credenciaisIg, criarGraph, dentroDaJanela, formatarErro, horaSimulada,
  paramsDoReel, paraPublicar, pickPostLocal, pollContainer, publicarLista, relogioBR, reportarPublicado, resolverPosts,
} from './lib.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
let dateArg = null;
const posicionais = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--date') { const v = argv[i + 1]; dateArg = v && !v.startsWith('--') ? argv[++i] : ''; continue; }
  if (a.startsWith('--')) continue;
  posicionais.push(a);
}
const argPost = posicionais[0] || null;

const {
  GITHUB_REPOSITORY,
  GITHUB_REF_NAME,
  CONTEUDO_API_BASE,
  CONTEUDO_SECRET,
  IG_POLL_TIMEOUT_MS,
  IG_FAKE_HOUR,
} = process.env;
const BRANCH = GITHUB_REF_NAME || 'main';
const CONTA = process.env.IG_CONTA || 'elektro';
const cred = credenciaisIg(process.env, CONTA);
// Conta de origem (elektro) sem segredo é erro, como sempre foi; conta nova sem segredo só pula.
if (!cred) {
  if (CONTA === 'elektro') { console.error('Faltam Secrets IG_ACCESS_TOKEN / IG_USER_ID'); process.exit(1); }
  console.log(`Conta ${CONTA} sem segredo do Instagram configurado. Pulo.`); process.exit(0);
}
if (argPost && CONTA !== 'elektro') { console.log(`Post local (${argPost}) só vale para a conta elektro. Pulo a perna ${CONTA}.`); process.exit(0); }
const IG_USER_ID = cred.userId;

const manual = !!argPost || DRY; // disparo manual ou --dry ignora as guardas de horário

// "hoje" e "hora" em America/Sao_Paulo (--date e IG_FAKE_HOUR simulam, só no dry)
const now = new Date();
let { hojeBR: todayBR, brtHour, agoraBR } = relogioBR(now);
if (dateArg != null) {
  if (!DRY) { console.error('--date só vale com --dry'); process.exit(1); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) { console.error('--date exige YYYY-MM-DD'); process.exit(1); }
  todayBR = dateArg;
}
if (IG_FAKE_HOUR != null && IG_FAKE_HOUR !== '') {
  if (!DRY) { console.error('IG_FAKE_HOUR só vale com --dry'); process.exit(1); }
  try { agoraBR = horaSimulada(IG_FAKE_HOUR); } catch (err) { console.error(err.message); process.exit(1); }
  brtHour = Number(agoraBR.slice(0, 2));
}

// Guarda de janela: cron do GitHub atrasa (às vezes horas). Fora de 8-23h BRT é atraso (ou
// madrugada): não publico, pra não sair de madrugada nem pegar o dia errado.
const janela = `${JANELA_BRT.de}-${JANELA_BRT.ate}h`;
if (!manual && !dentroDaJanela(brtHour)) {
  console.log(`Agora são ${agoraBR} BRT, fora da janela ${janela} (cron atrasou). Não publico. Nada a fazer.`);
  process.exit(0);
}
if (DRY && !argPost && !dentroDaJanela(brtHour)) console.log(`--dry: ${agoraBR} BRT está fora da janela ${janela}; no cron, este run não publicaria nada.`);

const IG_POLL_TIMEOUT = Number(IG_POLL_TIMEOUT_MS) || 10 * 60 * 1000;

let origem, fontes;
try {
  ({ origem, posts: fontes } = await resolverPosts({
    apiBase: CONTEUDO_API_BASE,
    secret: CONTEUDO_SECRET,
    conta: CONTA,
    arg: argPost,
    // fila local (pasta posts/) só existe para a conta elektro
    pickPostLocal: () => (CONTA === 'elektro' ? pickPostLocal({ todayBR, agoraBR, arg: argPost }) : []),
  }));
} catch (err) {
  console.error(err.indisponivel
    ? `API do dashboard indisponível (${formatarErro(err)}). Não publico nada; o run da hora seguinte tenta de novo.`
    : `Falha ao ler a fila do dashboard: ${formatarErro(err)}`);
  process.exit(1);
}

// normaliza os dois formatos (API x arquivo local) num único shape
let posts;
if (origem === 'api') {
  posts = paraPublicar(fontes, now.getTime());
  if (!posts.length) { console.log(`API: nada aprovado pra publicar agora (${CONTA}).`); process.exit(0); }
} else {
  if (!fontes.length) { console.log(`Nenhum post agendado pra hoje (${todayBR}) até ${agoraBR} BRT. Nada a fazer.`); process.exit(0); }
  if (!GITHUB_REPOSITORY && !DRY) { console.error('Sem GITHUB_REPOSITORY (rode no Actions)'); process.exit(1); }
  posts = fontes.map((f) => { const local = JSON.parse(readFileSync(f, 'utf8')); return { file: f, caption: local.caption, images: local.images, video: local.video }; });
}
console.log(`${CONTA}: ${posts.length} post(s) pra publicar agora (fonte: ${origem}).`);

// Imagens: raw.githubusercontent serve image/jpeg (a API aceita). Vídeo: raw serve
// octet-stream e o IG recusa, então o mp4 vai por jsDelivr, que serve video/mp4.
// Só se aplica à fila local: as URLs que vêm da API já são públicas (Supabase Storage).
const rawUrl = (p) => `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${BRANCH}/${p}`;
const cdnUrl = (p) => `https://cdn.jsdelivr.net/gh/${GITHUB_REPOSITORY}@${BRANCH}/${p}`;
async function pickUrl(p) {
  const raw = rawUrl(p);
  try { const r = await fetch(raw, { method: 'HEAD' }); if (r.ok) return raw; console.log(`  raw ${r.status} -> jsDelivr: ${p}`); }
  catch (e) { console.log(`  raw falhou (${formatarErro(e)}) -> jsDelivr: ${p}`); }
  return cdnUrl(p);
}

const graph = criarGraph({ accessToken: cred.accessToken });

async function reportar(post, campos) {
  if (origem !== 'api' || DRY) return;
  try { await reportarPublicado({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, ...campos }); }
  catch (e) { console.error('aviso: falha ao reportar pra API do dashboard:', formatarErro(e)); }
}

// Resolve as URLs, loga e (fora do --dry) monta o container e publica. Devolve o media id.
async function publicar(post) {
  const { caption, images, video } = post;
  let urls, videoUrl;
  if (origem === 'api' || (DRY && !GITHUB_REPOSITORY)) {
    urls = images || [];
    videoUrl = video || null;
  } else {
    urls = [];
    for (const p of images || []) urls.push(await pickUrl(p));
    videoUrl = video ? cdnUrl(video) : null;
  }
  console.log(`Post: ${post.file || post.id} (${post.schedule_at || todayBR}, fonte: ${origem}) | ${videoUrl ? 'REEL: ' + videoUrl : urls.length + ' imagens'}`);
  (videoUrl ? [videoUrl] : urls).forEach((u) => console.log('  ', u));
  if (videoUrl) {
    if (urls[0]) console.log(`capa do reel: ${urls[0]}`);
    else console.log('capa do reel: sem imagem, usando o primeiro quadro (thumb_offset=0)');
  }
  if (DRY) { console.log('--dry: resolvido, não publica.'); return null; }

  // monta o container: REEL (vídeo), imagem única, ou carrossel
  let containerId, maxPolls = 20;
  if (videoUrl) {
    containerId = (await graph(`${IG_USER_ID}/media`, { method: 'POST', params: paramsDoReel({ videoUrl, coverUrl: urls[0], caption }) })).id;
    maxPolls = 40; // vídeo demora mais pra processar
  } else if (urls.length === 1) {
    containerId = (await graph(`${IG_USER_ID}/media`, { method: 'POST', params: { image_url: urls[0], caption } })).id;
  } else {
    const children = [];
    for (const u of urls) children.push((await graph(`${IG_USER_ID}/media`, { method: 'POST', params: { image_url: u, is_carousel_item: 'true' } })).id);
    containerId = (await graph(`${IG_USER_ID}/media`, { method: 'POST', params: { media_type: 'CAROUSEL', caption, children: children.join(',') } })).id;
  }
  console.log('container:', containerId);
  await pollContainer({ graph, containerId, maxPolls, timeoutMs: IG_POLL_TIMEOUT });
  const pub = await graph(`${IG_USER_ID}/media_publish`, { method: 'POST', params: { creation_id: containerId } });
  return pub.id;
}

// Idempotência: publicarLista checa a legenda de cada post no feed antes de publicar (fonte da
// verdade = a própria conta). Checagem falhando ou publicação falhando param o run com erro;
// o que não saiu fica para o run da hora seguinte.
try {
  const { publicados, pulados } = await publicarLista({ posts, graph, igUserId: IG_USER_ID, dry: DRY, publicar, reportar });
  if (!DRY) console.log(`Fim do run (${CONTA}): ${publicados.length} publicado(s), ${pulados.length} já no feed.`);
} catch (err) {
  if (!err.checagem && !err.publicacao) console.error('Falha:', formatarErro(err));
  process.exit(1);
}
