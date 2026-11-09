/* Configuração do site.
 *
 * GOOGLE_KEY: chave da "Street View Static API" para a foto da fachada na ficha do posto.
 * Vazia = sem foto (a capa usa a cor da bandeira).
 * A chave fica visível no site (é assim com toda chave de mapa no navegador). O que protege é a
 * restrição no Google Cloud: só aceitar pedidos de victorfagund.github.io e localhost, só para a
 * Street View Static API, e uma cota diária baixa para nunca passar da faixa grátis.
 */
window.VOD_CONFIG = {
  GOOGLE_KEY: "",
};
