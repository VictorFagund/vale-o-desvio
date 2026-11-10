# Vale o Desvio

Mostra qual posto **compensa de verdade**: preço × litros + combustível da ida e volta + o tempo
da ida e volta, comparado com o posto mais perto de você.

- Preços: levantamento semanal da ANP (amostra; ~420 cidades, ~6 mil postos com preço).
- Postos e localização: cadastro oficial da ANP ([API Revendedores](https://revendedoresapi.anp.gov.br/swagger/index.html),
  sem chave). Todo posto autorizado do país (~39 mil com local), com bandeira e combustíveis.
  Quem não tem preço aparece em cinza no mapa. Cobre ~5 mil cidades.
- Nomes das cidades com acento: API de localidades do IBGE.
- Mapa: MapLibre + OpenFreeMap (sem chave). Rotas reais: OSRM público (sem chave).
- Sem servidor: é um site estático em `site/`.

## Atualizar os dados

```bash
python -I dados/baixar.py 4          # planilhas de preço (semanal)
python -I dados/cadastro.py          # cadastro de postos (UFs com mais de 7 dias; ~10 min)
python -I dados/preparar.py
```

`cadastro.py` espera 20 s entre pedidos: rápido demais, a API da ANP responde 429. Se cair, rode de
novo que ele continua de onde parou.

O local de cada posto vem do cadastro (descartado se cair a mais de 45 km dos outros postos da cidade).
Cerca de 11% dos postos com preço não têm local no cadastro: ficam na lista, fora do mapa. Para buscar
esses no Nominatim (1 por segundo, cache em `dados/geocache.json`):
`python -I dados/preparar.py --geo "CASCAVEL/PR"` (pode repetir `--geo`).
Em 06/11/2026, nos 6 maiores desacordos de Curitiba entre o cadastro e o Nominatim, o cadastro acertava
todos (o Nominatim tinha caído no CEP e jogado o posto no Centro).

## Publicação

Cada push na `main` publica a pasta `site/` no GitHub Pages (`.github/workflows/pages.yml`).
Para atualizar os preços: rodar os três comandos acima e fazer commit de `site/dados/`.

## Rodar local

```bash
python -m http.server 8731 --directory site
```

## Limites conhecidos

- A ANP é semanal e por amostragem: só ~15% dos postos têm preço, e o preço tem de 1 a 4 semanas.
- O local do cadastro é informado pelo posto ou pelo fiscal; a ANP marca como "não validado".
- O servidor público do OSRM é de demonstração. Para uso real, hospedar o próprio ou usar um pago.
- Avaliação e horário de funcionamento ainda não existem (precisariam do Google Places).

## Status e projeção

Protótipo no ar, só com dados públicos oficiais. Próximos passos, em ordem:

1. Medir uso real (quais cidades são buscadas) antes de investir em mais dados.
2. Preço enviado por usuário, com o QR Code da nota fiscal (NFC-e) como prova, para cobrir as cidades
   e semanas que a ANP não cobre.
3. Atualização semanal automática dos dados pelo próprio GitHub Actions.
4. Alerta de preço: avisar quando o posto escolhido baixar.
