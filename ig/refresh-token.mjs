// Renova o token longo do Instagram (vale 60 dias) e grava de volta no Secret IG_ACCESS_TOKEN.
// Roda mensalmente no Actions. Precisa do Secret GH_PAT (PAT com permissão de escrever secrets).
// Se GH_PAT não existir, imprime o novo token pra você colar no Secret manualmente.
import { execFileSync } from 'node:child_process';

const CONTA = process.env.IG_CONTA || 'elektro';
const SECRET = CONTA === 'elektro' ? 'IG_ACCESS_TOKEN' : `IG_ACCESS_TOKEN_${CONTA.toUpperCase()}`;
const tok = process.env[SECRET];
if (!tok) {
  if (CONTA === 'elektro') { console.error(`Sem ${SECRET}`); process.exit(1); }
  console.log(`Conta ${CONTA} sem ${SECRET} configurado. Pulo.`); process.exit(0);
}

const url = new URL('https://graph.instagram.com/refresh_access_token');
url.searchParams.set('grant_type', 'ig_refresh_token');
url.searchParams.set('access_token', tok);
const j = await (await fetch(url)).json();
if (!j.access_token) throw new Error('Falha no refresh: ' + JSON.stringify(j));
console.log(`Token renovado (~${Math.round((j.expires_in||0)/86400)} dias).`);

if (process.env.GH_PAT && process.env.GITHUB_REPOSITORY) {
  // grava no Secret via API do GitHub (gh CLI já vem no runner).
  execFileSync('gh', ['secret', 'set', SECRET, '--body', j.access_token, '--repo', process.env.GITHUB_REPOSITORY],
    { env: { ...process.env, GH_TOKEN: process.env.GH_PAT }, stdio: 'inherit' });
  console.log(`Secret ${SECRET} atualizado automaticamente.`);
} else {
  // Nunca imprimir o token: log de Actions de repositório público é público. Sem GH_PAT o job
  // falha alto para o dono configurar o GH_PAT, em vez de jogar o token na tela.
  console.log(`::error::Sem GH_PAT: token renovado NÃO foi gravado em ${SECRET}. Configure o secret GH_PAT (escopo de secrets do repo) e rode de novo.`);
  process.exit(1);
}
