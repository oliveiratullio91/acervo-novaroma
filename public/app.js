const el = id => document.getElementById(id);
const perfis = {
  leitor: ['leitor@acervo.test', 'Leitura!104'],
  equipe: ['equipe@acervo.test', 'Equipe!208']
};
const botoes = [...document.querySelectorAll('button')];
const rotas = [...document.querySelectorAll('[data-rota]')];
const perfisDoRelatorio = ['Sem login', 'Leitor', 'Bibliotecária'];
const comparativo = new Map();
let sessao = null;
let validade;

function resultado(status, caminho, mensagem, corpo, tinhaToken = false) {
  el('status').textContent = Number.isInteger(status) ? 'HTTP ' + status : status;
  el('requisicao').textContent = caminho;
  el('motivo').textContent = mensagem;
  el('decisao').closest('.console').dataset.estado = String(status);
  el('detalhes').hidden = !corpo;
  el('resposta').textContent = corpo ? JSON.stringify(corpo, null, 2) : '';
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
  comparativo.set(perfil, status);
  const linhas = perfisDoRelatorio.map(identidade => {
    const item = document.createElement('li');
    const codigo = comparativo.get(identidade);
    item.classList.toggle('pendente', codigo === undefined);
    if (codigo !== undefined) item.dataset.codigo = String(codigo);
    const resultadoHttp = document.createElement('strong');
    resultadoHttp.textContent = codigo === undefined ? 'A testar' : 'HTTP ' + codigo;
    item.append(identidade, resultadoHttp);
    return item;
  });
  el('historico').replaceChildren(...linhas);
  el('comparacao').hidden = false;
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
  el('estado-conta').textContent = dados.nome + ' · ' + papel;
  el('estado-conta').dataset.ativa = 'true';
  el('expira').textContent = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' })
    .format(new Date(Date.now() + dados.expiraEm * 1000));
  el('login').hidden = true;
  el('sessao').hidden = false;
  validade = setTimeout(() => {
    encerrar();
    resultado('Expirado', 'Sessão encerrada', 'O JWT atingiu o prazo de validade. Entre novamente.');
  }, dados.expiraEm * 1000);
}

function resumir(caminho, dados) {
  if (dados.mensagem) return dados.mensagem;
  if (caminho === '/api/login') return 'Senha confirmada. A API emitiu um JWT válido por cinco minutos.';
  if (caminho === '/api/circulacao') {
    return 'Acesso permitido. ' + dados.emprestimosAtivos + ' empréstimos ativos entre ' + dados.leitoresComEmprestimos + ' leitores.';
  }
  return dados.leitor + ' tem os seguintes títulos em empréstimo: ' + dados.livros.map(livro => livro.titulo).join(', ') + '.';
}

async function consultar(caminho, opcoes = {}) {
  const identidade = sessao?.papel ?? 'Sem login';
  const tinhaToken = Boolean(sessao?.token);
  const metodo = opcoes.method ?? 'GET';
  const rota = metodo + ' ' + caminho;
  botoes.forEach(botao => { botao.disabled = true; });
  el('erro-login').hidden = true;
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
    resultado('Indisponível', rota, 'O servidor não respondeu. Verifique a conexão e tente outra vez.');
  } finally {
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
  comparativo.clear();
  el('historico').replaceChildren();
  el('comparacao').hidden = true;
  rotas[0].focus();
});
el('modo').addEventListener('click', () => {
  const ativo = document.body.classList.toggle('apresentando');
  el('modo').setAttribute('aria-pressed', String(ativo));
  el('rotulo-modo').textContent = ativo ? 'Sair da apresentação' : 'Modo apresentação';
  window.scrollTo(0, 0);
});
el('sair').addEventListener('click', () => {
  encerrar();
  resultado('Sem sessão', 'Saída da conta', 'O navegador descartou o JWT. Você pode testar outro perfil.');
  seletores[0].focus({ preventScroll: true });
});
