"""Baixa as ultimas N planilhas semanais de precos por posto da ANP para dados/brutos/.

Uso: python -I dados/baixar.py [N=4]
Apaga planilhas mais antigas que as N baixadas, para o preparar.py so juntar semanas recentes.
"""
import os
import re
import sys
import urllib.request

PAGINA = ("https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/"
          "levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas")
PASTA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "brutos")
UA = {"User-Agent": "Mozilla/5.0"}


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    html = urllib.request.urlopen(urllib.request.Request(PAGINA, headers=UA), timeout=60).read().decode("utf-8", "ignore")
    links = re.findall(r'href="([^"]+/revendas_lpc_[^"]+\.xlsx)"', html)
    links = list(dict.fromkeys(links))[:n]   # a pagina lista da semana mais nova para a mais velha
    os.makedirs(PASTA, exist_ok=True)
    manter = set()
    for url in links:
        nome = url.rsplit("/", 1)[1]
        manter.add(nome)
        destino = os.path.join(PASTA, nome)
        if os.path.exists(destino):
            print("ja tenho", nome)
            continue
        print("baixando", nome)
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r, open(destino, "wb") as f:
            f.write(r.read())
    for velho in os.listdir(PASTA):
        if velho.startswith("revendas_lpc_") and velho not in manter:
            os.remove(os.path.join(PASTA, velho))
            print("removido (antigo)", velho)


if __name__ == "__main__":
    main()
