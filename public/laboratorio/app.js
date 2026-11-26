const el = id => document.getElementById(id);
const perfis = {
  leitor: ['leitor@acervo.test', 'Leitura!104'],
  equipe: ['equipe@acervo.test', 'Equipe!208']
};
const botoes = [...document.querySelectorAll('button')];
const rotas = [...document.querySelectorAll('[data-rota]')];
const perfisDoRelatorio = [...document.querySelectorAll('[data-perfil-relatorio]')];
const linksNavegacao = [...document.querySelectorAll('.navegacao a')];
let sessao = null;
let validade;
let consultando = false;

function mostrarDados(rota, dados) {
  el('indicadores').hidden = rota !== 'GET /api/circulacao';
  el('livros').hidden = rota !== 'GET /api/meus-emprestimos' || !dados?.livros?.length;
  el('livros').replaceChildren();

  if (!el('indicadores').hidden) {
    el('total-emprestimos').textContent = dados.emprestimosAtivos;
    el('total-leitores').textContent = dados.leitoresComEmprestimos;
  }

  if (el('livros').hidden) return;
  const itens = dados.livros.map(livro => {
    const item = document.createElement('li');
    const titulo = document.createElement('strong');
    const autor = document.createElement('span');
    titulo.textContent = livro.titulo;
    autor.textContent = livro.autor;
    item.append(titulo, autor);
    return item;
  });
  el('livros').replaceChildren(...itens);
}

function resultado(status, caminho, mensagem, corpo, tinhaToken = false) {
  el('status').textContent = Number.isInteger(status) ? 'HTTP ' + status : status;
  el('requisicao').textContent = caminho;
  el('motivo').textContent = mensagem;
  el('decisao').closest('.console').dataset.estado = String(status);
  el('detalhes').hidden = !corpo;
  if (!corpo && status !== 'Consultando') el('detalhes').open = false;
  el('resposta').textContent = corpo ? JSON.stringify(corpo, null, 2) : '';
  mostrarDados(status === 200 ? caminho : '', corpo);
  for (const botao of rotas) {
    botao.dataset.ultima = String(caminho === 'GET /api/' + botao.dataset.rota);
  }
  const protegida = caminho.startsWith('GET /api/') && [200, 401, 403].includes(status);
  el('etapas').hidden = !protegida;
  if (!protegida) return;
  if (status === 401) {
    el('autenticacao').textContent = tinhaToken ? 'Token recusado' : 'Sem token';
    el('autorizacao').textContent = 'Não avaliada';
    return;
  }
  el('autenticacao').textContent = 'Token válido';
  el('autorizacao').textContent = status === 403 ? 'Permissão negada' : 'Permissão concedida';
}

function registrarConsulta(perfil, status) {
  const item = perfisDoRelatorio.find(linha => linha.dataset.perfilRelatorio === perfil);
  item.dataset.codigo = String(status);
  item.querySelector('strong').textContent = 'HTTP ' + status;
  el('limpar').hidden = false;
}

function mostrarSenha(visivel) {
  el('senha').type = visivel ? 'text' : 'password';
  el('ver-senha').textContent = visivel ? 'Ocultar' : 'Mostrar';
  el('ver-senha').setAttribute('aria-label', visivel ? 'Ocultar senha' : 'Mostrar senha');
}

function encerrar() {
  clearTimeout(validade);
  sessao = null;
  el('login').hidden = false;
  el('sessao').hidden = true;
  el('estado-conta').textContent = 'Sem sessão';
  el('estado-conta').dataset.ativa = 'false';
}

function abrirSessao(dados) {
  const papel = dados.papel === 'leitor' ? 'Leitor' : 'Bibliotecária';
  sessao = { token: dados.token, papel };
  el('nome').textContent = dados.nome;
  el('papel').textContent = papel;
  el('iniciais').textContent = dados.nome.trim().split(/\s+/).slice(0, 2)
    .map(parte => parte.charAt(0)).join('').toLocaleUpperCase('pt-BR');
  el('estado-conta').textContent = 'Sessão ativa · ' + papel;
  el('estado-conta').dataset.ativa = 'true';
  el('expira').textContent = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' })
    .format(new Date(Date.now() + dados.expiraEm * 1000));
  el('login').hidden = true;
  el('sessao').hidden = false;
  mostrarSenha(false);
  validade = setTimeout(() => {
    const focoNaSessao = el('sessao').contains(document.activeElement);
    encerrar();
    resultado('Expirado', 'Sessão encerrada', 'O JWT atingiu o prazo de validade. Entre novamente.');
    if (focoNaSessao) el('email').focus({ preventScroll: true });
  }, dados.expiraEm * 1000);
}

function resumir(caminho, dados) {
  if (dados.mensagem) return dados.mensagem;
  if (caminho === '/api/login') return 'Senha confirmada. A API emitiu um JWT válido por cinco minutos.';
  if (caminho === '/api/circulacao') {
    return 'Acesso permitido à equipe da biblioteca.';
  }
  return dados.livros.length
    ? 'Empréstimos de ' + dados.leitor + '.'
    : 'Nenhum livro emprestado para esta conta.';
}

async function consultar(caminho, opcoes = {}) {
  if (consultando) return;
  consultando = true;
  const identidade = sessao?.papel ?? 'Sem login';
  const tinhaToken = Boolean(sessao?.token);
  const metodo = opcoes.method ?? 'GET';
  const rota = metodo + ' ' + caminho;
  botoes.forEach(botao => { botao.disabled = true; });
  el('erro-login').hidden = true;
  resultado('Consultando', rota, 'Aguardando resposta do servidor.');
  try {
    const resposta = await fetch(caminho, opcoes);
    const dados = await resposta.json();
    if (resposta.ok && dados.token) {
      abrirSessao(dados);
      dados.token = 'JWT emitido (valor oculto)';
    } else if (resposta.status === 401 && sessao) {
      encerrar();
    }
    if (caminho === '/api/login' && !resposta.ok) {
      el('erro-login').textContent = dados.mensagem;
      el('erro-login').hidden = false;
    }
    if (caminho === '/api/circulacao') registrarConsulta(identidade, resposta.status);
    resultado(resposta.status, rota, resumir(caminho, dados), dados, tinhaToken);
  } catch {
    const mensagem = 'O servidor não respondeu. Verifique a conexão e tente outra vez.';
    resultado('Indisponível', rota, mensagem);
    if (caminho === '/api/login') {
      el('erro-login').textContent = mensagem;
      el('erro-login').hidden = false;
    }
  } finally {
    consultando = false;
    botoes.forEach(botao => { botao.disabled = false; });
  }
}

const seletores = [...document.querySelectorAll('[data-perfil]')];
function atualizarSelecao() {
  for (const botao of seletores) {
    const [email, senha] = perfis[botao.dataset.perfil];
    botao.setAttribute('aria-pressed', String(el('email').value === email && el('senha').value === senha));
  }
  el('erro-login').hidden = true;
}
for (const botao of seletores) {
  botao.addEventListener('click', () => {
    [el('email').value, el('senha').value] = perfis[botao.dataset.perfil];
    atualizarSelecao();
  });
}
el('login').addEventListener('input', atualizarSelecao);
el('ver-senha').addEventListener('click', () => mostrarSenha(el('senha').type === 'password'));
el('login').addEventListener('submit', async evento => {
  evento.preventDefault();
  await consultar('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: el('email').value, senha: el('senha').value })
  });
  if (sessao) el('sair').focus({ preventScroll: true });
});
async function testarRota(rota, destacar = false) {
  await consultar('/api/' + rota, {
    headers: sessao ? { Authorization: 'Bearer ' + sessao.token } : {}
  });
  if (destacar || window.matchMedia('(max-width: 720px)').matches) {
    el('painel').focus({ preventScroll: true });
    el('painel').scrollIntoView({ block: 'nearest' });
  }
}
for (const botao of rotas) {
  botao.addEventListener('click', () => testarRota(botao.dataset.rota));
}
el('testar').addEventListener('click', () => testarRota('circulacao', true));
el('limpar').addEventListener('click', () => {
  for (const item of perfisDoRelatorio) {
    delete item.dataset.codigo;
    item.querySelector('strong').textContent = 'A testar';
  }
  el('limpar').hidden = true;
  el('comparacao').focus({ preventScroll: true });
});

function atualizarNavegacao() {
  const apresentando = document.body.classList.contains('apresentando');
  const padrao = apresentando ? '#carteira' : '#inicio';
  const destino = linksNavegacao.some(link => link.hash === location.hash && (!apresentando || link.hash !== '#inicio'))
    ? location.hash
    : padrao;
  for (const link of linksNavegacao) {
    if (link.hash === destino) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', atualizarNavegacao);
atualizarNavegacao();
el('modo').addEventListener('click', () => {
  const ativo = document.body.classList.toggle('apresentando');
  el('modo').setAttribute('aria-pressed', String(ativo));
  el('rotulo-modo').textContent = ativo ? 'Sair da apresentação' : 'Modo apresentação';
  atualizarNavegacao();
  window.scrollTo(0, 0);
});
el('sair').addEventListener('click', () => {
  encerrar();
  resultado('Sem sessão', 'Saída da conta', 'O navegador descartou o JWT. Você pode testar outro perfil.');
  seletores[0].focus({ preventScroll: true });
});
