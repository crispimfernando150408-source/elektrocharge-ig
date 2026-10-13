// li/publish-ci.mjs
// Publica no LinkedIn pessoal o post do dia (rede=linkedin, conta=fernando) que já passou da hora.
// Idempotência: a fila só devolve post aprovado e não publicado; após publicar, o reporte
// muda o status, então a próxima execução não o vê. Uso: node li/publish-ci.mjs [--dry]
import { buscarPostHojeRede, publicarUgc, reportarPublicadoRede } from './lib.mjs';

const DRY = process.argv.includes('--dry');
const { CONTEUDO_API_BASE, CONTEUDO_SECRET, LI_ACCESS_TOKEN, LI_PERSON_URN } = process.env;
for (const [k, v] of Object.entries({ CONTEUDO_API_BASE, CONTEUDO_SECRET, LI_ACCESS_TOKEN, LI_PERSON_URN })) {
  if (!v) { console.error(`Falta a env ${k}`); process.exit(1); }
}
const brtHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()));
if (!DRY && (brtHour < 7 || brtHour > 20)) { console.log(`${brtHour}h BRT, fora da janela 7 a 20h. Nada a fazer.`); process.exit(0); }

const post = await buscarPostHojeRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, rede: 'linkedin', conta: 'fernando' });
if (!post) { console.log('Nada para publicar no LinkedIn agora.'); process.exit(0); }
console.log(`Post ${post.id} (${post.slug}): ${post.caption.length} caracteres`);
if (DRY) { console.log('--dry: publicaria agora. Não publico.'); process.exit(0); }

try {
  const { id } = await publicarUgc({ texto: post.caption, personUrn: LI_PERSON_URN, token: LI_ACCESS_TOKEN });
  console.log(`Publicado: ${id}`);
  await reportarPublicadoRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, publicado_id: id });
} catch (e) {
  console.error('Falha ao publicar:', e.message);
  await reportarPublicadoRede({ apiBase: CONTEUDO_API_BASE, secret: CONTEUDO_SECRET, id: post.id, erro: e.message }).catch((r) => console.error('aviso: falha ao reportar erro:', r.message));
  process.exit(1);
}
