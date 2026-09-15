// Publica o post do DIA no Instagram, rodando no GitHub Actions (sem Mac).
// - Fonte da fila: GET /api/conteudo/hoje no dashboard (CONTEUDO_API_BASE + CONTEUDO_SECRET).
//   Se a API estiver fora do ar (erro de rede/5xx) ou as envs não existirem, cai no fallback
//   da pasta local `posts/` (comportamento antigo, agora só histórico/reserva).
// - Depois de tentar publicar, reporta pra API: POST .../posts/<id>/publicado com
//   `ig_media_id` (sucesso) ou `erro` (falha). Só quando o post veio da API.
// - Token e IG_USER_ID vêm de Secrets (process.env). Endpoint: graph.instagram.com.
// Uso: node ig/publish-ci.mjs [caminho-do-post.json] [--dry]
//   sem arg = escolhe pelo dia · --dry = resolve e loga, mas não publica nem cria container.
import { readFileSync } from 'node:fs';
import { criarGraph, formatarErro, paramsDoReel, pickPostLocal, pollContainer, reportarPublicado, resolverPost } from './lib.mjs';

const DRY = process.argv.includes('--dry');
const argPost = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

const {
  IG_ACCESS_TOKEN,
  IG_USER_ID,
  GITHUB_REPOSITORY,
  GITHUB_REF_NAME,
  CONTEUDO_API_BASE,
  CONTEUDO_SECRET,
  IG_POLL_TIMEOUT_MS,
} = process.env;
const BRANCH = GITHUB_REF_NAME || 'main';
if (!IG_ACCESS_TOKEN || !IG_USER_ID) { console.error('Faltam Secrets IG_ACCESS_TOKEN / IG_USER_ID'); process.exit(1); }

const manual = !!argPost || DRY; // disparo manual ou --dry ignora as guardas de horário

// "hoje" e "hora" em America/Sao_Paulo
const now = new Date();
const todayBR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const brtHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(now));

// Guarda de janela: cron do GitHub atrasa (às vezes horas). Se cair fora da noite,
// é atraso: não publico, pra não sair de madrugada nem pegar o dia errado.
if (!manual && (brtHour < 18 || brtHour > 23)) {
  console.log(`Agora são ${brtHour}h BRT, fora da janela 18-23h (cron atrasou). Não publico. Nada a fazer.`);
  process.exit(0);
}

const IG_POLL_TIMEOUT = Number(IG_POLL_TIMEOUT_MS) || 10 * 60 * 1000;

const { origem, post: fonte } = await resolverPost({
  apiBase: CONTEUDO_API_BASE,
  secret: CONTEUDO_SECRET,
  pickPostLocal: () => pickPostLocal({ todayBR, arg: argPost }),
});

// normaliza os dois formatos (API x arquivo local) num único shape
let post;
if (origem === 'api') {
  if (!fonte) { console.log('API: nada pra hoje.'); process.exit(0); }
  post = { id: fonte.id, caption: fonte.caption, images: fonte.imagens, video: fonte.video };
} else {
  if (!fonte) { console.log(`Nenhum post agendado pra hoje (${todayBR}). Nada a fazer.`); process.exit(0); }
  if (!GITHUB_REPOSITORY) { console.error('Sem GITHUB_REPOSITORY (rode no Actions)'); process.exit(1); }
  const local = JSON.parse(readFileSync(fonte, 'utf8'));
  post = { file: fonte, caption: local.caption, images: local.images, video: local.video };
}
const { caption, images, video } = post;
if (!images?.length && !video) throw new Error('Post sem imagens nem vídeo: ' + (post.file || post.id));

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

let urls, videoUrl;
if (origem === 'api') {
  urls = images || [];
  videoUrl = video || null;
} else {
  urls = [];
  for (const p of images || []) urls.push(await pickUrl(p));
  videoUrl = video ? cdnUrl(video) : null;
}
console.log(`Post: ${post.file || post.id} (${todayBR}, fonte: ${origem}) | ${videoUrl ? 'REEL: ' + videoUrl : urls.length + ' imagens'}`);
(videoUrl ? [videoUrl] : urls).forEach((u) => console.log('  ', u));
if (videoUrl) {
  if (urls[0]) console.log(`capa do reel: ${urls[0]}`);
  else console.log('capa do reel: sem imagem, usando o primeiro quadro (thumb_offset=0)');
}

const graph = criarGraph({ accessToken: IG_ACCESS_TOKEN });

async function reportarSeApi(campos) {
  if (origem !== 'api') return;
  try { await reportarPublicado({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, ...campos }); }
  catch (e) { console.error('aviso: falha ao reportar pra API do dashboard:', formatarErro(e)); }
}

// Idempotência: se um post com esta MESMA legenda já está no feed, não republica.
// Fonte da verdade = a própria conta. Mata duplicata mesmo se o cron rodar 2×.
let mediaIdExistente = null;
try {
  const recent = await graph(`${IG_USER_ID}/media`, { params: { fields: 'id,caption', limit: '25' } });
  const igual = (recent.data || []).find((m) => (m.caption || '').trim() === (caption || '').trim());
  if (igual) mediaIdExistente = igual.id;
} catch (e) { console.log('aviso: não deu pra checar duplicado, sigo:', formatarErro(e)); }

if (mediaIdExistente) {
  console.log('Este post já está no feed (mesma legenda). Pulo pra não duplicar.');
  await reportarSeApi({ ig_media_id: mediaIdExistente });
  process.exit(0);
}

if (DRY) { console.log('--dry: resolvido, não publica.'); process.exit(0); }

try {
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
  console.log('PUBLICADO. media id:', pub.id);
  await reportarSeApi({ ig_media_id: pub.id });
} catch (err) {
  console.error('Falha ao publicar:', formatarErro(err));
  await reportarSeApi({ erro: String(err.message || err).slice(0, 500) });
  process.exit(1);
}
