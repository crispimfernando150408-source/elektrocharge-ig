// li/check-token.mjs
// O token do Share on LinkedIn vale 60 dias e a renovação exige login do dono.
// Avisa (::warning:: do Actions) quando faltam 7 dias ou menos. Uso: node li/check-token.mjs
import { diasAteVencer } from './lib.mjs';
const { LI_TOKEN_EXPIRES_AT } = process.env;
if (!LI_TOKEN_EXPIRES_AT) { console.log('::warning::LI_TOKEN_EXPIRES_AT não definido; registre a data de vencimento do token.'); process.exit(0); }
const dias = diasAteVencer(LI_TOKEN_EXPIRES_AT);
if (dias <= 7) { console.log(`::warning::Token do LinkedIn vence em ${dias} dia(s) (${LI_TOKEN_EXPIRES_AT}). Gere um novo no Developer Portal e atualize LI_ACCESS_TOKEN e LI_TOKEN_EXPIRES_AT.`); }
else console.log(`Token do LinkedIn vence em ${dias} dias.`);
