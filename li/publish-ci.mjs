// li/publish-ci.mjs
// Publica no LinkedIn o post do dia (rede=linkedin, conta LI_CONTA, padrão fernando) que já passou da hora.
// Idempotência: a fila só devolve post aprovado e não publicado; após publicar, o reporte
// muda o status, então a próxima execução não o vê. Uso: node li/publish-ci.mjs [--dry]
import { comRetry } from '../ig/lib.mjs';
import { comoTransiente } from '../x/lib.mjs';
import { buscarPostHojeRede, credenciaisLi, publicarUgc, reportarPublicadoRede } from './lib.mjs';

const tentar = (fn) => comRetry(comoTransiente(fn));

const DRY = process.argv.includes('--dry');
const { CONTEUDO_API_BASE, CONTEUDO_SECRET } = process.env;
const CONTA = process.env.LI_CONTA || 'fernando';
const cred = credenciaisLi(process.env, CONTA);
if (!cred) { console.log(`Conta ${CONTA} sem segredo do LinkedIn configurado. Pulo.`); process.exit(0); }
for (const [k, v] of Object.entries({ CONTEUDO_API_BASE, CONTEUDO_SECRET })) {
  if (!v) { console.error(`Falta a env ${k}`); process.exit(1); }
}
const brtHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()));
if (!DRY && (brtHour < 7 || brtHour > 21)) { console.log(`${brtHour}h BRT, fora da janela 7 a 21h. Nada a fazer.`); process.exit(0); }

const post = await tentar(() => buscarPostHojeRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, rede: 'linkedin', conta: CONTA }));
if (!post) { console.log('Nada para publicar no LinkedIn agora.'); process.exit(0); }
console.log(`Post ${post.id} (${post.slug}): ${post.caption.length} caracteres`);
if (DRY) { console.log('--dry: publicaria agora. Não publico.'); process.exit(0); }

const reportar = (corpo) => reportarPublicadoRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, ...corpo });

let id;
try {
  // Sem retry na publicação: o POST não é idempotente e uma resposta perdida duplicaria o post.
  ({ id } = await publicarUgc({ texto: post.caption, authorUrn: cred.authorUrn, token: cred.token }));
  console.log(`Publicado: ${id}`);
} catch (e) {
  console.error('Falha ao publicar:', e.message);
  await reportar({ erro: e.message }).catch((r) => console.error('aviso: falha ao reportar erro:', r.message));
  process.exit(1);
}
// Já está no ar: nunca marcar `falhou`. Se o reporte não passar, o dono reporta à mão pela rota /publicado (curl no piloto-perfil.md).
try { await tentar(() => reportar({ publicado_id: id })); }
catch (e) {
  console.error(`::error::Publicado como ${id} mas a fila não foi atualizada; reporte à mão: POST $CONTEUDO_API_BASE/api/conteudo/posts/${post.id}/publicado com {"publicado_id":"..."} (ver docs/conteudo/piloto-perfil.md no dashboard) (${e.message})`);
  process.exit(1);
}
