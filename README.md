# elektrocharge-ig: publicação automática no Instagram (sem Mac)

Publica os carrosséis da ElektroCharge no Instagram por **GitHub Actions** (cron na
nuvem). Não depende do Mac ligado. Grátis, sem cota (API direta do Instagram).

## Como funciona
- **`.github/workflows/publish.yml`** roda todo dia às **22:00 UTC = 19:00 BRT**.
- **`ig/publish-ci.mjs`** pergunta ao dashboard qual é o post de hoje (ver "Fila no
  dashboard" abaixo) e publica. Se não houver post pra hoje, não faz nada.
- **`refresh-token.yml`** renova o token (60 dias) todo dia 1.

## Fila no dashboard
A fila deixou de morar numa pasta commitada: agora mora no dashboard (aba
Conteúdo), com aprovação e faixa (`auto`/`aprovar`/`bloqueado`) por post.

- `ig/publish-ci.mjs` chama `GET <CONTEUDO_API_BASE>/api/conteudo/hoje` com
  `Authorization: Bearer <CONTEUDO_SECRET>`. `post: null` → nada pra hoje, sai 0.
  `imagens`/`video` já vêm como URLs públicas (Supabase Storage), não passam por
  `raw.githubusercontent`/jsDelivr. A capa do reel vem de `imagens[0]` do post.
- Depois de tentar publicar, reporta pra `POST <base>/api/conteudo/posts/<id>/publicado`
  (mesmo Bearer): `{ ig_media_id }` no sucesso, `{ erro }` na falha (nunca os dois).
  Se o dedupe por legenda encontrar o post já publicado, reporta `publicado` com o
  `ig_media_id` existente em vez de tentar de novo.
- **Fallback**: se a API estiver fora do ar (erro de rede ou 5xx) ou as envs
  `CONTEUDO_API_BASE`/`CONTEUDO_SECRET` não existirem, cai no comportamento antigo:
  acha o post cujo `scheduleAt` é hoje em `posts/<semana>/post-*.json` (imagens por
  `raw.githubusercontent`, com reserva em jsDelivr). Um log claro avisa quando isso
  acontece. Erro 4xx (secret errado etc.) **não** cai no fallback, é config quebrada,
  não indisponibilidade, e estoura na hora.
- Retry com backoff (3 tentativas: 2s, 8s, 20s) em `fetch failed`/`ECONNRESET`/5xx nas
  chamadas ao Graph API do Instagram. O poll do container tem timeout total
  (`IG_POLL_TIMEOUT_MS`, padrão 10 min); se estourar, reporta `erro` em vez de ficar preso.
- A pasta `posts/` passa a ser só **fallback/histórico**, não é mais a fonte principal
  da fila. Novo conteúdo é gravado pela API (`POST /api/conteudo/posts`), não commitado aqui.

## Secrets e variáveis (Settings → Secrets and variables → Actions)
- `IG_ACCESS_TOKEN` *(secret)*: token longo do Instagram (Instagram Login).
- `IG_USER_ID` *(secret)*: id da conta (@elektro.charge).
- `CONTEUDO_API_BASE` *(variable, não secret)*: URL base do dashboard, ex.
  `https://elektrocharge-dashboard.vercel.app`. **O dono precisa cadastrar.**
- `CONTEUDO_SECRET` *(secret)*: mesmo segredo Bearer usado pelas rotas
  `/api/conteudo/*` no dashboard. **O dono precisa cadastrar.**
- `IG_POLL_TIMEOUT_MS` *(variable, opcional)*: timeout total do poll do container
  em ms. Padrão 600000 (10 min) se não definida.
- `GH_PAT` *(opcional)*: PAT com permissão de escrever secrets, pra o refresh
  atualizar o token sozinho. Sem ele, o refresh imprime o novo token pra colar à mão.

## Publicar um post avulso pelo fallback local (histórico/emergência)
1. Gere os carrosséis (pipeline local) → PNG 1080×1350.
2. Converta pra JPEG e coloque em `posts/<semana>/img/<slug>/NN.jpg`.
3. Crie `posts/<semana>/post-<slug>.json` com `{caption, images[relativos], scheduleAt}`
   (datas futuras, 19:00).
4. `git add . && git commit && git push`. Só é usado se a API do dashboard estiver fora
   do ar, ou passando o caminho manualmente (`workflow_dispatch` → campo `post`).

## Testar agora
Actions → "Publica IG 19h" → **Run workflow** → (opcional) informe um post específico
(fallback local). Localmente: `node ig/publish-ci.mjs --dry` resolve a fila e loga o
que faria, sem publicar.

## Contas e segredos com sufixo
Os publicadores atendem várias contas por **matriz de conta** nos workflows
(`strategy.matrix.conta`, `fail-fast: false`, `concurrency` por conta). Conta sem
segredo configurado: se for conta nova (Kaffra, ou Elektro no X e no LinkedIn), pula com
mensagem; se for a conta de origem (Elektro no Instagram, Fernando no X e no LinkedIn),
falha com código 1. Nos dois casos as outras contas da matriz seguem.
O nome **sem sufixo** vale para a conta de origem (Instagram = elektro; X e LinkedIn
= fernando); as demais usam `_ELEKTRO` ou `_KAFFRA`. Só nomes aqui, nunca valores.

| Rede | Conta | Secrets | Função |
|---|---|---|---|
| Instagram | elektro | `IG_ACCESS_TOKEN`, `IG_USER_ID` | `credenciaisIg` (`ig/lib.mjs`) |
| Instagram | kaffra | `IG_ACCESS_TOKEN_KAFFRA`, `IG_USER_ID_KAFFRA` | idem |
| X | fernando | `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_USER_ID` | `credenciaisX` (`x/lib.mjs`) |
| X | elektro | `X_ACCESS_TOKEN_ELEKTRO`, `X_ACCESS_TOKEN_SECRET_ELEKTRO`, `X_USER_ID_ELEKTRO` | idem |
| X | kaffra | `X_ACCESS_TOKEN_KAFFRA`, `X_ACCESS_TOKEN_SECRET_KAFFRA`, `X_USER_ID_KAFFRA` | idem |
| X | todas | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_BEARER_TOKEN` (sem sufixo) | idem |
| LinkedIn | fernando (pessoa) | `LI_ACCESS_TOKEN`, `LI_PERSON_URN` | `credenciaisLi` (`li/lib.mjs`) |
| LinkedIn | elektro (página) | `LI_ACCESS_TOKEN_ELEKTRO`, `LI_AUTHOR_URN_ELEKTRO` | idem |
| LinkedIn | kaffra (página) | `LI_ACCESS_TOKEN_KAFFRA`, `LI_AUTHOR_URN_KAFFRA` | idem |

Variables (não Secrets): `LI_TOKEN_EXPIRES_AT`, `LI_TOKEN_EXPIRES_AT_ELEKTRO`,
`LI_TOKEN_EXPIRES_AT_KAFFRA` (lidas por `li/check-token.mjs`, que falha com 7 dias
ou menos). O refresh mensal do Instagram (`ig/refresh-token.mjs`) renova e regrava
`IG_ACCESS_TOKEN` ou `IG_ACCESS_TOKEN_KAFFRA` conforme a conta da matriz.

Matrizes: `publish.yml` e `refresh-token.yml` com elektro e kaffra; `publish-x.yml`,
`publish-li.yml` e `check-li-token.yml` com fernando, elektro e kaffra. Post de
LinkedIn de página (elektro, kaffra) só sai por API quando houver os segredos da
página (Community Management API) **e** a Variable `LI_PAGINA_API_<CONTA>=1` (variável do
repositório, não Secret); sem ela a perna pula e o post é publicado à mão pelo dashboard.
Para ligar: (a) cadastrar token, URN e vencimento; (b) definir `LI_PAGINA_API_<CONTA>=1`
aqui e `PUBLICADOR_LINKEDIN_<CONTA>=1` na Vercel na mesma hora, o que liga a API e
desliga a rota manual.

**Ordem dos segredos da Kaffra:** cadastre `IG_ACCESS_TOKEN_KAFFRA`, `IG_USER_ID_KAFFRA`
e os `X_*`/`LI_*` de Elektro e Kaffra só depois do deploy do PR #358 do dashboard. Antes
dele, `GET /api/conteudo/hoje` ignora `rede` e `conta`, e a perna da Kaffra publicaria o
post da Elektro na conta errada.
O dashboard enxerga só a variável espelho `PUBLICADOR_<REDE>_<CONTA>=1` na Vercel.
