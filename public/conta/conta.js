import { solicitarApi } from '/api.js';
import { preencherIdentidade } from '/identidade-visual.js';
import { caminhoLeitores, filtrosLeitores } from './busca-leitores.js';
import { diaDaBiblioteca } from './calendario.js';

const el = id => document.getElementById(id);
const dialogo = el('confirmacao-cancelar');
const dialogoPrazo = el('dialogo-prazo');
const detalheEmprestimo = el('detalhe-emprestimo');
const tela = document.body.dataset.tela;
const idNaRota = tela === 'leitor' ? location.pathname.split('/').filter(Boolean).at(-1) : null;
const viaDiretorio = location.pathname.toLowerCase().startsWith('/conta/leitores');
const filtros = filtrosLeitores(new URLSearchParams(location.search));
const dataLocal = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
let perfilAtual = null;
let reservaSelecionada = null;
let emprestimoSelecionado = null;
let validade;
let versaoCarregamento = 0;
let consultaDetalhe = 0;
let gravandoMovimento = false;
let diaCarregado;

function texto(tag, conteudo, classe) {
  const elemento = document.createElement(tag);
  elemento.textContent = conteudo;
  if (classe) elemento.className = classe;
  return elemento;
}

function aviso(id, mensagem = '', erro = false) {
  const elemento = el(id);
  elemento.textContent = mensagem;
  elemento.hidden = !mensagem;
  elemento.classList.toggle('aviso-erro', erro);
}

function voltarAoLogin() {
  el('dados-conta').hidden = true;
  el('identidade-conta').hidden = true;
  dialogo?.close();
  dialogoPrazo?.close();
  detalheEmprestimo.close();
  const retorno = new URLSearchParams(viaDiretorio ? filtros : '');
  retorno.set('sessao', 'expirada');
  retorno.set('tela', viaDiretorio ? 'leitores' : tela);
  if (idNaRota) retorno.set('id', decodeURIComponent(idNaRota));
  location.replace('/entrar/?' + retorno);
}

async function apiConta(caminho, opcoes) {
  try {
    return await solicitarApi(caminho, opcoes);
  } catch (erro) {
    if (erro.status === 401) voltarAoLogin();
    throw erro;
  }
}

function tempo(iso, prefixo = '') {
  const elemento = texto('time', prefixo + dataLocal.format(new Date(iso)));
  elemento.dateTime = iso;
  return elemento;
}

function livroNaLista(livro, linkParaCatalogo = true) {
  const item = document.createElement('li');
  const miniatura = document.createElement('span');
  miniatura.className = 'conta-miniatura';
  miniatura.setAttribute('aria-hidden', 'true');
  const icone = texto('i', '', 'icone-livro');
  const titulo = texto(livro.livroId && linkParaCatalogo ? 'a' : 'strong', livro.titulo);
  if (livro.livroId) {
    const identificador = encodeURIComponent(livro.livroId);
    const capa = document.createElement('img');
    capa.alt = '';
    capa.loading = 'lazy';
    capa.addEventListener('error', () => capa.replaceWith(icone), { once: true });
    capa.src = '/api/capa/' + identificador;
    if (linkParaCatalogo) titulo.href = '/catalogo/?livro=' + identificador;
    miniatura.append(capa);
  } else {
    miniatura.append(icone);
  }
  const informacoes = document.createElement('div');
  informacoes.className = 'conta-livro';
  informacoes.append(titulo, texto('p', [livro.autor,livro.tombo].filter(Boolean).join(' · ')));
  item.append(miniatura, informacoes);
  return { item, informacoes };
}

function itemReserva(reserva) {
  const { item, informacoes } = livroNaLista(reserva);
  if (tela === 'leitor') informacoes.append(texto('p', 'Reserva nº ' + reserva.id));
  informacoes.append(tempo(reserva.retirarAte, 'Retirar até '));

  const acoes = document.createElement('div');
  acoes.className = 'conta-item-acoes';
  acoes.append(texto('span', 'Aguardando retirada', 'status-conta'));
  item.append(acoes);
  if (tela === 'leitor') return item;
  const botao = texto('button', 'Cancelar reserva', 'botao botao-secundario');
  botao.type = 'button';
  botao.setAttribute('aria-label', 'Cancelar reserva de ' + reserva.titulo);
  botao.addEventListener('click', () => {
    reservaSelecionada = reserva;
    el('reserva-a-cancelar').textContent = 'O exemplar de “' + reserva.titulo + '” voltará a ficar disponível no catálogo.';
    aviso('erro-cancelar');
    dialogo.showModal();
  });
  acoes.append(botao);
  return item;
}

function dataDevolucaoFormatada(data) {
  return data.split('-').reverse().join('/');
}

function abrirPrazo(livro, leitorNaRota) {
  emprestimoSelecionado = { livro, leitorNaRota };
  el('titulo-alterar-prazo').textContent = livro.prazoDevolucao ? 'Renovar empréstimo' : 'Definir prazo';
  el('livro-alterar-prazo').textContent = [livro.titulo, livro.leitor, 'Empréstimo nº ' + livro.id].filter(Boolean).join(' · ');
  el('prazo-atual').textContent = livro.prazoDevolucao
    ? 'A devolução está prevista para ' + dataDevolucaoFormatada(livro.prazoDevolucao) + '.' : 'Este empréstimo está sem prazo de devolução.';
  const campo = el('novo-prazo');
  const hoje = diaDaBiblioteca();
  campo.value = '';
  campo.min = hoje;
  campo.setCustomValidity(livro.prazoDevolucao === campo.max ? 'O prazo atual já é a última data permitida.' : '');
  if (livro.prazoDevolucao >= hoje && livro.prazoDevolucao < campo.max) {
    const diaSeguinte = new Date(livro.prazoDevolucao + 'T00:00:00Z');
    diaSeguinte.setUTCDate(diaSeguinte.getUTCDate() + 1);
    campo.min = diaSeguinte.toISOString().slice(0, 10);
  }
  dialogoPrazo.showModal();
}

function eventoNaLinhaDoTempo(evento) {
  const rotulos = { retirada: 'Retirada', renovacao: 'Renovação', devolucao: 'Devolução', correcao: 'Correção da devolução' };
  const item = document.createElement('li');
  item.append(
    texto('strong', rotulos[evento.tipo]),
    evento.data ? tempo(evento.data) : texto('span', 'Data não registrada'),
    texto('p', evento.responsavel ?? 'Responsável não registrado')
  );
  if (evento.motivo) item.append(texto('p', evento.motivo));
  if (evento.tipo === 'renovacao') item.append(prazosDaRenovacao(evento));
  return item;
}

export async function abrirDetalheEmprestimo(livro, id, leitorNaRota) {
  const consulta = ++consultaDetalhe;
  el('numero-detalhe').textContent = 'Empréstimo nº ' + id + (livro.tombo ? ' · ' + livro.tombo : '');
  el('livro-detalhe').textContent = livro.titulo;
  el('autor-detalhe').textContent = [livro.autor,livro.leitor].filter(Boolean).join(' · ');
  const catalogo = el('catalogo-detalhe');
  catalogo.hidden = !livro.livroId;
  if (livro.livroId) catalogo.href = '/catalogo/?livro=' + encodeURIComponent(livro.livroId);
  const lista = el('eventos-emprestimo');
  lista.replaceChildren();
  aviso('estado-detalhe', 'Carregando movimentações…');
  el('imprimir-recibo').disabled=true;
  detalheEmprestimo.showModal();
  const conta = leitorNaRota ? '/conta/leitores/' + leitorNaRota : '/conta';
  try {
    const { eventos, comprovante } = await apiConta(conta + '/emprestimos/' + encodeURIComponent(id));
    if (consulta !== consultaDetalhe || !detalheEmprestimo.open) return;
    el('imprimir-recibo').disabled=false;
    el('numero-detalhe').textContent='Empréstimo nº '+id+(comprovante.tombo?' · '+comprovante.tombo:'');
    el('autor-detalhe').textContent=[comprovante.autor,'Leitor: '+comprovante.leitor,comprovante.prazoDevolucao?'Prazo: '+dataDevolucaoFormatada(comprovante.prazoDevolucao):'Sem prazo registrado'].filter(Boolean).join(' · ');
    lista.replaceChildren(...eventos.map(eventoNaLinhaDoTempo));
    aviso('estado-detalhe');
  } catch (erro) {
    if (consulta === consultaDetalhe && detalheEmprestimo.open) aviso('estado-detalhe', erro.message, true);
  }
}

function emprestimoNaLista(livro, id, leitorNaRota = idNaRota) {
  const { item, informacoes } = livroNaLista(livro, false);
  item.classList.add('emprestimo-clicavel');
  const abrir = texto('button', 'Empréstimo nº ' + id + ' · Ver linha do tempo', 'abrir-emprestimo');
  abrir.type = 'button';
  abrir.setAttribute('aria-haspopup', 'dialog');
  abrir.setAttribute('aria-label', 'Ver linha do tempo de ' + livro.titulo + ', empréstimo nº ' + id);
  abrir.addEventListener('click', () => abrirDetalheEmprestimo(livro, id, leitorNaRota));
  informacoes.append(abrir);
  return { item, informacoes };
}

function mostrarPrazo(informacoes, livro) {
  if (livro.prazoDevolucao) {
    const prazo = texto('time', 'Devolver até ' + dataDevolucaoFormatada(livro.prazoDevolucao));
    prazo.dateTime = livro.prazoDevolucao;
    informacoes.append(prazo);
  } else if (!livro.devolvidoEm) {
    informacoes.append(texto('p', 'Prazo não informado'));
  }
}

function botoesDeBalcao(livro, leitorNaRota) {
  const rotulo = livro.prazoDevolucao ? 'Renovar empréstimo' : 'Definir prazo';
  const referencia = livro.leitor ? livro.titulo + ', ' + livro.leitor + ', empréstimo nº ' + livro.id : livro.titulo;
  const alterar = texto('button', rotulo, 'botao botao-secundario');
  alterar.type = 'button';
  alterar.id = 'alterar-prazo-' + livro.id;
  alterar.setAttribute('aria-label', rotulo + ' de ' + referencia);
  alterar.setAttribute('aria-haspopup', 'dialog');
  alterar.addEventListener('click', () => abrirPrazo(livro, leitorNaRota));
  const devolver = texto('button', 'Registrar devolução', 'botao botao-secundario');
  devolver.type = 'button';
  devolver.setAttribute('aria-label', 'Registrar devolução de ' + referencia);
  devolver.addEventListener('click', () => gravarMovimento({
    leitorNaRota, caminho: '/' + encodeURIComponent(livro.id) + '/devolucao', metodo: 'PUT',
    mensagem: 'Devolução de “' + livro.titulo + '” registrada' + (livro.leitor ? ' para ' + livro.leitor : '') + '.'
  }));
  return [alterar, devolver];
}

function itemEmprestimo(livro) {
  const { item, informacoes } = emprestimoNaLista(livro, livro.id);
  if (livro.emprestadoEm) informacoes.append(tempo(livro.emprestadoEm, 'Emprestado em '));
  informacoes.append(texto('p', livro.registradoPor ? 'Empréstimo registrado por ' + livro.registradoPor : 'Responsável pelo empréstimo não registrado'));
  mostrarPrazo(informacoes, livro);
  if (livro.devolvidoEm) {
    informacoes.append(
      tempo(livro.devolvidoEm, 'Devolvido em '),
      texto('p', livro.recebidoPor ? 'Devolução recebida por ' + livro.recebidoPor : 'Responsável pela devolução não registrado')
    );
    item.append(texto('span', 'Devolvido', 'status-conta status-encerrado'));
    return item;
  }
  const acoes = document.createElement('div');
  acoes.className = 'conta-item-acoes';
  if (livro.diasEmAtraso > 0) {
    const duracao = livro.diasEmAtraso === 1 ? '1 dia' : livro.diasEmAtraso + ' dias';
    item.classList.add('emprestimo-atrasado');
    acoes.append(texto('span', 'Atrasado há ' + duracao, 'status-conta status-atraso'));
  } else if (livro.prazoDevolucao || tela !== 'leitor') {
    acoes.append(texto('span', livro.prazoDevolucao ? 'Em dia' : 'Em andamento', 'status-conta'));
  }
  if (tela === 'leitor') acoes.append(...botoesDeBalcao(livro, idNaRota));
  item.append(acoes);
  return item;
}

function itemCirculacao(emprestimo) {
  const leitorNaRota = encodeURIComponent(emprestimo.leitorId);
  const { item, informacoes } = emprestimoNaLista(emprestimo, emprestimo.id, leitorNaRota);
  mostrarPrazo(informacoes, emprestimo);
  const responsavel = document.createElement('div');
  responsavel.className = 'circulacao-leitor';
  const link = texto('a', emprestimo.leitor);
  link.href = '/conta/circulacao/leitores/' + leitorNaRota + '/';
  responsavel.append(
    texto('span', 'Com quem está'),
    link,
    texto('small', 'Cadastro ' + emprestimo.leitorId)
  );
  const acoes = document.createElement('div');
  acoes.className = 'conta-item-acoes';
  acoes.append(...botoesDeBalcao(emprestimo, leitorNaRota));
  item.append(responsavel, acoes);
  return item;
}

function itemHistorico(reserva) {
  const { item, informacoes } = livroNaLista(reserva);
  const detalhes = texto('p', 'Reserva nº ' + reserva.id, 'conta-reserva-detalhes');
  detalhes.append(tempo(reserva.encerradaEm, 'Encerrada em '));
  informacoes.append(detalhes);
  const situacoes = { cancelada: 'Cancelada', expirada: 'Expirada', retirada: 'Retirada' };
  item.append(texto('span', situacoes[reserva.situacao], 'status-conta status-encerrado'));
  return item;
}

function itemRenovacao(renovacao) {
  const { item, informacoes } = emprestimoNaLista(renovacao, renovacao.emprestimoId);
  informacoes.append(
    tempo(renovacao.renovadoEm, 'Renovado em '),
    texto('p', renovacao.nomeBibliotecario ? 'Renovado por ' + renovacao.nomeBibliotecario : 'Responsável não registrado')
  );
  item.append(prazosDaRenovacao(renovacao));
  return item;
}

function prazosDaRenovacao(renovacao) {
  const prazos = document.createElement('dl');
  prazos.className = 'prazos-renovacao';
  for (const [rotulo, data] of [['Prazo anterior', renovacao.prazoAnterior], ['Novo prazo', renovacao.prazoNovo]]) {
    const grupo = document.createElement('div');
    const valor = document.createElement('dd');
    const dia = texto('time', dataDevolucaoFormatada(data));
    dia.dateTime = data;
    valor.append(dia);
    grupo.append(texto('dt', rotulo), valor);
    prazos.append(grupo);
  }
  return prazos;
}

function listar(secao, itens, montarItem) {
  const lista = el('lista-' + secao);
  lista.replaceChildren(...itens.map(montarItem));
  lista.hidden = itens.length === 0;
  el('vazio-' + secao).hidden = !lista.hidden;
}

function mostrarPerfil(perfil) {
  const identidade = el('identidade-conta');
  preencherIdentidade(identidade, perfil.nome, perfil.foto);
  identidade.hidden = false;
  const papel = perfil.papel === 'bibliotecaria' ? 'Bibliotecária' : 'Leitor';
  el('papel-identidade').textContent = papel;
  if (tela !== 'perfil') return;
  el('nome-perfil').textContent = perfil.nome;
  el('email-perfil').textContent = perfil.email;
  el('tipo-perfil').textContent = papel;
  if (perfilAtual?.nome !== perfil.nome) el('editar-nome').value = perfil.nome;
  el('perfil-demo').hidden = !perfil.demonstracao;
  el('opcoes-perfil').hidden = perfil.demonstracao;
  perfilAtual = perfil;
}

function preencherLivrosParaEmprestimo(catalogo, emprestimos, reservas) {
  const seletor = el('livro-emprestimo');
  const selecionado = seletor.value;
  const comLeitor = new Set(emprestimos.map(item => item.livroId));
  const reservados = new Set(reservas.map(item => item.livroId));
  const retirada = document.createElement('optgroup');
  retirada.label = 'Reservado por este leitor';
  const balcao = document.createElement('optgroup');
  balcao.label = 'Disponível no acervo';
  for (const livro of [...catalogo].sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'))) {
    if (comLeitor.has(livro.id) || (!reservados.has(livro.id) && !livro.disponiveis)) continue;
    const grupo = reservados.has(livro.id) ? retirada : balcao;
    grupo.append(new Option([livro.titulo,livro.edicao,livro.autor].filter(Boolean).join(' · '), livro.id));
  }
  const grupos = [retirada, balcao].filter(grupo => grupo.childElementCount);
  seletor.disabled = grupos.length === 0;
  seletor.replaceChildren(new Option(seletor.disabled ? 'Nenhum exemplar disponível' : 'Selecione um título', ''), ...grupos);
  if (selecionado && [...seletor.options].some(opcao => opcao.value === selecionado)) seletor.value = selecionado;
  const prazo = el('prazo-devolucao');
  prazo.min = diaDaBiblioteca();
  prazo.disabled = seletor.disabled;
  el('registrar-emprestimo').disabled = seletor.disabled;
}

function mostrarFicha({ leitor, livros, reservas, historico, devolucoes, renovacoes }, catalogo) {
  if (viaDiretorio) {
    const voltar = el('voltar-da-ficha');
    voltar.href = caminhoLeitores(filtros) + '#leitores';
    voltar.querySelector('span').textContent = 'Voltar aos leitores';
  }
  preencherIdentidade(el('identidade-ficha'), leitor.nome);
  document.title = leitor.nome + ' | Ficha do leitor | Acervo';
  el('cadastro-leitor').textContent = leitor.id;
  el('email-leitor').textContent = leitor.email;
  el('tipo-leitor').textContent = leitor.papel === 'bibliotecaria' ? 'Bibliotecária' : 'Leitor';
  el('quantidade-livros').textContent = livros.length;
  const atrasados = livros.filter(livro => livro.diasEmAtraso > 0).length;
  el('atrasos-ficha').textContent = atrasados + ' em atraso';
  el('atrasos-ficha').hidden = atrasados === 0;
  el('quantidade-devolucoes').textContent = devolucoes.length;
  el('quantidade-renovacoes').textContent = renovacoes.length;
  el('quantidade-reservas').textContent = reservas.length;
  el('quantidade-historico').textContent = historico.length;
  listar('emprestimos', livros, itemEmprestimo);
  listar('devolucoes', devolucoes, itemEmprestimo);
  listar('renovacoes', renovacoes, itemRenovacao);
  preencherLivrosParaEmprestimo(catalogo, livros, reservas);
  listar('reservas', reservas, itemReserva);
  listar('historico', historico, itemHistorico);
}

function itemLeitor(leitor) {
  const item = el('linha-leitor').content.firstElementChild.cloneNode(true);
  const link = item.querySelector('a');
  link.href = caminhoLeitores(filtros, leitor.id);
  preencherIdentidade(link, leitor.nome);
  link.querySelector('[data-email]').textContent = leitor.email;
  link.querySelector('[data-cadastro]').textContent = 'Cadastro ' + leitor.id;
  const quantidade = leitor.emprestimosAtivos;
  link.querySelector('[data-emprestimos]').textContent = quantidade === 0 ? 'Sem empréstimos'
    : quantidade === 1 ? '1 empréstimo ativo' : quantidade + ' empréstimos ativos';
  return item;
}

function mostrarLeitores({ leitores, pagina, temProxima }) {
  const nome = filtros.get('nome') || '';
  el('busca-nome-leitor').value = nome;
  el('limpar-leitores').hidden = !nome;
  el('titulo-lista-leitores').textContent = nome ? 'Resultados da busca' : 'Leitores cadastrados';
  el('vazio-leitores').textContent = pagina > 1 ? 'Não há leitores nesta página.'
    : nome ? 'Nenhum leitor encontrado. Tente outro nome ou sobrenome.' : 'Ainda não há leitores cadastrados.';
  listar('leitores', leitores, itemLeitor);
  el('paginas-leitores').hidden = pagina === 1 && !temProxima;
  el('pagina-leitores').textContent = 'Página ' + pagina;
  const anterior = el('leitores-anterior');
  anterior.hidden = pagina === 1;
  if (!anterior.hidden) anterior.href = caminhoLeitores(filtrosLeitores(filtros, pagina - 1)) + '#leitores';
  const proxima = el('leitores-proxima');
  proxima.hidden = !temProxima;
  if (temProxima) proxima.href = caminhoLeitores(filtrosLeitores(filtros, pagina + 1)) + '#leitores';
}

let dadosRelatorio = [];
function filtrarRelatorio() {
  const normalizar = valor => String(valor ?? '').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
  const busca = normalizar(el('op-busca').value.trim());
  const situacao = el('op-filtro').value;
  const hoje = diaDaBiblioteca();
  const itens = dadosRelatorio.filter(e => {
    const data = e.prazoDevolucao;
    const categoria = !data ? 'sem' : data < hoje ? 'atrasado' : data === hoje ? 'hoje' : 'futuro';
    return (!situacao || situacao === categoria) && [e.titulo,e.leitor,e.leitorId,e.id,e.tombo].some(v => normalizar(v).includes(busca));
  });
  if (el('op-ordem').value) itens.sort((a,b) => (a.prazoDevolucao || '9999').localeCompare(b.prazoDevolucao || '9999'));
  listar('circulacao', itens, itemCirculacao);
}
if (tela === 'circulacao') for (const id of ['op-busca','op-filtro','op-ordem']) el(id).addEventListener('input',filtrarRelatorio);
el('imprimir-recibo').addEventListener('click', () => window.print());
async function carregarConta() {
  const versao = ++versaoCarregamento;
  diaCarregado = diaDaBiblioteca();
  el('recarregar-conta').hidden = true;
  const atualizar = el('atualizar-relatorio');
  if (atualizar) atualizar.disabled = true;
  try {
    const [conta, relatorio, ficha, diretorio, catalogo] = await Promise.all([
      apiConta('/conta'),
      tela === 'circulacao' ? apiConta('/conta/circulacao') : null,
      tela === 'leitor' ? apiConta('/conta/leitores/' + idNaRota) : null,
      tela === 'leitores' ? apiConta('/conta/leitores?' + filtros) : null,
      tela === 'leitor' ? apiConta('/catalogo') : null
    ]);
    if (versao !== versaoCarregamento) return;
    const { perfil, expiraEm, livros, reservas, historico } = conta;
    if (Boolean(document.querySelector('nav a[href="/conta/circulacao/"]')) !== (perfil.papel === 'bibliotecaria')) {
      location.reload();
      return;
    }
    clearTimeout(validade);
    validade = setTimeout(voltarAoLogin, expiraEm * 1000);
    mostrarPerfil(perfil);
    el('total-reservas').textContent = reservas.length;
    el('total-emprestimos').textContent = livros.length;
    el('total-reservas').hidden = false;
    el('total-emprestimos').hidden = false;
    if (['reservas', 'emprestimos', 'historico', 'perfil'].includes(tela)) {
      const atrasados = livros.filter(livro => livro.diasEmAtraso > 0).length;
      const painel = el('aviso-atrasos');
      el('resumo-atrasos').textContent = atrasados === 1 ? 'Você tem 1 livro em atraso.' : 'Você tem ' + atrasados + ' livros em atraso.';
      painel.querySelector('a').hidden = tela === 'emprestimos';
      painel.hidden = atrasados === 0;
    }
    if (relatorio) {
      el('circulacao-exemplares').textContent = relatorio.emprestimosAtivos;
      el('circulacao-leitores').textContent = relatorio.leitoresComEmprestimos;
      dadosRelatorio = relatorio.emprestimos;
      filtrarRelatorio();
      el('atualizacao-circulacao').textContent = 'Atualizado em ' + dataLocal.format(new Date()) + '.';
    }
    if (tela === 'reservas') {
      const ate = diaDaBiblioteca(new Date(Date.now() + 2 * 86400000));
      const proximos = livros.filter(l => l.prazoDevolucao && l.prazoDevolucao <= ate).sort((a,b)=>a.prazoDevolucao.localeCompare(b.prazoDevolucao));
      const avisos = [...reservas.map(r => 'Retirar “' + r.titulo + '” até ' + dataLocal.format(new Date(r.retirarAte)) + '.'),
        ...proximos.map(l => (l.diasEmAtraso ? 'Em atraso' : 'Devolução próxima') + ' · ' + l.titulo + ' · ' + dataDevolucaoFormatada(l.prazoDevolucao))];
      el('avisos-leitor').replaceChildren(...(avisos.length ? avisos : ['Nenhuma retirada ou devolução próxima.']).map(msg=>texto('li',msg)));
      listar('reservas', reservas, itemReserva);
      el('mais-reservas').hidden = reservas.length === 0;
    }
    if (tela === 'emprestimos') {
      listar('emprestimos', livros, itemEmprestimo);
      el('ver-renovacoes').hidden = !conta.renovacoes.length;
    }
    if (tela === 'historico') {
      listar('renovacoes', conta.renovacoes, itemRenovacao);
      listar('historico', historico, itemHistorico);
      listar('devolucoes', conta.devolucoes, itemEmprestimo);
    }
    if (ficha) mostrarFicha(ficha, catalogo.livros);
    if (diretorio) mostrarLeitores(diretorio);
    el('dados-conta').hidden = false;
    aviso('estado-conta');
    if (diretorio && location.hash === '#leitores') el('leitores').scrollIntoView({ block: 'start' });
    return true;
  } catch (erro) {
    if (erro.status === 403 && ['circulacao', 'leitor', 'leitores'].includes(tela)) {
      location.replace('/conta/reservas/');
      return false;
    }
    if (erro.status !== 401 && versao === versaoCarregamento) {
      aviso('estado-conta', erro.message, true);
      el('recarregar-conta').hidden = erro.status === 404;
    }
    return false;
  } finally {
    if (atualizar && versao === versaoCarregamento) atualizar.disabled = false;
  }
}

async function gravarMovimento({ leitorNaRota = idNaRota, caminho = '', metodo, corpo, mensagem, foco }) {
  if (gravandoMovimento) return;
  gravandoMovimento = true;
  const botoes = document.querySelectorAll('#formulario-emprestimo button:enabled, #lista-emprestimos button:enabled, #lista-circulacao button:enabled, #atualizar-relatorio:enabled');
  for (const botao of botoes) botao.disabled = true;
  aviso('estado-emprestimo', 'Registrando…');
  try {
    try {
      await apiConta('/conta/leitores/' + leitorNaRota + '/emprestimos' + caminho, { metodo, corpo });
      if (metodo === 'POST') el('prazo-devolucao').value = '';
      aviso('estado-emprestimo', mensagem);
    } catch (erro) {
      if (erro.status === 401) return;
      aviso('estado-emprestimo', erro.message, true);
    }
    if (await carregarConta()) {
      const destino = el(foco) ?? el(tela === 'circulacao' ? 'estado-emprestimo' : 'livro-emprestimo');
      destino.focus({ preventScroll: true });
    } else {
      el('dados-conta').hidden = true;
    }
  } finally {
    for (const botao of botoes) botao.disabled = false;
    if (tela === 'leitor') el('registrar-emprestimo').disabled = el('livro-emprestimo').disabled;
    gravandoMovimento = false;
  }
}

dialogoPrazo?.addEventListener('close', () => { emprestimoSelecionado = null; });
el('cancelar-alteracao-prazo')?.addEventListener('click', () => dialogoPrazo.close());
el('formulario-alterar-prazo')?.addEventListener('submit', evento => {
  evento.preventDefault();
  if (!emprestimoSelecionado || gravandoMovimento) return;
  const { livro, leitorNaRota } = emprestimoSelecionado;
  const { id, titulo, prazoDevolucao: anterior } = livro;
  const prazoDevolucao = el('novo-prazo').value;
  dialogoPrazo.close();
  const acao = anterior ? 'Empréstimo renovado' : 'Prazo definido';
  void gravarMovimento({ leitorNaRota, metodo: 'PATCH', caminho: '/' + encodeURIComponent(id) + '/prazo',
    corpo: { prazoDevolucao }, mensagem: acao + ' para “' + titulo + '” até ' + dataDevolucaoFormatada(prazoDevolucao) + '.',
    foco: 'alterar-prazo-' + id });
});

el('formulario-emprestimo')?.addEventListener('submit', evento => {
  evento.preventDefault();
  const seletor = el('livro-emprestimo');
  if (!seletor.value) return;
  const prazoDevolucao = el('prazo-devolucao').value;
  void gravarMovimento({ metodo: 'POST', corpo: { livroId: seletor.value, prazoDevolucao },
    mensagem: 'Empréstimo de “' + seletor.selectedOptions[0].textContent + '” registrado.' });
});

async function cancelarReserva() {
  const botao = el('cancelar-reserva');
  if (botao.disabled || !reservaSelecionada) return;
  botao.disabled = true;
  aviso('erro-cancelar');
  try {
    await apiConta('/reservas/' + reservaSelecionada.id, { metodo: 'DELETE' });
    dialogo.close();
    el('reservas').focus({ preventScroll: true });
    if (await carregarConta()) aviso('estado-conta', 'Reserva cancelada.');
  } catch (erro) {
    aviso('erro-cancelar', erro.message, true);
  } finally {
    botao.disabled = false;
  }
}

el('manter-reserva')?.addEventListener('click', () => dialogo.close());
el('cancelar-reserva')?.addEventListener('click', cancelarReserva);
el('recarregar-conta').addEventListener('click', carregarConta);
el('atualizar-relatorio')?.addEventListener('click', carregarConta);
el('sair').addEventListener('click', async () => {
  el('sair').disabled = true;
  try {
    await solicitarApi('/sessao', { metodo: 'DELETE' });
    location.replace('/');
  } catch (erro) {
    aviso('estado-conta', erro.message, true);
    el('sair').disabled = false;
  }
});

el('formulario-perfil')?.addEventListener('submit', async evento => {
  evento.preventDefault();
  const botao = evento.submitter;
  botao.disabled = true;
  aviso('estado-perfil');
  try {
    const { nome } = await apiConta('/conta/perfil', { metodo: 'PATCH', corpo: { nome: el('editar-nome').value } });
    mostrarPerfil({ ...perfilAtual, nome });
    aviso('estado-perfil', 'Nome atualizado.');
  } catch (erro) {
    aviso('estado-perfil', erro.message, true);
  } finally {
    botao.disabled = false;
  }
});

el('formulario-senha')?.addEventListener('submit', async evento => {
  evento.preventDefault();
  const novaSenha = el('nova-senha').value;
  if (novaSenha !== el('confirmar-senha').value) {
    aviso('estado-senha', 'As senhas precisam ser iguais.', true);
    el('confirmar-senha').focus();
    return;
  }

  const botao = evento.submitter;
  botao.disabled = true;
  aviso('estado-senha');
  try {
    await apiConta('/conta/senha', { metodo: 'PATCH', corpo: { senhaAtual: el('senha-atual').value, novaSenha } });
    el('formulario-senha').reset();
    location.replace('/entrar/?senha=alterada');
  } catch (erro) {
    aviso('estado-senha', erro.message, true);
    botao.disabled = false;
  }
});

window.addEventListener('pageshow', evento => {
  if (evento.persisted) {
    detalheEmprestimo.close();
    el('dados-conta').hidden = true;
    el('identidade-conta').hidden = true;
    void carregarConta();
  }
});

function atualizarNaViradaDoDia() {
  if (!document.hidden && !gravandoMovimento && diaCarregado && diaCarregado !== diaDaBiblioteca()) void carregarConta();
}
document.addEventListener('visibilitychange', atualizarNaViradaDoDia);
window.setInterval(atualizarNaViradaDoDia, 60000);

const telaAntiga = location.hash.slice(1);
if (['reservas', 'emprestimos', 'historico', 'perfil'].includes(telaAntiga) && telaAntiga !== tela) {
  location.replace('/conta/' + telaAntiga + '/');
} else {
  void carregarConta();
}
