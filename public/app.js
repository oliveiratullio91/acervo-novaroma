import { solicitarApi } from '/api.js';
import { preencherIdentidade } from '/identidade-visual.js';
import { configurarCarrossel } from '/carrossel.js';

const el = id => document.getElementById(id);
const estante = el('estante');
const carrossel = el('carrossel-livros');
const parametros = new URLSearchParams(location.search);
const livrosDestaque = new Set([
  'dom-casmurro', 'a-metamorfose', 'alice', 'os-lusiadas', 'a-revolucao-dos-bichos', 'auto-da-compadecida'
]);

document.body.insertAdjacentHTML('beforeend', `
  <dialog id="dialogo-livro" aria-labelledby="livro-titulo">
    <div class="dialogo-conteudo">
      <button type="button" class="fechar" data-fechar aria-label="Fechar detalhes do livro">×</button>
      <div class="livro-detalhe">
        <div class="vitrine" id="livro-vitrine" aria-hidden="true"></div>
        <div class="livro-ficha">
          <p class="categoria" id="livro-categoria"></p>
          <h2 id="livro-titulo"></h2>
          <p id="livro-autor" class="autor"></p>
          <p id="livro-descricao" class="sinopse"></p>
          <p id="livro-disponibilidade" class="disponibilidade"></p>
        </div>
      </div>
      <p class="aviso" id="mensagem-livro" role="status" hidden></p>
      <div class="dialogo-acoes">
        <a class="botao botao-secundario" id="ver-reservas" href="/conta/reservas/" hidden>Ver minhas reservas</a>
        <button type="button" class="botao botao-secundario" id="quero-ler">Quero ler</button>
        <button type="button" class="botao" id="esperar" hidden>Entrar na fila</button>
        <button type="button" class="botao" id="reservar">Reservar exemplar</button>
      </div>
    </div>
  </dialog>
  <template id="modelo-livro">
    <article class="cartao-livro">
      <div class="vitrine" aria-hidden="true"></div>
      <div class="cartao-texto">
        <p class="categoria"></p>
        <h3><button type="button" class="livro-link"></button></h3>
        <p class="autor"></p>
        <p class="disponibilidade"></p>
      </div>
    </article>
  </template>
`);

const dialogoLivro = el('dialogo-livro');
const atualizarCarrossel = carrossel && configurarCarrossel(carrossel, dialogoLivro);
const formatoData = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

let catalogo = null;
let termo = (parametros.get('q') ?? '').trim().slice(0, 120);
let categoria = '';
let versaoCatalogo = 0;
let livroAberto = null;
let validadeIdentidade;

function mostrarAtalhoDaConta(nome = '', foto) {
  const atalho = el('atalho-conta');
  atalho.classList.toggle('botao-conta-identificada', Boolean(nome));
  atalho.querySelector('.icone-pessoa').hidden = Boolean(nome);
  atalho.querySelector('[data-avatar]').hidden = !nome;
  if (nome) {
    preencherIdentidade(atalho, nome, foto);
    atalho.setAttribute('aria-label', 'Minha conta de ' + nome);
    return;
  }
  atalho.querySelector('[data-avatar]').textContent = '';
  const rotulo = atalho.querySelector('[data-nome]');
  rotulo.textContent = 'Minha conta';
  rotulo.removeAttribute('title');
  atalho.removeAttribute('aria-label');
}

async function atualizarIdentidade() {
  clearTimeout(validadeIdentidade);
  const sessao = await solicitarApi('/sessao').catch(() => null);
  mostrarAtalhoDaConta(sessao?.nome, sessao?.foto);
  if (sessao) validadeIdentidade = setTimeout(mostrarAtalhoDaConta, sessao.expiraEm * 1000);
}

window.addEventListener('pageshow', evento => {
  if (evento.persisted) void atualizarIdentidade();
});
void atualizarIdentidade();

function texto(tag, conteudo, classe) {
  const elemento = document.createElement(tag);
  elemento.textContent = conteudo;
  if (classe) elemento.className = classe;
  return elemento;
}

function aviso(elemento, mensagem, erro = false) {
  elemento.textContent = mensagem;
  elemento.classList.toggle('aviso-erro', erro);
  elemento.hidden = !mensagem;
}


function normalizar(valor) {
  return valor.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

function disponibilidade(elemento, quantidade, detalhar = false) {
  elemento.dataset.disponivel = String(quantidade > 0);
  if (!quantidade) {
    elemento.textContent = 'Sem exemplares disponíveis';
  } else if (!detalhar) {
    elemento.textContent = 'Disponível para reserva';
  } else {
    elemento.textContent = quantidade === 1 ? '1 exemplar disponível' : quantidade + ' exemplares disponíveis';
  }
}

function renderizarCapa(vitrine, livro, carregamento = 'lazy') {
  const capa = document.createElement('img');
  capa.className = 'capa-livro';
  capa.alt = '';
  capa.loading = carregamento;
  capa.decoding = 'async';
  capa.addEventListener('error', () => {
    capa.replaceWith(texto('span', 'Capa indisponível', 'capa-indisponivel'));
  }, { once: true });
  capa.src = /^https:\/\//i.test(livro.capa) ? livro.capa : '/capas/' + encodeURIComponent(livro.id) + '.webp';
  vitrine.replaceChildren(capa);
}

function cartaoLivro(livro) {
  const cartao = el('modelo-livro').content.firstElementChild.cloneNode(true);
  const link = cartao.querySelector('.livro-link');
  link.id = 'detalhes-' + livro.id;
  link.textContent = livro.titulo;
  link.addEventListener('click', () => abrirLivro(livro.id));
  cartao.querySelector('.autor').textContent = livro.autor;
  cartao.querySelector('.categoria').textContent = [livro.categoria,livro.edicao].filter(Boolean).join(' · ');
  renderizarCapa(cartao.querySelector('.vitrine'), livro);
  disponibilidade(cartao.querySelector('.disponibilidade'), livro.disponiveis);
  return cartao;
}

function marcarCategoria() {
  for (const botao of el('categorias').children) {
    botao.setAttribute('aria-pressed', String(botao.dataset.categoria === categoria));
  }
}

function criarCategorias() {
  const valores = ['', ...new Set(catalogo.map(livro => livro.categoria))];
  const botoes = valores.map(valor => {
    const botao = texto('button', valor || 'Todos');
    botao.type = 'button';
    botao.dataset.categoria = valor;
    botao.addEventListener('click', () => {
      categoria = valor;
      marcarCategoria();
      renderizarCatalogo();
    });
    return botao;
  });
  el('categorias').replaceChildren(...botoes);
  marcarCategoria();
}

function renderizarCatalogo() {
  if (!catalogo) return;
  const apenasDisponiveis = el('so-disponiveis').checked;
  const termos = normalizar(termo).split(/\s+/).filter(Boolean);
  const livros = catalogo.filter(livro => {
    const busca = normalizar(livro.titulo + ' ' + livro.autor);
    return (!categoria || livro.categoria === categoria)
      && (!apenasDisponiveis || livro.disponiveis > 0)
      && termos.every(palavra => busca.includes(palavra));
  });
  const total = livros.length + (livros.length === 1 ? ' título' : ' títulos');
  el('total-titulos').textContent = termo ? total + ' para “' + termo + '”' : total;
  el('remover-busca').hidden = !termo;
  el('estado-catalogo').hidden = livros.length > 0;
  el('mensagem-catalogo').textContent = 'Nenhum livro encontrado com esses filtros.';
  el('recarregar-catalogo').hidden = true;
  el('limpar-filtros').hidden = !(termo || categoria || apenasDisponiveis);
  estante.replaceChildren(...livros.map(cartaoLivro));
}

function renderizarDestaques() {
  const destaques = catalogo.filter(livro => livrosDestaque.has(livro.id));
  const demais = catalogo.filter(livro => !livrosDestaque.has(livro.id));
  const livros = [...destaques, ...demais].slice(0, livrosDestaque.size);
  const posicao = carrossel.scrollLeft;
  carrossel.replaceChildren(...livros.map(cartaoLivro));
  carrossel.hidden = livros.length === 0;
  carrossel.scrollLeft = posicao;
  el('estado-catalogo').hidden = livros.length > 0;
  el('mensagem-catalogo').textContent = 'Nenhum livro nos destaques.';
  el('recarregar-catalogo').hidden = true;
  atualizarCarrossel();
}

async function carregarCatalogo() {
  const versao = ++versaoCatalogo;
  if (!catalogo) {
    el('mensagem-catalogo').textContent = carrossel ? 'Carregando os destaques…' : 'Carregando o catálogo…';
    el('recarregar-catalogo').hidden = true;
  }
  try {
    const { livros } = await solicitarApi('/catalogo');
    if (versao !== versaoCatalogo) return;
    const primeiraCarga = !catalogo;
    catalogo = livros;
    if (estante) {
      if (primeiraCarga) criarCategorias();
      renderizarCatalogo();
    } else {
      renderizarDestaques();
    }
  } catch (erro) {
    if (versao !== versaoCatalogo || catalogo) return;
    el('mensagem-catalogo').textContent = erro.message;
    el('recarregar-catalogo').hidden = false;
  }
}

function mostrarLivro(livro) {
  renderizarCapa(el('livro-vitrine'), livro, 'eager');
  el('livro-titulo').textContent = livro.titulo;
  el('livro-autor').textContent = livro.autor;
  el('livro-categoria').textContent = [livro.categoria,livro.edicao].filter(Boolean).join(' · ');
  el('livro-descricao').textContent = livro.descricao;
  disponibilidade(el('livro-disponibilidade'), livro.disponiveis, true);
  el('esperar').hidden = Boolean(livro.disponiveis);
  el('reservar').hidden = !livro.disponiveis;
  el('reservar').disabled = !livro.disponiveis;
}

function abrirLivro(id) {
  const livro = catalogo?.find(item => item.id === id);
  if (!livro) return;
  livroAberto = id;
  mostrarLivro(livro);
  el('reservar').textContent = 'Reservar exemplar';
  el('ver-reservas').hidden = true;
  aviso(el('mensagem-livro'), '');
  dialogoLivro.showModal();
}


function livroAtual() {
  return catalogo?.find(livro => livro.id === livroAberto);
}

async function reservarLivro() {
  const id = livroAberto;
  const botao = el('reservar');
  if (botao.disabled) return;
  botao.disabled = true;
  botao.textContent = 'Reservando…';
  try {
    const { reserva } = await solicitarApi('/reservas', { metodo: 'POST', corpo: { livroId: id } });
    await carregarCatalogo();
    if (!dialogoLivro.open || livroAberto !== id) return;
    mostrarLivro(livroAtual());
    botao.disabled = true;
    botao.textContent = 'Exemplar reservado';
    el('ver-reservas').hidden = false;
    aviso(el('mensagem-livro'), 'Reserva confirmada. Retire o exemplar até ' + formatoData.format(new Date(reserva.retirarAte)) + '.');
  } catch (erro) {
    if (erro.status === 401 && dialogoLivro.open && livroAberto === id) {
      botao.disabled = false;
      botao.textContent = 'Reservar exemplar';
      location.assign('/entrar/?livro=' + encodeURIComponent(id));
      return;
    }
    await carregarCatalogo();
    if (!dialogoLivro.open || livroAberto !== id) return;
    mostrarLivro(livroAtual());
    botao.textContent = 'Reservar exemplar';
    aviso(el('mensagem-livro'), erro.message, true);
  }
}

function buscarNoCatalogo(valor) {
  termo = valor.trim();
  el('termo').value = termo;
  const url = new URL(location.href);
  if (termo) url.searchParams.set('q', termo);
  else url.searchParams.delete('q');
  history.replaceState(null, '', url);
  renderizarCatalogo();
  el('catalogo').focus({ preventScroll: true });
}

if (estante) {
  el('termo').value = termo;
  el('busca').addEventListener('submit', evento => {
    evento.preventDefault();
    buscarNoCatalogo(el('termo').value);
  });
  el('so-disponiveis').addEventListener('change', renderizarCatalogo);
  el('remover-busca').addEventListener('click', () => buscarNoCatalogo(''));
  el('limpar-filtros').addEventListener('click', () => {
    categoria = '';
    el('so-disponiveis').checked = false;
    marcarCategoria();
    buscarNoCatalogo('');
  });
}
el('recarregar-catalogo').addEventListener('click', mostrarRetornoDoLogin);

dialogoLivro.querySelector('[data-fechar]').addEventListener('click', () => dialogoLivro.close());
dialogoLivro.addEventListener('click', evento => {
  if (evento.target === dialogoLivro) dialogoLivro.close();
});
dialogoLivro.addEventListener('close', () => {
  if (document.activeElement === document.body) el('detalhes-' + livroAberto)?.focus();
});

for (const [botao,rota,mensagem] of [['quero-ler','estante','Livro salvo em Quero ler.'],['esperar','fila','Você entrou na fila. Acompanhe sua posição em Minha estante.']]) {
  el(botao).addEventListener('click', async () => {
    const id = livroAberto;
    el(botao).disabled = true;
    try {
      await solicitarApi('/conta/'+rota+'/'+encodeURIComponent(id),{metodo:'PUT'});
      if (livroAberto === id) aviso(el('mensagem-livro'),mensagem);
    } catch (erro) {
      if (erro.status === 401) location.assign('/entrar/?livro='+encodeURIComponent(id));
      else if (livroAberto === id) aviso(el('mensagem-livro'),erro.message,true);
    } finally { el(botao).disabled = false; }
  });
}
el('reservar').addEventListener('click', reservarLivro);

async function mostrarRetornoDoLogin() {
  await carregarCatalogo();
  if (!catalogo) return;
  const chegada = new URL(location.href);
  const livro = chegada.searchParams.get('livro');
  if (!livro) return;
  chegada.searchParams.delete('livro');
  history.replaceState(null, '', chegada);
  if (catalogo?.some(item => item.id === livro) && !dialogoLivro.open) {
    el('detalhes-' + livro)?.focus({ preventScroll: true });
    abrirLivro(livro);
  }
}

if (parametros.get('conta') === '1') location.replace('/conta/');
else if (carrossel && (location.hash === '#catalogo' || parametros.has('livro'))) {
  location.replace('/catalogo/' + location.search);
}
else void mostrarRetornoDoLogin();
