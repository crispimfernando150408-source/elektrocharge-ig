# elektrocharge-ig: publicação automática no Instagram (sem Mac)

Publica os carrosséis da ElektroCharge no Instagram por **GitHub Actions** (cron na
nuvem). Não depende do Mac ligado. Grátis, sem cota (API direta do Instagram).

## Como funciona
- **`.github/workflows/publish.yml`** roda de hora em hora, das **08:17 às 22:17 BRT**
  (minuto quebrado; o GitHub atrasa cron em hora cheia), mais uma repescagem às 22:47.
  Guarda de janela: só publica de 8h a 23h BRT (cron atrasado de madrugada não publica).
  Post com `schedule_at` depois das 22:47 não sai (no dia seguinte a lista já é do dia
  novo): agende entre 08:00 e 22:00.
- **`ig/publish-ci.mjs`** pergunta ao dashboard a lista do que pode sair agora (ver "Fila
  no dashboard" abaixo) e publica todos, em ordem de horário, com 60 s entre um e outro.
  Se a lista vier vazia, não faz nada.
- **`refresh-token.yml`** renova o token (60 dias) todo dia 1.

## Fila no dashboard
A fila deixou de morar numa pasta commitada: agora mora no dashboard (aba
Conteúdo), com aprovação e faixa (`auto`/`aprovar`/`bloqueado`) por post.

- `ig/publish-ci.mjs` chama `GET <CONTEUDO_API_BASE>/api/conteudo/hoje?rede=instagram&conta=<conta>&lista=1`
  com `Authorization: Bearer <CONTEUDO_SECRET>` e recebe `posts`: todos os posts
  **`aprovado`** (só a aprovação do dono; a faixa `auto` não entra) do dia BRT cujo
  `schedule_at` já chegou. Lista vazia → nada agora, sai 0. Resposta sem `posts`
  (dashboard sem `?lista=1`) é erro: sai 1 sem publicar. O publicador confere de novo
  `status: aprovado`, o fuso e o horário de cada post antes de publicar, e ordena por
  horário.
  `imagens`/`video` já vêm como URLs públicas (Supabase Storage), não passam por
  `raw.githubusercontent`/jsDelivr. A capa do reel vem de `imagens[0]` do post.
- Depois de tentar publicar, reporta pra `POST <base>/api/conteudo/posts/<id>/publicado`
  (mesmo Bearer): `{ ig_media_id }` no sucesso, `{ erro }` na falha (nunca os dois).
  O dashboard troca o status e o post sai da lista: é isso que impede o run da hora
  seguinte de publicar de novo. Se o reporte se perder, o dedupe por legenda (últimas
  25 mídias do feed) acha o post já publicado e reporta `publicado` com o `ig_media_id`
  existente em vez de tentar de novo (o mesmo vale para dois posts com a mesma legenda:
  o segundo não sai e fica como publicado, com aviso no log). Se a checagem do feed falhar, o run para sem
  publicar. Se um post falhar ao publicar, ele vira `falhou` (não volta sozinho) e o run
  para; os seguintes ficam para o run da hora seguinte. Um run por conta por vez
  (`concurrency`), até 120 min cada.
- **API fora do ar** (erro de rede ou 5xx): desde 11/11/2026 o run sai com erro sem
  publicar e o da hora seguinte tenta de novo. Não cai mais na pasta `posts/`: ela não
  passa pela aprovação do dono no dashboard, e uma legenda editada lá escaparia da
  checagem de duplicata. Erro 4xx (secret errado etc.) também estoura na hora.
- **Pasta local `posts/`**: só sem as envs `CONTEUDO_API_BASE`/`CONTEUDO_SECRET`, ou no
  disparo manual com o caminho do post. Publica os posts de hoje com horário já chegado
  (imagens por `raw.githubusercontent`, com reserva em jsDelivr), sem reportar ao dashboard.
- Retry com backoff (3 tentativas: 2s, 8s, 20s) em `fetch failed`/`ECONNRESET`/5xx nas
  chamadas ao Graph API do Instagram. O poll do container tem timeout total
  (`IG_POLL_TIMEOUT_MS`, padrão 10 min); se estourar, reporta `erro` em vez de ficar preso.
- A pasta `posts/` passa a ser só **histórico/emergência manual**, não é mais a fonte principal
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

## Publicar um post avulso pela pasta local (histórico/emergência)
1. Gere os carrosséis (pipeline local) → PNG 1080×1350.
2. Converta pra JPEG e coloque em `posts/<semana>/img/<slug>/NN.jpg`.
3. Crie `posts/<semana>/post-<slug>.json` com `{caption, images[relativos], scheduleAt}`
   (datas futuras, `HH:MM` entre 08:00 e 22:00).
4. `git add . && git commit && git push`. Só é usado passando o caminho manualmente
   (`workflow_dispatch` → campo `post`) ou sem as envs da API.

## Testar agora
Actions → "Publica IG (de hora em hora)" → **Run workflow** → (opcional) informe um post
específico (pasta local). Localmente, sem publicar nem reportar:
`IG_ACCESS_TOKEN=x IG_USER_ID=x IG_FAKE_HOUR=19:17 node ig/publish-ci.mjs --dry --date 2026-10-29`.
`--date` e `IG_FAKE_HOUR` (`19` ou `19:30`) só valem com `--dry` e só mudam a pasta local
e a guarda de janela; a lista da API é sempre a de agora no dashboard. Testes: `node --test`.

Limite da Meta: 50 posts publicados pela API por conta em 24 h (carrossel conta como 1;
a doc de publicação cita 100 numa seção e 50 em outra, vale o menor).

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

**Instagram da Kaffra: não ligar aqui.** A Kaffra publica no Instagram pelo repositório
`kaffra-ig` (fila em pasta). Se `IG_ACCESS_TOKEN_KAFFRA` e `IG_USER_ID_KAFFRA` existirem
aqui, a perna `kaffra` deste `publish.yml` publica toda hora os posts `aprovado` da conta
kaffra no dashboard, e duas filas publicariam na mesma conta. Proposta em aberto (decisão do
dono): tirar `kaffra` da matriz do `publish.yml`.

**Ordem dos segredos da Kaffra** (se um dia o Instagram da Kaffra vier para cá, o que hoje
não vale, ver acima): cadastre `IG_ACCESS_TOKEN_KAFFRA`, `IG_USER_ID_KAFFRA`
e os `X_*`/`LI_*` de Elektro e Kaffra só depois do deploy do PR #358 do dashboard. Antes
dele, `GET /api/conteudo/hoje` ignora `rede` e `conta`, e a perna da Kaffra publicaria o
post da Elektro na conta errada.
O dashboard enxerga só a variável espelho `PUBLICADOR_<REDE>_<CONTA>=1` na Vercel.
