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

// "hoje" em America/Sao_Paulo (YYYY-MM-DD)
const todayBR = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

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
const { caption, images } = JSON.parse(readFileSync(file,'utf8'));
if (!images?.length) throw new Error('Post sem imagens: ' + file);
const rawUrl = p => `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${BRANCH}/${p}`;
const urls = images.map(rawUrl);
console.log(`Post: ${file} (${todayBR}) | ${urls.length} imagens`);
urls.forEach(u => console.log('  ', u));

// monta carrossel (ou imagem única)
let containerId;
if (urls.length === 1) {
  containerId = (await graph(`${IG_USER_ID}/media`, { method:'POST', params:{ image_url:urls[0], caption } })).id;
} else {
  const children = [];
  for (const u of urls) children.push((await graph(`${IG_USER_ID}/media`, { method:'POST', params:{ image_url:u, is_carousel_item:'true' } })).id);
  containerId = (await graph(`${IG_USER_ID}/media`, { method:'POST', params:{ media_type:'CAROUSEL', caption, children:children.join(',') } })).id;
}
console.log('container:', containerId);

for (let i=0;i<20;i++){
  const { status_code } = await graph(containerId, { params:{ fields:'status_code' } });
  if (status_code === 'FINISHED') break;
  if (status_code === 'ERROR') throw new Error('Container deu ERROR no processamento.');
  await sleep(3000);
}
const pub = await graph(`${IG_USER_ID}/media_publish`, { method:'POST', params:{ creation_id:containerId } });
console.log('PUBLICADO. media id:', pub.id);
