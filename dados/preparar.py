"""Transforma as planilhas semanais da ANP + o cadastro oficial de postos em JSON para o site.

Uso:
    python -I dados/preparar.py                      # precos + cadastro (todas as cidades)
    python -I dados/preparar.py --geo "CURITIBA/PR"  # + Nominatim p/ quem ficou sem local oficial

- Junta as planilhas de dados/brutos/ (revendas_lpc_*.xlsx). Para cada posto e
  combustivel fica o preco MAIS RECENTE, com a data da coleta.
- Local: primeiro o do cadastro da ANP (dados/brutos/cadastro/, baixado por cadastro.py).
  Postos do cadastro sem preco tambem entram (cinza no mapa).
- Plano B de local: Nominatim (OpenStreetMap), 1 pedido/segundo, com cache em
  dados/geocache.json para nunca repetir a mesma consulta.
- Saida: site/dados/cidades.json (indice) e site/dados/cidade/<UF>-<NOME>.json
"""
import argparse
import glob
import json
import math
import os
import re
import statistics
import time
import unicodedata
import urllib.parse
import urllib.request

import openpyxl

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
SAIDA = os.path.join(RAIZ, "site", "dados")
CACHE = os.path.join(AQUI, "geocache.json")

UF = {
    "ACRE": "AC", "ALAGOAS": "AL", "AMAPA": "AP", "AMAZONAS": "AM", "BAHIA": "BA",
    "CEARA": "CE", "DISTRITO FEDERAL": "DF", "ESPIRITO SANTO": "ES", "GOIAS": "GO",
    "MARANHAO": "MA", "MATO GROSSO": "MT", "MATO GROSSO DO SUL": "MS",
    "MINAS GERAIS": "MG", "PARA": "PA", "PARAIBA": "PB", "PARANA": "PR",
    "PERNAMBUCO": "PE", "PIAUI": "PI", "RIO DE JANEIRO": "RJ",
    "RIO GRANDE DO NORTE": "RN", "RIO GRANDE DO SUL": "RS", "RONDONIA": "RO",
    "RORAIMA": "RR", "SANTA CATARINA": "SC", "SAO PAULO": "SP", "SERGIPE": "SE",
    "TOCANTINS": "TO",
}

# Nome curto usado no site. GLP (botijao) fica de fora: nao e abastecimento.
PRODUTOS = {
    "GASOLINA COMUM": "gasolina",
    "GASOLINA ADITIVADA": "aditivada",
    "ETANOL": "etanol",
    "DIESEL S10": "diesel_s10",
    "DIESEL S500": "diesel_s500",
    "GNV": "gnv",
}


def sem_acento(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def chave_estado(nome):
    return UF.get(sem_acento(nome).upper().strip(), nome[:2].upper())


def titulo(s):
    if not s:
        return ""
    pequenas = {"de", "da", "do", "das", "dos", "e"}
    partes = str(s).strip().lower().split()
    return " ".join(p if (i and p in pequenas) else p.capitalize() for i, p in enumerate(partes))


def ler_planilhas():
    arquivos = sorted(glob.glob(os.path.join(AQUI, "brutos", "revendas_lpc_*.xlsx")))
    if not arquivos:
        raise SystemExit("Nenhuma planilha em dados/brutos/. Rode baixar.py antes.")
    postos = {}
    for arq in arquivos:
        ws = openpyxl.load_workbook(arq, read_only=True).active
        cab = None
        for linha in ws.iter_rows(values_only=True):
            if cab is None:
                if linha and linha[0] == "CNPJ":
                    cab = [sem_acento(str(c)).upper() for c in linha]
                continue
            r = dict(zip(cab, linha))
            prod = PRODUTOS.get(r.get("PRODUTO"))
            if not prod or r.get("PRECO DE REVENDA") is None:
                continue
            cnpj = str(r["CNPJ"]).zfill(14)
            p = postos.setdefault(cnpj, {
                "cnpj": cnpj,
                "nome": titulo(r.get("FANTASIA") or r.get("RAZAO")),
                "razao": titulo(r.get("RAZAO")),
                "endereco": titulo(r.get("ENDERECO")),
                "numero": str(r.get("NUMERO") or "").strip(),
                "bairro": titulo(r.get("BAIRRO")),
                "cep": str(r.get("CEP") or "").zfill(8),
                "cidade": str(r.get("MUNICIPIO")).strip(),
                "uf": chave_estado(str(r.get("ESTADO"))),
                "bandeira": titulo(r.get("BANDEIRA")),
                "precos": {},
            })
            data = r["DATA DA COLETA"].date().isoformat()
            atual = p["precos"].get(prod)
            if atual is None or data > atual["data"]:
                p["precos"][prod] = {"valor": round(float(r["PRECO DE REVENDA"]), 2), "data": data}
    return postos, [os.path.basename(a) for a in arquivos]


def carregar_cache():
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def salvar_cache(c):
    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump(c, f, ensure_ascii=False, indent=0)


ULTIMO = [0.0]


def nominatim(params):
    espera = 1.1 - (time.time() - ULTIMO[0])
    if espera > 0:
        time.sleep(espera)
    params = {**params, "format": "jsonv2", "limit": 1, "countrycodes": "br"}
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "vale-o-desvio-prototipo/0.1"})
    ULTIMO[0] = time.time()
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.load(resp)
    return res[0] if res else None


def limites_cidade(cidade, uf, cache):
    """Caixa (sul, norte, oeste, leste) do municipio, para rejeitar rua homonima de outra cidade."""
    k = "limites|" + cidade + "|" + uf
    if k not in cache:
        r = nominatim({"city": cidade, "state": uf_nome(uf)})
        cache[k] = [float(x) for x in r["boundingbox"]] if r else None
    return cache[k]


def uf_nome(uf):
    return {v: k for k, v in UF.items()}.get(uf, uf).title()


def dentro(coord, caixa, folga=0.01):
    if not caixa or not coord:
        return bool(coord)
    s, n, o, l = caixa
    return s - folga <= coord[0] <= n + folga and o - folga <= coord[1] <= l + folga


def geocodificar(p, cache, caixa):
    """Tenta do mais preciso para o menos preciso e diz qual acertou (so vale se cair no municipio)."""
    numero = re.sub(r"[^0-9]", "", p["numero"]) if p["numero"] not in ("", "S/N", "SN") else ""
    rua = f"{numero} {p['endereco']}".strip()
    tentativas = [
        ("endereco", {"street": rua, "city": p["cidade"], "state": uf_nome(p["uf"])}),
        ("cep", {"postalcode": f"{p['cep'][:5]}-{p['cep'][5:]}", "city": p["cidade"]}),
        ("bairro", {"q": f"{p['bairro']}, {p['cidade']}, {p['uf']}"}),
    ]
    for precisao, params in tentativas:
        k = json.dumps(params, sort_keys=True, ensure_ascii=False)
        if k not in cache:
            try:
                r = nominatim(params)
            except Exception as e:  # rede caiu: nao grava no cache, tenta na proxima
                print("   erro:", e)
                continue
            cache[k] = [float(r["lat"]), float(r["lon"])] if r else None
        if dentro(cache[k], caixa):
            return cache[k], precisao
    return None, None


def arquivo_cidade(cidade, uf):
    return f"{uf}-{re.sub(r'[^A-Z0-9]+', '-', sem_acento(cidade).upper()).strip('-')}"


# ---------- cadastro oficial (API Revendedores da ANP, baixado por cadastro.py) ----------
# Produto do cadastro -> nome curto do site. Aviação, querosene etc. ficam de fora.
PRODUTOS_CADASTRO = [
    ("GASOLINA C COMUM ADITIVADA", "aditivada"), ("GASOLINA C COMUM", "gasolina"),
    ("ETANOL HIDRATADO", "etanol"), ("OLEO DIESEL B S10", "diesel_s10"),
    ("OLEO DIESEL B S500", "diesel_s500"), ("GAS NATURAL VEICULAR", "gnv"),
]
RAIO_MUNICIPIO_KM = 45   # ponto oficial mais longe que isso do centro dos postos da cidade = digitado errado


def km_entre(a, b):
    rad = math.pi / 180
    h = (math.sin((b[0] - a[0]) * rad / 2) ** 2
         + math.cos(a[0] * rad) * math.cos(b[0] * rad) * math.sin((b[1] - a[1]) * rad / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def vende(produtos):
    out = set()
    for pr in produtos or []:
        nome = sem_acento(pr.get("produto") or "").upper()
        for prefixo, curto in PRODUTOS_CADASTRO:
            if nome.startswith(prefixo):
                out.add(curto)
                break
    return sorted(out)


def coord_oficial(r):
    try:
        lat, lon = float(r["latitude"]), float(r["longitude"])
    except (TypeError, ValueError):
        return None
    return [round(lat, 6), round(lon, 6)] if -34 < lat < 6 and -74 < lon < -34 else None


def ler_cadastro():
    """{arquivo_cidade: {cnpj: linha}} só com postos que vendem combustível de carro."""
    por_cidade = {}
    for arq in glob.glob(os.path.join(AQUI, "brutos", "cadastro", "*.json")):
        with open(arq, encoding="utf-8") as f:
            for r in json.load(f):
                r["vende"] = vende(r.get("produtos"))
                if not r["vende"] or not r.get("municipio"):
                    continue
                r["coord"] = coord_oficial(r)
                por_cidade.setdefault(arquivo_cidade(r["municipio"], r["uf"]), {})[r["cnpj"].zfill(14)] = r
    # Descarta coordenada oficial longe demais do centro (mediana) dos postos da própria cidade.
    for postos in por_cidade.values():
        pts = [r["coord"] for r in postos.values() if r["coord"]]
        if not pts:
            continue
        centro = [statistics.median(p[0] for p in pts), statistics.median(p[1] for p in pts)]
        for r in postos.values():
            if r["coord"] and km_entre(centro, r["coord"]) > RAIO_MUNICIPIO_KM:
                r["coord"] = None
    return por_cidade


def nomes_ibge():
    caminho = os.path.join(AQUI, "brutos", "municipios_ibge.json")
    if not os.path.exists(caminho):
        return {}
    with open(caminho, encoding="utf-8") as f:
        return {arquivo_cidade(m["nome"], m["uf"]): m["nome"] for m in json.load(f)}


def posto_do_cadastro(r):
    end = (r.get("endereco") or "").strip()
    numero = ""
    if "," in end:
        end, numero = [x.strip() for x in end.rsplit(",", 1)]
        if numero.upper() in ("SN", "S/N", "0"):
            numero = ""
    return {
        "cnpj": r["cnpj"].zfill(14), "nome": titulo(r.get("razaoSocial")), "endereco": titulo(end),
        "numero": numero, "bairro": titulo(r.get("bairro")), "cidade": titulo(r.get("municipio")),
        "uf": r["uf"], "bandeira": bandeira(r.get("distribuidora")), "precos": {}, "vende": r["vende"],
    }


def bandeira(d):
    return "Bandeira branca" if (d or "").upper() == "BANDEIRA BRANCA" else titulo(d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geo", action="append", default=[], help='"CIDADE/UF", pode repetir')
    args = ap.parse_args()

    postos, fontes = ler_planilhas()
    cadastro = ler_cadastro()
    ibge = nomes_ibge()
    if not cadastro:
        print("Sem cadastro em dados/brutos/cadastro/ (rode cadastro.py): só os postos da pesquisa de preço.")
    por_cidade = {}
    for p in postos.values():
        por_cidade.setdefault(arquivo_cidade(p["cidade"], p["uf"]), []).append(p)
    nomes = {k: (p[0]["cidade"], p[0]["uf"]) for k, p in por_cidade.items()}
    for k, linhas in cadastro.items():
        r = next(iter(linhas.values()))
        nomes.setdefault(k, (r["municipio"], r["uf"]))

    os.makedirs(os.path.join(SAIDA, "cidade"), exist_ok=True)
    cache = carregar_cache()
    pedidas = {arquivo_cidade(*sem_acento(g).upper().split("/")) for g in args.geo}

    indice = []
    for nome_arq in sorted(nomes, key=lambda k: (nomes[k][1], k)):
        cidade, uf = nomes[nome_arq]
        lista = por_cidade.get(nome_arq, [])
        oficiais = cadastro.get(nome_arq, {})
        caminho = os.path.join(SAIDA, "cidade", nome_arq + ".json")
        anteriores = {}
        if os.path.exists(caminho):
            with open(caminho, encoding="utf-8") as f:
                anteriores = {q["cnpj"]: q for q in json.load(f)["postos"]}
        caixa = None
        if nome_arq in pedidas:
            caixa = limites_cidade(cidade, uf, cache)
            print(f"Geocodificando postos de {cidade}/{uf} sem local oficial (limites {caixa})...")
        for i, p in enumerate(lista):
            of = oficiais.get(p["cnpj"])
            if of:
                p["vende"] = of["vende"]
                p["bandeira"] = p["bandeira"] or bandeira(of.get("distribuidora"))
            antigo = anteriores.get(p["cnpj"])
            if of and of["coord"]:
                p["lat"], p["lon"], p["precisao"] = of["coord"][0], of["coord"][1], "oficial"
            elif (antigo and antigo.get("lat") is not None and antigo.get("precisao") != "oficial"
                  and dentro([antigo["lat"], antigo["lon"]], caixa)):
                p["lat"], p["lon"], p["precisao"] = antigo["lat"], antigo["lon"], antigo["precisao"]
            elif nome_arq in pedidas:
                coord, prec = geocodificar(p, cache, caixa)
                if coord:
                    p["lat"], p["lon"], p["precisao"] = coord[0], coord[1], prec
                print(f"   {i + 1}/{len(lista)} {p['nome'][:30]:30} {prec or 'NAO ACHOU'}")
                if i % 10 == 0:
                    salvar_cache(cache)
        # Postos do cadastro que a pesquisa de preço não visitou: entram só se têm local (vão para o mapa).
        com_preco = {p["cnpj"] for p in lista}
        for cnpj, r in oficiais.items():
            if cnpj not in com_preco and r["coord"]:
                q = posto_do_cadastro(r)
                q["lat"], q["lon"], q["precisao"] = r["coord"][0], r["coord"][1], "oficial"
                lista.append(q)
        if not lista:
            continue
        nome_bonito = ibge.get(nome_arq) or titulo(cidade)
        for p in lista:
            p["cidade"] = nome_bonito
        with open(caminho, "w", encoding="utf-8") as f:
            json.dump({"cidade": nome_bonito, "uf": uf, "postos": lista}, f, ensure_ascii=False)
        indice.append({
            "arquivo": nome_arq, "cidade": nome_bonito, "uf": uf, "postos": len(lista),
            "com_preco": len(com_preco), "com_mapa": sum(1 for p in lista if p.get("lat") is not None),
        })
    salvar_cache(cache)

    # Arquivo de cidade que não está mais no índice é sobra de rodada antiga.
    validos = {c["arquivo"] + ".json" for c in indice}
    for arq in os.listdir(os.path.join(SAIDA, "cidade")):
        if arq not in validos:
            os.remove(os.path.join(SAIDA, "cidade", arq))

    datas = sorted(pr["data"] for p in postos.values() for pr in p["precos"].values())
    with open(os.path.join(SAIDA, "cidades.json"), "w", encoding="utf-8") as f:
        json.dump({
            "fonte": "ANP - Levantamento de Precos de Combustiveis (amostral, semanal)",
            "planilhas": fontes, "coleta_de": datas[0], "coleta_ate": datas[-1],
            "cadastro": bool(cadastro), "cidades": indice,
        }, f, ensure_ascii=False)
    print(f"{len(indice)} cidades; {sum(c['com_preco'] for c in indice)} postos com preço, "
          f"{sum(c['postos'] for c in indice)} no total, {sum(c['com_mapa'] for c in indice)} no mapa; "
          f"coletas de {datas[0]} a {datas[-1]}")


if __name__ == "__main__":
    main()
