// Inventário do Instagram (só leitura, Graph API). Roda no Actions com o Secret da conta
// e publica o resultado como artefato; o token nunca sai do runner.
// Uso local: IG_ACCESS_TOKEN=... node ig/inventario.mjs (saída em ./inventario)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PASTA = process.env.INVENTARIO_DIR || 'inventario';
mkdirSync(PASTA, { recursive: true });
const API = 'https://graph.instagram.com';

function token() {
  if (!process.env.IG_ACCESS_TOKEN) { console.error('Sem IG_ACCESS_TOKEN'); process.exit(1); }
  return process.env.IG_ACCESS_TOKEN.trim();
}
async function graph(path, params) {
  const u = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', TOKEN);
  const r = await fetch(u); const j = await r.json();
  if (!r.ok || j.error) throw new Error(`${path}: ${JSON.stringify(j.error ?? j)}`);
  return j;
}
const TOKEN = token();
const eu = await graph('me', { fields: 'id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website' });
console.log(`@${eu.username}: ${eu.media_count} posts, ${eu.followers_count} seguidores`);

const posts = [];
let next = null;
do {
  const page = next ? await (await fetch(next)).json() : await graph(`${eu.id}/media`, { fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,is_shared_to_feed', limit: '50' });
  posts.push(...(page.data ?? []));
  next = page.paging?.next ?? null;
} while (next);

mkdirSync(join(PASTA, 'capas'), { recursive: true });
for (const p of posts) {
  try {
    const ins = await graph(`${p.id}/insights`, { metric: p.media_type === 'VIDEO' ? 'reach,saved,shares,views' : 'reach,saved,shares' });
    p.insights = Object.fromEntries((ins.data ?? []).map((m) => [m.name, m.values?.[0]?.value ?? null]));
  } catch (e) { p.insights = { erro: String(e.message).slice(0, 120) }; }
  const url = p.thumbnail_url ?? p.media_url;
  if (url) {
    try { const b = Buffer.from(await (await fetch(url)).arrayBuffer()); writeFileSync(join(PASTA, 'capas', `${p.timestamp.slice(0, 10)}-${p.id}.jpg`), b); } catch {}
  }
}
posts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
writeFileSync(join(PASTA, 'inventario.json'), JSON.stringify({ perfil: eu, posts }, null, 2));

const linhas = ['# Inventário do Instagram da Elektro Charge', '', `Perfil: @${eu.username}. ${eu.media_count} posts, ${eu.followers_count} seguidores, segue ${eu.follows_count}.`, '', `Bio atual:`, '', '> ' + String(eu.biography ?? '').replace(/\n/g, '\n> '), '', `Site na bio: ${eu.website ?? '(vazio)'}`, '', '| Data | Tipo | Alcance | Salvos | Compart. | Curtidas | Coment. | Legenda (início) | Link |', '|---|---|---|---|---|---|---|---|---|'];
for (const p of posts) {
  const i = p.insights ?? {};
  linhas.push(`| ${p.timestamp.slice(0, 10)} | ${p.media_product_type ?? p.media_type} | ${i.reach ?? ''} | ${i.saved ?? ''} | ${i.shares ?? ''} | ${p.like_count ?? ''} | ${p.comments_count ?? ''} | ${String(p.caption ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 70)} | ${p.permalink} |`);
}
writeFileSync(join(PASTA, 'inventario.md'), linhas.join('\n') + '\n');
console.log(`${posts.length} posts em inventario.md e inventario.json; capas em capas/ (${posts.length} arquivos)`);
