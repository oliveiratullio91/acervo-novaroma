export function filtrosLeitores(origem, pagina = origem.get('pagina')) {
  const filtros = new URLSearchParams();
  const nome = origem.get('nome')?.trim();
  if (nome) filtros.set('nome', nome);
  if (pagina && String(pagina) !== '1' && /^[1-9]\d{0,8}$/.test(pagina)) filtros.set('pagina', pagina);
  return filtros;
}

export function caminhoLeitores(filtros, id) {
  const caminho = '/conta/leitores/' + (id ? encodeURIComponent(id) + '/' : '');
  return filtros.size ? caminho + '?' + filtros : caminho;
}
