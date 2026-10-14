// li/lib.mjs
// Publicador do LinkedIn, autor pessoa (w_member_social) ou organização (página, só com a API aprovada).
// Texto puro no piloto; imagem fica para depois (registerUpload + asset).
export { buscarPostHojeRede, reportarPublicadoRede } from '../x/lib.mjs';

const UGC = 'https://api.linkedin.com/v2/ugcPosts';

/**
 * Segredos do LinkedIn por conta. `fernando` = pessoa (nomes históricos); outra conta lê
 * LI_ACCESS_TOKEN_<CONTA> e LI_AUTHOR_URN_<CONTA> (página: urn:li:organization:<id>).
 */
export function credenciaisLi(env, conta = 'fernando') {
  const ehPessoa = conta === 'fernando';
  const suf = ehPessoa ? '' : `_${conta.toUpperCase()}`;
  const token = env[`LI_ACCESS_TOKEN${suf}`];
  const authorUrn = ehPessoa ? env.LI_PERSON_URN : env[`LI_AUTHOR_URN${suf}`];
  if (!token || !authorUrn) return null;
  // Página só publica por API com a chave explícita LI_PAGINA_API_<CONTA>=1: cadastrar o token
  // sozinho não liga nada, e o dono desliga a publicação manual na mesma hora (dashboard).
  if (!ehPessoa && env[`LI_PAGINA_API${suf}`] !== '1') return null;
  return { token, authorUrn };
}

export async function publicarUgc({ texto, authorUrn, token, fetchImpl = fetch }) {
  if (!/^urn:li:(person|organization):/.test(authorUrn ?? '')) throw new Error('authorUrn inválido: esperado urn:li:person:... ou urn:li:organization:...');
  const corpo = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: texto }, shareMediaCategory: 'NONE' } },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
  const res = await fetchImpl(UGC, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-restli-protocol-version': '2.0.0' },
    body: JSON.stringify(corpo),
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    const motivo = res.status === 401 ? 'token inválido ou expirado' : texto;
    throw new Error(`LinkedIn respondeu ${res.status}: ${motivo}`);
  }
  const id = res.headers.get('x-restli-id');
  if (!id) throw new Error('LinkedIn publicou mas não devolveu x-restli-id');
  return { id };
}

export function diasAteVencer(expiresAtISO, agoraISO = new Date().toISOString()) {
  return Math.floor((new Date(expiresAtISO).getTime() - new Date(agoraISO).getTime()) / 86400000);
}
