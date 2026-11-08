"""Baixa o cadastro oficial de postos da ANP (API Revendedores) e a lista de municípios do IBGE.

Uso:
    python -I dados/cadastro.py            # UFs que faltam ou têm mais de 7 dias (~45 mil postos)
    python -I dados/cadastro.py --tudo     # baixa todas de novo
    python -I dados/cadastro.py PR SP      # só essas

API documentada pela ANP, sem chave:
https://www.gov.br/anp/pt-br/centrais-de-conteudo/paineis-dinamicos-da-anp/paineis-dinamicos-do-abastecimento/api-revendedores-manual-usuario.pdf
Traz todo posto autorizado, com localização, bandeira e combustíveis. NÃO traz preço.
Saída: dados/brutos/cadastro/<UF>.json e dados/brutos/municipios_ibge.json
"""
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request

AQUI = os.path.dirname(os.path.abspath(__file__))
PASTA = os.path.join(AQUI, "brutos", "cadastro")
API = "https://revendedoresapi.anp.gov.br/v1/combustivel"
IBGE = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios?view=nivelado"
UFS = "AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO".split()
CAMPOS = ["cnpj", "razaoSocial", "endereco", "complemento", "bairro", "cep", "uf", "municipio",
          "distribuidora", "produtos", "latitude", "longitude", "origemInformacao", "dataObtencao"]


PAUSA = 20   # segundos entre pedidos: a API responde 429 se vier rápido demais


def pegar(url, tentativas=4):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "vale-o-desvio-prototipo/0.1"})
            with urllib.request.urlopen(req, timeout=300) as r:
                corpo = r.read()
            if corpo[:2] == b"\x1f\x8b":   # o IBGE manda gzip mesmo sem pedir
                corpo = gzip.decompress(corpo)
            return json.loads(corpo)
        except urllib.error.HTTPError as e:
            espera = int(e.headers.get("Retry-After") or 0) or 120 * (i + 1)
            print(f"   HTTP {e.code}, esperando {espera}s")
            time.sleep(espera)
        except Exception as e:
            print("   erro:", e)
            time.sleep(30 * (i + 1))
    raise SystemExit("Falhou: " + url + " (rode de novo depois: ele continua de onde parou)")


def baixar_uf(uf):
    linhas, pagina = [], 1
    while True:
        d = pegar(f"{API}?uf={uf}&numeropagina={pagina}")
        linhas += [{k: r.get(k) for k in CAMPOS} for r in d.get("data") or []]
        total_pag = (d.get("searchPageFilter") or {}).get("totalPagina") or 1
        if pagina >= total_pag:
            return linhas
        pagina += 1
        time.sleep(PAUSA)


def main():
    os.makedirs(PASTA, exist_ok=True)
    pedidas = [u.upper() for u in sys.argv[1:] if u != "--tudo"]
    ufs = pedidas or UFS
    for uf in ufs:
        caminho = os.path.join(PASTA, uf + ".json")
        frescos = os.path.exists(caminho) and time.time() - os.path.getmtime(caminho) < 7 * 86400
        if frescos and not pedidas and "--tudo" not in sys.argv:
            continue   # já baixado nesta semana: retoma de onde parou
        linhas = baixar_uf(uf)
        with open(os.path.join(PASTA, uf + ".json"), "w", encoding="utf-8") as f:
            json.dump(linhas, f, ensure_ascii=False)
        print(f"{uf}: {len(linhas)} postos, {sum(1 for r in linhas if r['latitude'])} com localização", flush=True)
        time.sleep(PAUSA)
    caminho = os.path.join(AQUI, "brutos", "municipios_ibge.json")
    if not os.path.exists(caminho):
        muns = [{"nome": m["municipio-nome"], "uf": m["UF-sigla"]} for m in pegar(IBGE)]
        with open(caminho, "w", encoding="utf-8") as f:
            json.dump(muns, f, ensure_ascii=False)
        print(f"IBGE: {len(muns)} municípios")


if __name__ == "__main__":
    main()
