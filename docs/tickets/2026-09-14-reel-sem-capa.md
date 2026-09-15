# Ticket: reel publicado sem capa definida

Repositório **elektrocharge-ig** (o publisher, não o dashboard). pt-BR com acentuação correta,
**zero travessão** em qualquer texto, comentário ou mensagem de commit. Entrega em **PR draft**, um assunto só.

Leia antes de codar, nesta ordem:
1. `README.md` do repositório.
2. `ig/publish-ci.mjs` inteiro.
3. `ig/lib.mjs` (é onde mora a lógica testável; o script de topo só orquestra).
4. `ig/publish-ci.test.mjs` (modelo de estilo: tudo com `fetch` injetado, sem rede).

## PROBLEMA

Reportado pelo dono em 14/09/2026: os reels da Elektro Charge no Instagram estão **sem capa**. No grid do
perfil eles aparecem com um quadro qualquer do vídeo, escolhido pelo Instagram, em vez da capa desenhada.

Causa, em `ig/publish-ci.mjs` linha 117: o container de reel é criado assim:

```js
params: { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' }
```

Falta `cover_url`. Sem ele, o Instagram escolhe um quadro sozinho.

O detalhe que torna isso fácil de consertar: **a capa já existe e já está publicada**. O pipeline do
dashboard extrai o primeiro quadro do reel com ffmpeg, sobe no armazenamento e entrega em `imagens[0]` do
post. O publisher recebe essa imagem e hoje simplesmente a ignora quando há vídeo, porque o ramo do reel só
olha `videoUrl`.

## DADO JÁ VERIFICADO (não precisa investigar)

- O post de reel que a interface de programação devolve traz `video` **e** `imagens` com um item. O código já
  monta as duas coisas: `urls` (as imagens) e `videoUrl`. No ramo do reel, `urls` não é usado.
- A capa gerada pelo pipeline é JPEG de **1080 por 1920**, mesma proporção do vídeo (conferido com ffprobe no
  reel da semana 2026-W38). Serve como capa sem recorte.
- `share_to_feed: 'true'` já está sendo enviado, então o reel **já vai** para o feed. O problema é só a capa.
- O reel é servido por uma rede de distribuição porque o armazenamento devolve tipo genérico e o Instagram
  recusa; veja o comentário perto da linha 65 e a função de montar URL. **A capa precisa do mesmo cuidado**:
  use o mesmo caminho de URL que as imagens já usam hoje, não invente outro.
- O Instagram também aceita `thumb_offset` (o instante do vídeo, em milissegundos, a usar como capa). É o
  plano B: serve quando não há imagem de capa disponível.

## ESCOPO DENTRO

1. **`ig/lib.mjs`**: função pura `paramsDoReel({ videoUrl, coverUrl })` que devolve o objeto de parâmetros do
   container de reel. Com capa, inclui `cover_url`. Sem capa, inclui `thumb_offset: '0'` para pelo menos
   fixar o primeiro quadro em vez de deixar o Instagram escolher. `media_type`, `video_url`, `caption` e
   `share_to_feed` continuam como estão. Sem I/O na função.
2. **`ig/publish-ci.mjs`**: no ramo do reel, usar a função nova, passando a primeira imagem do post como capa
   quando ela existir. Logar qual capa foi usada (ou que não havia capa e caiu no primeiro quadro), porque
   hoje o log só mostra o vídeo e o dono não tem como saber o que foi publicado.
3. **Testes** em `ig/publish-ci.test.mjs`: com capa, o objeto tem `cover_url` e não tem `thumb_offset`; sem
   capa, tem `thumb_offset` e não tem `cover_url`; nos dois casos `media_type` é `REELS` e `share_to_feed`
   continua `'true'`; legenda passa intacta.
4. **`README.md`**: uma linha na explicação do fluxo dizendo que a capa do reel vem de `imagens[0]` do post.

## ESCOPO FORA

- Publicar de verdade, chamar a interface do Instagram, mexer em segredo, em variável de ambiente ou no
  fluxo de automação (`.github/workflows/`).
- Mudar o repositório do dashboard. Se você concluir que o pipeline de lá precisa mudar, **escreva no PR** em
  vez de mexer: é outro repositório e outro ticket.
- Mexer no carrossel, na imagem única, no retry, na escolha da fonte do post, no reporte de publicado.
- Trocar a rede de distribuição ou a forma de montar URL.

## CRITÉRIO DE ACEITE (rode e cole a saída no PR)

```bash
node --test ig/publish-ci.test.mjs
node ig/publish-ci.mjs --dry
grep -n "cover_url\|thumb_offset" ig/lib.mjs ig/publish-ci.mjs
grep -c "—" ig/lib.mjs ig/publish-ci.mjs README.md
git diff --stat origin/main
```

Se o repositório usar `master` em vez de `main`, ajuste o último comando e diga no PR.

## SAÍDA SE BLOQUEAR

Se `--dry` precisar de segredo que você não tem, diga no PR qual faltou e entregue o resto. **Não** crie
segredo, não leia arquivo de ambiente, não publique nada de verdade.

## ENTREGA

Commits em pt-BR. Push. **PR draft** com o título `fix(publisher): reel publicado com capa definida`.
