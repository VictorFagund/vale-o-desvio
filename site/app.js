/* Vale o Desvio: qual posto compensa de verdade, contando o caminho até ele. */
"use strict";

const COMBUSTIVEIS = [
  ["gasolina", "Gasolina"], ["etanol", "Etanol"], ["aditivada", "Aditivada"],
  ["diesel", "Diesel"], ["diesel_s10", "Diesel S10"], ["diesel_s500", "Diesel S500"], ["gnv", "GNV"],
];
const DIAS_PRECO_VELHO = 14;   // a ANP é semanal: até 2 semanas é o normal dela; depois disso, âmbar
const EMPATE = 1.0;            // diferença (R$) abaixo da qual "dá na mesma"
const FATOR_RUA = 1.35;        // linha reta → rua, enquanto a rota real não chega
const OSRM = "https://router.project-osrm.org/table/v1/driving/";

const $ = (s) => document.querySelector(s);
const brl = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const km1 = (v) => (v < 10 ? v.toFixed(1) : Math.round(v)).toString().replace(".", ",") + " km";

const estado = {
  indice: null, cidade: null, postos: [], combustivel: "gasolina",
  litros: 40, consumo: 10, hora: 15, origem: null, rotas: new Map(), selecionado: null,
};
let mapa, marcadores = new Map(), marcadorVoce = null, pedidoRotas = 0;

function guardar(k, v) { try { localStorage.setItem("vod:" + k, v); } catch (_) {} }
function ler(k) { try { return localStorage.getItem("vod:" + k); } catch (_) { return null; } }

function distanciaReta(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ANP manda só a data ("2026-10-30"); a nota fiscal manda data e hora ("2026-11-06T17:47:05Z").
function idadeTexto(iso) {
  if (iso.includes("T")) {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso)) / 6e4));
    const quando = min < 60 ? `${Math.max(1, min)} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} dias`;
    return { texto: `nota fiscal de há ${quando}`, velho: min > 48 * 60 };
  }
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const d = Math.round((hoje - new Date(iso + "T00:00:00")) / 864e5);
  const quando = d <= 0 ? "coletado hoje" : d === 1 ? "coletado ontem" : `coletado há ${d} dias`;
  return { texto: `ANP, ${quando}`, velho: d > DIAS_PRECO_VELHO };
}

/* ---------- cálculo ---------- */
function calcular() {
  const comb = estado.combustivel, L = estado.litros, kmL = estado.consumo;
  const temMapa = estado.postos.some((p) => p.lat != null);
  const linhas = [];
  for (const p of estado.postos) {
    const preco = p.precos[comb];
    if (!preco) continue;
    const l = { p, preco: preco.valor, data: preco.data };
    if (temMapa && p.lat != null && estado.origem) {
      const r = estado.rotas.get(p.cnpj);
      if (r) { l.km = r.km; l.min = r.min; l.real = true; }
      else { l.km = distanciaReta(estado.origem, p) * FATOR_RUA; l.min = l.km / 30 * 60; l.real = false; }
      l.custoCaminho = (2 * l.km / kmL) * l.preco;            // combustível da ida e volta
      l.custoTempo = (2 * l.min / 60) * estado.hora;          // o tempo da ida e volta também custa
      l.total = l.preco * L + l.custoCaminho + l.custoTempo;
    }
    linhas.push(l);
  }
  // Postos do cadastro da ANP sem preço deste combustível: só aparecem no mapa, em cinza.
  const semPreco = estado.postos.filter((p) => !p.precos[comb] && p.lat != null && (!p.vende || p.vende.includes(comb)));
  const comDistancia = linhas.filter((l) => l.total != null);
  if (!comDistancia.length) {
    linhas.sort((a, b) => a.preco - b.preco);
    return { linhas, modo: "so-preco", semPreco };
  }
  const perto = comDistancia.reduce((a, b) => (b.km < a.km ? b : a));
  for (const l of comDistancia) {
    l.economia = perto.total - l.total;
    l.veredito = l === perto ? "perto" : l.economia >= EMPATE ? "compensa" : l.economia <= -EMPATE ? "nao" : "empata";
  }
  comDistancia.sort((a, b) => a.total - b.total);
  const semLocal = linhas.filter((l) => l.total == null).sort((a, b) => a.preco - b.preco);
  return { linhas: comDistancia.concat(semLocal), modo: "completo", perto, semPreco };
}

/* ---------- desenho ---------- */
function vereditoTexto(l) {
  if (l.veredito === "perto") return ["v-empata", "o mais perto"];
  if (l.veredito === "compensa") return ["v-compensa", "economiza " + brl(l.economia)];
  if (l.veredito === "nao") return ["v-nao", "perde " + brl(-l.economia)];
  if (l.veredito === "empata") return ["v-empata", "dá na mesma"];
  return ["", ""];
}

function desenhar() {
  const { linhas, modo, perto, semPreco } = calcular();
  const nomeComb = COMBUSTIVEIS.find((c) => c[0] === estado.combustivel)[1];
  const lista = $("#lista");
  lista.innerHTML = "";
  const escolhidoSemPreco = semPreco.find((p) => p.cnpj === estado.selecionado);

  if (!linhas.length) {
    if (escolhidoSemPreco) desenharSemPreco(escolhidoSemPreco); else $("#destaque").innerHTML = "";
    $("#titulo-lista").textContent = semPreco.length ? `${semPreco.length} postos na cidade, sem preço da ANP` : "";
    lista.innerHTML = `<li><p class="aviso">A ANP não pesquisa preço de ${nomeComb.toLowerCase()} em ${estado.cidade.cidade}${semPreco.length ? ". Os postos estão no mapa, em cinza, para você ver onde ficam." : "."}</p></li>`;
    for (const p of perto1(semPreco)) lista.appendChild(itemSemPreco(p));
    desenharMarcadores([], null, semPreco);
    return;
  }

  const melhor = linhas[0];
  if (escolhidoSemPreco) desenharSemPreco(escolhidoSemPreco);
  else desenharDestaque(melhor, modo, perto, linhas.length);
  $("#titulo-lista").textContent = modo === "completo"
    ? `${linhas.length} postos com preço, do que sai mais barato no total para o mais caro`
    : `${linhas.length} postos por preço (sem mapa para esta cidade ainda)`;

  for (const l of linhas) {
    const li = document.createElement("li");
    li.className = "item" + (estado.selecionado === l.p.cnpj ? " ativo" : "");
    li.dataset.cnpj = l.p.cnpj;
    const idade = idadeTexto(l.data);
    const [classe, txt] = vereditoTexto(l);
    const dist = l.km != null ? `${km1(l.km)}${l.real ? "" : " ≈"} · ` : "";
    li.innerHTML = `
      <span class="nome"></span>
      <span class="preco">${brl(l.preco)}</span>
      <span class="meta">${dist}<span class="${idade.velho ? "velho" : ""}">${idade.texto}</span></span>
      <span class="veredito ${classe}">${txt}</span>`;
    li.querySelector(".nome").textContent = l.p.nome;
    li.addEventListener("click", () => selecionar(l.p.cnpj, true));
    lista.appendChild(li);
  }
  if (semPreco.length) {
    const li = document.createElement("li");
    li.innerHTML = `<p class="aviso">Mais ${semPreco.length} postos na cidade sem preço da ANP para ${nomeComb.toLowerCase()}. Estão no mapa em cinza: a ANP pesquisa só uma amostra.</p>`;
    lista.appendChild(li);
  }
  desenharMarcadores(linhas, melhor, semPreco);
}

// Sem preço, o que ajuda é a ordem de distância de quem está procurando.
function perto1(ps) {
  const o = estado.origem;
  return o ? [...ps].sort((a, b) => distanciaReta(o, a) - distanciaReta(o, b)) : ps;
}

function itemSemPreco(p) {
  const li = document.createElement("li");
  li.className = "item sem-preco" + (estado.selecionado === p.cnpj ? " ativo" : "");
  li.dataset.cnpj = p.cnpj;
  const dist = estado.origem ? km1(distanciaReta(estado.origem, p) * FATOR_RUA) + " ≈ · " : "";
  li.innerHTML = `<span class="nome"></span><span class="preco">sem preço</span><span class="meta"></span>`;
  li.querySelector(".nome").textContent = p.nome;
  li.querySelector(".meta").textContent = dist + (p.bandeira || "");
  li.addEventListener("click", () => selecionar(p.cnpj, true));
  return li;
}

function desenharSemPreco(p) {
  const box = $("#destaque");
  box.className = "destaque neutro";
  const destino = `${p.lat},${p.lon}`;
  const nomes = Object.fromEntries(COMBUSTIVEIS);
  const vende = (p.vende || []).map((k) => nomes[k]).filter(Boolean).join(", ");
  box.innerHTML = `
    <div class="rotulo">Sem preço da ANP</div>
    <h3></h3>
    <div class="sub"></div>
    <p class="aviso"></p>
    <div class="acoes"><a href="https://www.google.com/maps/dir/?api=1&destination=${destino}" target="_blank" rel="noopener">Ir pelo Google Maps</a><a class="secundario" href="https://waze.com/ul?ll=${destino}&navigate=yes" target="_blank" rel="noopener">Waze</a></div>`;
  box.querySelector("h3").textContent = p.nome;
  box.querySelector(".sub").textContent = [[p.endereco + (p.numero ? ", " + p.numero : ""), p.bairro].filter(Boolean).join(" · "), p.bandeira].filter(Boolean).join(" · ");
  box.querySelector(".aviso").textContent = (vende ? `Vende ${vende}. ` : "") + "A ANP não pesquisou o preço deste posto nas últimas semanas. Local e combustíveis vêm do cadastro oficial da ANP.";
}

function desenharDestaque(l, modo, perto, n) {
  const box = $("#destaque");
  const idade = idadeTexto(l.data);
  const end = [l.p.endereco + (l.p.numero ? ", " + l.p.numero : ""), l.p.bairro].filter(Boolean).join(" · ");
  const temLocal = l.p.lat != null;
  const destino = temLocal ? `${l.p.lat},${l.p.lon}` : encodeURIComponent(`${l.p.endereco} ${l.p.numero}, ${l.p.cidade}`);
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${destino}`;
  const waze = temLocal ? `https://waze.com/ul?ll=${destino}&navigate=yes` : `https://waze.com/ul?q=${destino}&navigate=yes`;

  let rotulo = "Mais barato da lista", numeros = "";
  box.className = "destaque neutro";
  if (modo === "completo") {
    if (l.veredito === "compensa") { rotulo = "Compensa ir"; box.className = "destaque"; }
    else if (l.veredito === "perto") rotulo = "O mais perto já é o melhor";
    else rotulo = "Nenhum desvio compensa";
    numeros = `
      <div><b>${brl(l.preco)}</b><span>por litro</span></div>
      <div><b>${km1(l.km)}${l.real ? "" : " ≈"}</b><span>${Math.max(1, Math.round(l.min))} min de carro</span></div>
      <div><b>${brl(l.total)}</b><span>${estado.litros} L + ida e volta + tempo</span></div>`;
    if (l.veredito === "compensa") numeros += `<div><b class="v-compensa">${brl(l.economia)}</b><span>a menos que o mais perto</span></div>`;
  } else {
    numeros = `<div><b>${brl(l.preco)}</b><span>por litro</span></div>`;
  }
  box.innerHTML = `
    <div class="rotulo"></div>
    <h3></h3>
    <div class="sub"></div>
    <div class="numeros">${numeros}</div>
    <div class="acoes"><a href="${gmaps}" target="_blank" rel="noopener">Ir pelo Google Maps</a><a class="secundario" href="${waze}" target="_blank" rel="noopener">Waze</a></div>`;
  box.querySelector(".rotulo").textContent = rotulo;
  box.querySelector("h3").textContent = l.p.nome;
  const sub = box.querySelector(".sub");
  sub.textContent = `${end}${l.p.bandeira ? " · " + l.p.bandeira : ""} · `;
  const s = document.createElement("span");
  s.className = idade.velho ? "velho" : "";
  s.textContent = idade.texto;
  sub.appendChild(s);
  if (l.p.precisao === "cep" || l.p.precisao === "bairro") sub.append(" · local aproximado");
}

/* ---------- mapa ---------- */
function estiloMapa() {
  const escuro = matchMedia("(prefers-color-scheme: dark)").matches;
  return "https://tiles.openfreemap.org/styles/" + (escuro ? "dark" : "positron");
}

function iniciarMapa() {
  mapa = new maplibregl.Map({ container: "mapa", style: estiloMapa(), center: [-49.27, -25.43], zoom: 11, attributionControl: { compact: true } });
  mapa.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  mapa.on("click", (e) => definirOrigem({ lat: e.lngLat.lat, lon: e.lngLat.lng }, "manual"));
}

function desenharMarcadores(linhas, melhor, semPreco = []) {
  for (const m of marcadores.values()) m.remove();
  marcadores.clear();
  // Cinza primeiro, para os preços ficarem por cima.
  for (const p of semPreco) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "ponto-cinza" + (estado.selecionado === p.cnpj ? " ativo" : "");
    el.title = `${p.nome} (sem preço da ANP)`;
    el.setAttribute("aria-label", el.title);
    el.addEventListener("click", (ev) => { ev.stopPropagation(); selecionar(p.cnpj, false); });
    marcadores.set(p.cnpj, new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(mapa));
  }
  for (const l of linhas) {
    if (l.p.lat == null) continue;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "pino" +
      (l.veredito === "compensa" ? " compensa" : l.veredito === "nao" ? " nao" : "") +
      (l === melhor ? " melhor" : "") + (estado.selecionado === l.p.cnpj ? " ativo" : "");
    el.textContent = l.preco.toFixed(2).replace(".", ",");
    el.title = l.p.nome;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); selecionar(l.p.cnpj, false); });
    const m = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -6] }).setLngLat([l.p.lon, l.p.lat]).addTo(mapa);
    marcadores.set(l.p.cnpj, m);
  }
}

function selecionar(cnpj, voar) {
  estado.selecionado = cnpj;
  desenhar();
  const p = estado.postos.find((x) => x.cnpj === cnpj);
  if (voar && p && p.lat != null) mapa.flyTo({ center: [p.lon, p.lat], zoom: Math.max(mapa.getZoom(), 14) });
  const item = document.querySelector(`.item[data-cnpj="${cnpj}"]`);
  if (item && !voar) item.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ---------- origem e rotas ---------- */
function centroDaCidade() {
  const c = estado.postos.filter((p) => p.lat != null);
  if (!c.length) return null;
  const lats = c.map((p) => p.lat).sort((a, b) => a - b), lons = c.map((p) => p.lon).sort((a, b) => a - b);
  return { lat: lats[lats.length >> 1], lon: lons[lons.length >> 1] };   // mediana: ignora geocodificação torta
}

function definirOrigem(pt, tipo) {
  estado.origem = { ...pt, tipo };
  if (!marcadorVoce) {
    const el = document.createElement("div"); el.className = "voce"; el.title = "Você (arraste)";
    marcadorVoce = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([pt.lon, pt.lat]).addTo(mapa);
    marcadorVoce.on("dragend", () => { const ll = marcadorVoce.getLngLat(); definirOrigem({ lat: ll.lat, lon: ll.lng }, "manual"); });
  } else marcadorVoce.setLngLat([pt.lon, pt.lat]);
  textoOrigem();
  estado.rotas.clear();
  desenhar();
  buscarRotas();
}

function textoOrigem() {
  const o = $("#origem");
  const temMapa = estado.postos.some((p) => p.lat != null);
  if (!temMapa) { o.textContent = ""; return; }
  const onde = { gps: "Saindo da sua localização.", manual: "Saindo do ponto que você marcou.", centro: `Saindo do centro de ${estado.cidade.cidade}.` }[estado.origem?.tipo] || "";
  o.innerHTML = "";
  o.append(onde + " ");
  if (navigator.geolocation && estado.origem?.tipo !== "gps") {
    const b = document.createElement("button"); b.textContent = "Usar minha localização"; b.onclick = usarGps; o.append(b, " ou toque no mapa.");
  } else o.append("Toque no mapa para mudar.");
}

function usarGps() {
  navigator.geolocation.getCurrentPosition((pos) => {
    const pt = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const c = centroDaCidade();
    if (c && distanciaReta(c, pt) > 60) {
      $("#origem").textContent = `Você está a ${Math.round(distanciaReta(c, pt))} km de ${estado.cidade.cidade}. Toque no mapa para escolher o ponto de saída.`;
      return;
    }
    definirOrigem(pt, "gps");
    mapa.flyTo({ center: [pt.lon, pt.lat], zoom: 13 });
  }, () => { $("#origem").textContent = "Não deu para pegar sua localização. Toque no mapa para marcar de onde você sai."; });
}

async function buscarRotas() {
  const o = estado.origem;
  if (!o) return;
  const meu = ++pedidoRotas;
  await new Promise((r) => setTimeout(r, 350));       // espera o usuário parar de mexer
  if (meu !== pedidoRotas) return;
  const alvos = estado.postos.filter((p) => p.lat != null && Object.keys(p.precos).length)
    .map((p) => [p, distanciaReta(o, p)]).sort((a, b) => a[1] - b[1]).slice(0, 80).map((x) => x[0]);
  if (!alvos.length) return;
  const coords = [[o.lon, o.lat], ...alvos.map((p) => [p.lon, p.lat])].map((c) => c.map((n) => n.toFixed(5)).join(",")).join(";");
  try {
    const r = await fetch(`${OSRM}${coords}?sources=0&annotations=distance,duration`);
    const j = await r.json();
    if (meu !== pedidoRotas || j.code !== "Ok") return;
    alvos.forEach((p, i) => {
      const d = j.distances[0][i + 1], t = j.durations[0][i + 1];
      if (d != null) estado.rotas.set(p.cnpj, { km: d / 1000, min: t / 60 });
    });
    desenhar();
  } catch (_) { /* fica com a estimativa (marcada com ≈) */ }
}

/* ---------- cidade ---------- */
async function abrirCidade(info) {
  estado.cidade = info;
  estado.selecionado = null;
  guardar("cidade", info.arquivo);
  $("#cidade").value = `${info.cidade} - ${info.uf}`;
  const r = await fetch(`dados/cidade/${info.arquivo}.json`);
  const dados = await r.json();
  estado.postos = dados.postos;
  estado.centro = dados.centro ? { lat: dados.centro[0], lon: dados.centro[1] } : null;
  desenharRodape(info);

  // Mostra só combustíveis que essa cidade tem (com preço; se não há preço nenhum, o que os postos vendem).
  let tem = new Set(estado.postos.flatMap((p) => Object.keys(p.precos)));
  if (!tem.size) tem = new Set(estado.postos.flatMap((p) => p.vende || []));
  if (!tem.size) tem = new Set(["gasolina"]);
  if (!tem.has(estado.combustivel)) estado.combustivel = tem.has("gasolina") ? "gasolina" : [...tem][0];
  desenharCombustiveis(tem);

  const c = estado.centro || centroDaCidade();
  if (marcadorVoce) { marcadorVoce.remove(); marcadorVoce = null; }
  estado.origem = null; estado.rotas.clear();
  if (c) {
    const pts = estado.postos.filter((p) => p.lat != null && distanciaReta(c, p) < 40);
    const b = new maplibregl.LngLatBounds();
    pts.forEach((p) => b.extend([p.lon, p.lat]));
    mapa.fitBounds(b, { padding: 50, duration: 0, maxZoom: 14 });   // cidade com 1-2 postos não vira zoom de rua
    definirOrigem(c, "centro");
  } else {
    textoOrigem();
    desenhar();
  }
}

function desenharCombustiveis(tem) {
  const seg = $("#combustivel");
  seg.innerHTML = "";
  for (const [k, nome] of COMBUSTIVEIS) {
    if (!tem.has(k)) continue;
    const b = document.createElement("button");
    b.type = "button"; b.role = "radio"; b.textContent = nome;
    b.setAttribute("aria-checked", String(k === estado.combustivel));
    b.onclick = () => { estado.combustivel = k; guardar("comb", k); desenharCombustiveis(tem); desenhar(); };
    seg.appendChild(b);
  }
}

function desenharRodape(info) {
  const comum = " Rotas: OSRM. Mapa: OpenStreetMap / OpenFreeMap.";
  if (info.fonte === "nota") {
    const quando = new Date(info.atualizado).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    $("#rodape").innerHTML = `Preços: notas fiscais emitidas pelos postos, via <a href="https://menorpreco.notaparana.pr.gov.br/" target="_blank" rel="noopener">Menor Preço (Nota Paraná)</a>, num raio de ${info.raio_km} km. Dados buscados em ${quando}. É o preço que alguém pagou de verdade, mas pode ter mudado depois da última nota.` + comum;
  } else {
    $("#rodape").innerHTML = `Preços: <a href="https://www.gov.br/anp/pt-br/assuntos/precos-e-defesa-da-concorrencia/precos/levantamento-de-precos-de-combustiveis-ultimas-semanas-pesquisadas" target="_blank" rel="noopener">levantamento semanal da ANP</a>, coletas de ${dataBr(estado.indice.coleta_de)} a ${dataBr(estado.indice.coleta_ate)}. É uma amostra: nem todo posto tem preço, e o preço pode ter mudado desde a coleta. Postos e localização: <a href="https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/dados-cadastrais-dos-revendedores-varejistas-de-combustiveis-automotivos" target="_blank" rel="noopener">cadastro oficial da ANP</a>.` + comum;
  }
}

function dataBr(iso) { const [a, m, d] = iso.split("-"); return `${d}/${m}/${a}`; }

async function iniciar() {
  iniciarMapa();
  estado.combustivel = ler("comb") || "gasolina";
  for (const [id, chave] of [["#litros", "litros"], ["#consumo", "consumo"], ["#hora", "hora"]]) {
    const el = $(id), salvo = parseFloat(ler(chave));
    if (salvo >= 0 && ler(chave) !== null) el.value = salvo;
    estado[chave] = parseFloat(el.value);
    el.addEventListener("input", () => {
      const v = parseFloat(el.value.replace(",", "."));
      if (v > 0 || (chave === "hora" && v === 0)) { estado[chave] = v; guardar(chave, v); desenhar(); }
    });
  }

  estado.indice = await (await fetch("dados/cidades.json")).json();
  const dl = $("#lista-cidades");
  for (const c of estado.indice.cidades) {
    const o = document.createElement("option");
    o.value = `${c.cidade} - ${c.uf}`;
    o.label = c.com_preco ? `${c.com_preco} com preço de ${c.postos} postos` : `${c.postos} postos, sem preço da ANP`;
    dl.appendChild(o);
  }
  $("#cidade").addEventListener("change", (e) => {
    const c = estado.indice.cidades.find((x) => `${x.cidade} - ${x.uf}` === e.target.value);
    if (c) abrirCidade(c);
  });

  const salvo = ler("cidade");
  const inicial = estado.indice.cidades.find((c) => c.arquivo === salvo)
    || estado.indice.cidades.filter((c) => c.com_mapa).sort((a, b) => (b.com_preco || 0) - (a.com_preco || 0))[0]
    || estado.indice.cidades[0];
  abrirCidade(inicial);   // marcadores são DOM: não precisam esperar o estilo do mapa carregar
}

iniciar();
