// Renova o token longo do Instagram (vale 60 dias) e grava de volta no Secret IG_ACCESS_TOKEN.
// Roda mensalmente no Actions. Precisa do Secret GH_PAT (PAT com permissão de escrever secrets).
// Se GH_PAT não existir, imprime o novo token pra você colar no Secret manualmente.
import { execFileSync } from 'node:child_process';

const tok = process.env.IG_ACCESS_TOKEN;
if (!tok) { console.error('Sem IG_ACCESS_TOKEN'); process.exit(1); }

const url = new URL('https://graph.instagram.com/refresh_access_token');
url.searchParams.set('grant_type', 'ig_refresh_token');
url.searchParams.set('access_token', tok);
const j = await (await fetch(url)).json();
if (!j.access_token) throw new Error('Falha no refresh: ' + JSON.stringify(j));
console.log(`Token renovado (~${Math.round((j.expires_in||0)/86400)} dias).`);

if (process.env.GH_PAT && process.env.GITHUB_REPOSITORY) {
  // grava no Secret via API do GitHub (gh CLI já vem no runner).
  execFileSync('gh', ['secret', 'set', 'IG_ACCESS_TOKEN', '--body', j.access_token, '--repo', process.env.GITHUB_REPOSITORY],
    { env: { ...process.env, GH_TOKEN: process.env.GH_PAT }, stdio: 'inherit' });
  console.log('Secret IG_ACCESS_TOKEN atualizado automaticamente.');
} else {
  console.log('::warning::Sem GH_PAT — cole este token no Secret IG_ACCESS_TOKEN manualmente:');
  console.log(j.access_token);
}
