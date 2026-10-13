// li/lib.mjs
// Publicador do LinkedIn pessoal (produto Share on LinkedIn, escopo w_member_social).
// Texto puro no piloto; imagem fica para depois (registerUpload + asset).
export { buscarPostHojeRede, reportarPublicadoRede } from '../x/lib.mjs';

const UGC = 'https://api.linkedin.com/v2/ugcPosts';

export async function publicarUgc({ texto, personUrn, token, fetchImpl = fetch }) {
  const corpo = {
    author: personUrn,
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
