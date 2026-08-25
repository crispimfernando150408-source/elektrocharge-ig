# elektrocharge-ig — publicação automática no Instagram (sem Mac)

Publica os carrosséis da ElektroCharge no Instagram por **GitHub Actions** (cron na
nuvem). Não depende do Mac ligado. Grátis, sem cota (API direta do Instagram).

## Como funciona
- **`.github/workflows/publish.yml`** roda todo dia às **22:00 UTC = 19:00 BRT**.
- **`ig/publish-ci.mjs`** acha o post cujo `scheduleAt` é hoje (fuso America/Sao_Paulo)
  e publica. Se não houver post pra hoje, não faz nada.
- As imagens ficam commitadas em `posts/<semana>/img/...` e são servidas pela URL
  pública `raw.githubusercontent.com` (a API do Instagram busca por URL). Sem uploader externo.
- **`refresh-token.yml`** renova o token (60 dias) todo dia 1.

## Secrets (Settings → Secrets and variables → Actions)
- `IG_ACCESS_TOKEN` — token longo do Instagram (Instagram Login).
- `IG_USER_ID` — id da conta (@elektro.charge).
- `GH_PAT` *(opcional)* — PAT com permissão de escrever secrets, pra o refresh
  atualizar o token sozinho. Sem ele, o refresh imprime o novo token pra colar à mão.

## Publicar uma nova semana
1. Gere os carrosséis (pipeline local) → PNG 1080×1350.
2. Converta pra JPEG e coloque em `posts/<semana>/img/<slug>/NN.jpg`.
3. Crie `posts/<semana>/post-<slug>.json` com `{caption, images[relativos], scheduleAt}`
   (datas futuras, 19:00). Ajuste a pasta lida em `publish-ci.mjs` se mudar de semana.
4. `git add . && git commit && git push`. O cron faz o resto.

## Testar agora
Actions → "Publica IG 19h" → **Run workflow** → (opcional) informe um post específico.
