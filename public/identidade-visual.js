export function preencherIdentidade(elemento, nome, foto) {
  const palavras = nome.trim().normalize('NFC').split(/\s+/u);
  const iniciais = palavras.length > 1 ? [palavras[0], palavras.at(-1)] : palavras;
  elemento.querySelector('[data-avatar]').textContent = iniciais
    .map(palavra => Array.from(palavra)[0]).join('').toLocaleUpperCase('pt-BR');
  if (foto) {
    const imagem = document.createElement('img');
    imagem.alt = '';
    imagem.src = foto;
    elemento.querySelector('[data-avatar]').replaceChildren(imagem);
  }
  const rotulo = elemento.querySelector('[data-nome]');
  rotulo.textContent = nome;
  rotulo.title = nome;
}
