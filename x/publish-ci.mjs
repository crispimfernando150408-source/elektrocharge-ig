// x/publish-ci.mjs
// Publica no X o post do dia da conta X_CONTA (rede=x, padrão fernando) que já
// passou da hora. Roda várias vezes por dia no Actions; a idempotência por texto
// garante que só uma execução publica. Nunca publica sem a fila dizer que pode.
// Uso: node x/publish-ci.mjs [--dry]
import { comRetry } from '../ig/lib.mjs';
import { buscarPostHojeRede, credenciaisX, comoTransiente, mesmoTexto, publicarTweet, reportarPublicadoRede, tweetsRecentes } from './lib.mjs';

const tentar = (fn) => comRetry(comoTransiente(fn));

const DRY = process.argv.includes('--dry');
const { CONTEUDO_API_BASE, CONTEUDO_SECRET, X_BEARER_TOKEN } = process.env;
const CONTA = process.env.X_CONTA || 'fernando';
const cred = credenciaisX(process.env, CONTA);
if (!cred) { console.log(`Conta ${CONTA} sem segredo do X configurado. Pulo.`); process.exit(0); }
for (const [k, v] of Object.entries({ CONTEUDO_API_BASE, CONTEUDO_SECRET, X_BEARER_TOKEN })) {
  if (!v) { console.error(`Falta a env ${k}`); process.exit(1); }
}

const brtHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()));
if (!DRY && (brtHour < 8 || brtHour > 22)) { console.log(`${brtHour}h BRT, fora da janela 8 a 22h. Nada a fazer.`); process.exit(0); }

const post = await tentar(() => buscarPostHojeRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, rede: 'x', conta: CONTA }));
if (!post) { console.log('Nada para publicar no X agora.'); process.exit(0); }
console.log(`Post ${post.id} (${post.slug}): ${post.caption.length} caracteres`);

const { userId, ...credenciais } = cred;

let recentes;
try { recentes = await tentar(() => tweetsRecentes({ userId, bearer: X_BEARER_TOKEN })); }
catch (e) {
  // Sem a lista não dá para saber se já está no ar: não publica; o próximo cron tenta de novo.
  console.error('Não deu para checar duplicado, não publico nesta execução:', e.message);
  process.exit(1);
}
const igual = recentes.find((t) => mesmoTexto(t.text, post.caption));
const reportar = (corpo) => reportarPublicadoRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, ...corpo });

if (igual) {
  if (DRY) { console.log(`--dry: já está no X (tweet ${igual.id}), reportaria. Não publico nem reporto.`); process.exit(0); }
  console.log(`Já está no X (tweet ${igual.id}). Reporto e saio.`);
  try { await tentar(() => reportar({ publicado_id: igual.id })); }
  catch (e) { console.error(`::error::Tweet ${igual.id} já está no ar mas a fila não foi atualizada (${e.message}); reporte à mão: POST $CONTEUDO_API_BASE/api/conteudo/posts/${post.id}/publicado com {"publicado_id":"..."} (ver docs/conteudo/piloto-perfil.md no dashboard)`); process.exit(1); }
  process.exit(0);
}

if (DRY) { console.log('--dry: publicaria agora. Não publico.'); process.exit(0); }

let id;
try {
  // Sem retry na publicação: o POST não é idempotente e uma resposta perdida duplicaria o tweet.
  ({ id } = await publicarTweet({ texto: post.caption, credenciais }));
  console.log(`Publicado: tweet ${id}`);
} catch (e) {
  console.error('Falha ao publicar:', e.message);
  await reportar({ erro: e.message }).catch((r) => console.error('aviso: falha ao reportar erro:', r.message));
  process.exit(1);
}
try { await tentar(() => reportar({ publicado_id: id })); }
catch (e) {
  console.error(`::error::Publicado como ${id} mas a fila não foi atualizada; reporte à mão: POST $CONTEUDO_API_BASE/api/conteudo/posts/${post.id}/publicado com {"publicado_id":"..."} (ver docs/conteudo/piloto-perfil.md no dashboard) (${e.message})`);
  process.exit(1);
}
