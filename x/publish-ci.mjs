// x/publish-ci.mjs
// Publica no X o post do dia da conta do Fernando (rede=x, conta=fernando) que já
// passou da hora. Roda várias vezes por dia no Actions; a idempotência por texto
// garante que só uma execução publica. Nunca publica sem a fila dizer que pode.
// Uso: node x/publish-ci.mjs [--dry]
import { buscarPostHojeRede, publicarTweet, reportarPublicadoRede, tweetsRecentes } from './lib.mjs';

const DRY = process.argv.includes('--dry');
const { CONTEUDO_API_BASE, CONTEUDO_SECRET, X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, X_USER_ID, X_BEARER_TOKEN } = process.env;
for (const [k, v] of Object.entries({ CONTEUDO_API_BASE, CONTEUDO_SECRET, X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, X_USER_ID, X_BEARER_TOKEN })) {
  if (!v) { console.error(`Falta a env ${k}`); process.exit(1); }
}

const brtHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()));
if (!DRY && (brtHour < 8 || brtHour > 22)) { console.log(`${brtHour}h BRT, fora da janela 8 a 22h. Nada a fazer.`); process.exit(0); }

const post = await buscarPostHojeRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, rede: 'x', conta: 'fernando' });
if (!post) { console.log('Nada para publicar no X agora.'); process.exit(0); }
console.log(`Post ${post.id} (${post.slug}): ${post.caption.length} caracteres`);

const credenciais = { consumerKey: X_CONSUMER_KEY, consumerSecret: X_CONSUMER_SECRET, token: X_ACCESS_TOKEN, tokenSecret: X_ACCESS_TOKEN_SECRET };

let recentes = [];
try { recentes = await tweetsRecentes({ userId: X_USER_ID, bearer: X_BEARER_TOKEN }); }
catch (e) { console.log('aviso: não deu para checar duplicado, sigo:', e.message); }
const igual = recentes.find((t) => t.text.trim() === post.caption.trim());
if (igual) {
  console.log(`Já está no X (tweet ${igual.id}). Reporto e saio.`);
  await reportarPublicadoRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, publicado_id: igual.id });
  process.exit(0);
}

if (DRY) { console.log('--dry: publicaria agora. Não publico.'); process.exit(0); }

try {
  const { id } = await publicarTweet({ texto: post.caption, credenciais });
  console.log(`Publicado: tweet ${id}`);
  await reportarPublicadoRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, publicado_id: id });
} catch (e) {
  console.error('Falha ao publicar:', e.message);
  await reportarPublicadoRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, erro: e.message }).catch((r) => console.error('aviso: falha ao reportar erro:', r.message));
  process.exit(1);
}
