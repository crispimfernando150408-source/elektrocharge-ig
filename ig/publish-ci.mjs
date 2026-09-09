// Publica o post do DIA no Instagram, rodando no GitHub Actions (sem Mac).
// - Descobre "hoje" no fuso America/Sao_Paulo e acha o post cujo scheduleAt casa.
// - As imagens ficam commitadas no repo; usa a URL raw.githubusercontent (pública) — sem uploader.
// - Token e IG_USER_ID vêm de Secrets (process.env). Endpoint: graph.instagram.com.
// Uso: node ig/publish-ci.mjs [caminho-do-post.json]   (sem arg = escolhe pelo dia)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const GRAPH = 'https://graph.instagram.com/v21.0';
const { IG_ACCESS_TOKEN, IG_USER_ID, GITHUB_REPOSITORY } = process.env;
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
if (!IG_ACCESS_TOKEN || !IG_USER_ID) { console.error('Faltam Secrets IG_ACCESS_TOKEN / IG_USER_ID'); process.exit(1); }
if (!GITHUB_REPOSITORY) { console.error('Sem GITHUB_REPOSITORY (rode no Actions)'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function graph(path, { method='GET', params={} } = {}) {
  const url = new URL(`${GRAPH}/${path}`); const opts = { method };
  const all = { ...params, access_token: IG_ACCESS_TOKEN };
  if (method === 'GET') for (const [k,v] of Object.entries(all)) url.searchParams.set(k,v);
  else opts.body = new URLSearchParams(all);
  const res = await fetch(url, opts); const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`Graph ${res.status} em ${path}: ${JSON.stringify(body?.error||body)}`);
  return body;
}

// "hoje" e "hora" em America/Sao_Paulo
const now = new Date();
const todayBR = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
const brtHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone:'America/Sao_Paulo', hour:'2-digit', hour12:false }).format(now));
const manual = !!process.argv[2];  // disparo manual com post explícito ignora as guardas de horário

// Guarda de janela: cron do GitHub atrasa (às vezes horas). Se cair fora da noite,
// é atraso — não publico, pra não sair de madrugada nem pegar o dia errado.
if (!manual && (brtHour < 18 || brtHour > 23)) {
  console.log(`Agora são ${brtHour}h BRT — fora da janela 18–23h (cron atrasou). Não publico. Nada a fazer.`);
  process.exit(0);
}

// escolhe o post: arg explícito, ou o cujo scheduleAt (data) == hoje BR
function pickPost() {
  const arg = process.argv[2];
  if (arg) return arg;
  // varre todas as semanas em posts/*/post-*.json e acha o cujo scheduleAt == hoje BR
  for (const week of readdirSync('posts', { withFileTypes:true }).filter(d => d.isDirectory())) {
    const dir = join('posts', week.name);
    for (const f of readdirSync(dir).filter(f => /^post-.*\.json$/.test(f))) {
      const p = JSON.parse(readFileSync(join(dir,f),'utf8'));
      if ((p.scheduleAt||'').slice(0,10) === todayBR) return join(dir,f);
    }
  }
  return null;
}

const file = pickPost();
if (!file) { console.log(`Nenhum post agendado pra hoje (${todayBR}). Nada a fazer.`); process.exit(0); }
const { caption, images, video } = JSON.parse(readFileSync(file,'utf8'));
if (!images?.length && !video) throw new Error('Post sem imagens nem vídeo: ' + file);
// Imagens: raw.githubusercontent serve image/jpeg (a API aceita). Vídeo: raw serve
// octet-stream e o IG recusa — então o mp4 vai por jsDelivr, que serve video/mp4.
const rawUrl = p => `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${BRANCH}/${p}`;
const cdnUrl = p => `https://cdn.jsdelivr.net/gh/${GITHUB_REPOSITORY}@${BRANCH}/${p}`;
// Reserva: se o raw estiver fora (503 Fastly, visto em 09/09/2026), a imagem vai pelo jsDelivr.
async function pickUrl(p) {
  const raw = rawUrl(p);
  try { const r = await fetch(raw, { method:'HEAD' }); if (r.ok) return raw; console.log(`  raw ${r.status} -> jsDelivr: ${p}`); }
  catch (e) { console.log(`  raw falhou (${e.message}) -> jsDelivr: ${p}`); }
  return cdnUrl(p);
}
const urls = [];
for (const p of (images||[])) urls.push(await pickUrl(p));
console.log(`Post: ${file} (${todayBR}) | ${video ? 'REEL: '+video : urls.length+' imagens'}`);
(video ? [cdnUrl(video)] : urls).forEach(u => console.log('  ', u));

// Idempotência: se um post com esta MESMA legenda já está no feed, não republica.
// Fonte da verdade = a própria conta. Mata duplicata mesmo se o cron rodar 2×.
try {
  const recent = await graph(`${IG_USER_ID}/media`, { params:{ fields:'caption', limit:'25' } });
  if ((recent.data||[]).some(m => (m.caption||'').trim() === (caption||'').trim())) {
    console.log('Este post já está no feed (mesma legenda). Pulo pra não duplicar. Nada a fazer.');
    process.exit(0);
  }
} catch (e) { console.log('aviso: não deu pra checar duplicado, sigo:', e.message); }

// monta o container: REEL (vídeo), imagem única, ou carrossel
let containerId, maxPolls = 20;
if (video) {
  containerId = (await graph(`${IG_USER_ID}/media`, { method:'POST', params:{ media_type:'REELS', video_url:cdnUrl(video), caption, share_to_feed:'true' } })).id;
  maxPolls = 40;  // vídeo demora mais pra processar
} else if (urls.length === 1) {
  containerId = (await graph(`${IG_USER_ID}/media`, { method:'POST', params:{ image_url:urls[0], caption } })).id;
} else {
  const children = [];
  for (const u of urls) children.push((await graph(`${IG_USER_ID}/media`, { method:'POST', params:{ image_url:u, is_carousel_item:'true' } })).id);
  containerId = (await graph(`${IG_USER_ID}/media`, { method:'POST', params:{ media_type:'CAROUSEL', caption, children:children.join(',') } })).id;
}
console.log('container:', containerId);

for (let i=0;i<maxPolls;i++){
  const { status_code } = await graph(containerId, { params:{ fields:'status_code' } });
  if (status_code === 'FINISHED') break;
  if (status_code === 'ERROR') throw new Error('Container deu ERROR no processamento.');
  await sleep(3000);
}
const pub = await graph(`${IG_USER_ID}/media_publish`, { method:'POST', params:{ creation_id:containerId } });
console.log('PUBLICADO. media id:', pub.id);
