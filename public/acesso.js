import { solicitarApi } from '/api.js';
import { caminhoLeitores, filtrosLeitores } from '/conta/busca-leitores.js';

const formulario = document.getElementById('formulario-acesso');
const email = document.getElementById('email');
const senha = document.getElementById('senha');
const enviar = document.getElementById('enviar');
const aviso = document.getElementById('erro-acesso');
const cadastro = formulario.dataset.modo === 'cadastro';
const parametros = new URLSearchParams(location.search);
const livro = parametros.get('livro');
const livroValido = /^[a-z0-9-]{1,64}$/.test(livro ?? '') ? livro : null;
const telaPedida = parametros.get('tela') || parametros.get('aba') || location.hash.slice(1);
const leitorId = ['leitor', 'leitores'].includes(telaPedida) ? parametros.get('id') : null;
const fichaPedida = Boolean(leitorId && leitorId !== '.' && leitorId !== '..');
const telaValida = fichaPedida || ['reservas', 'emprestimos', 'historico', 'perfil', 'circulacao', 'leitores', 'acervo', 'inventario', 'balcao', 'indicadores', 'retiradas', 'estante', 'carteira'].includes(telaPedida);
const contasDemo = {
  leitor: ['leitor@acervo.test', 'Leitura!104'],
  equipe: ['equipe@acervo.test', 'Equipe!208']
};

function destino(caminho, valores = {}) {
  const consulta = new URLSearchParams(valores);
  if (livroValido) consulta.set('livro', livroValido);
  else if (telaValida) {
    consulta.set('tela', telaPedida);
    if (fichaPedida) consulta.set('id', leitorId);
    if (telaPedida === 'leitores') {
      for (const [chave, valor] of filtrosLeitores(parametros)) consulta.set(chave, valor);
    }
  }
  const busca = consulta.toString();
  return busca ? caminho + '?' + busca : caminho;
}

const outraPagina = document.getElementById('outra-pagina');
outraPagina.href = destino(outraPagina.pathname);
if (!cadastro) {
  const mensagem = document.getElementById('confirmacao-acesso');
  if (parametros.get('criada') === '1') mensagem.textContent = 'Conta criada. Entre com seu e-mail e senha.';
  else if (parametros.get('senha') === 'alterada') mensagem.textContent = 'Senha atualizada. Entre com a nova senha.';
  else if (parametros.get('sessao') === 'expirada') mensagem.textContent = 'Sua sessão terminou. Entre novamente para continuar.';
  mensagem.hidden = !mensagem.textContent;
}

function mostrarErro(mensagem = '') {
  aviso.textContent = mensagem;
  aviso.hidden = !mensagem;
}

formulario.addEventListener('input', () => mostrarErro());
const demo = document.querySelector('.demo');
if (demo) solicitarApi('/ambiente').then(ambiente => { demo.hidden = !ambiente.demonstracao; }).catch(() => {});
for (const botao of document.querySelectorAll('[data-demo]')) {
  botao.addEventListener('click', () => {
    [email.value, senha.value] = contasDemo[botao.dataset.demo];
    mostrarErro();
    enviar.focus();
  });
}

formulario.addEventListener('submit', async evento => {
  evento.preventDefault();
  if (enviar.disabled) return;
  mostrarErro();

  const corpo = { email: email.value, senha: senha.value };
  if (cadastro) {
    const confirmacao = document.getElementById('confirmar-senha');
    if (confirmacao.value !== senha.value) {
      mostrarErro('As senhas precisam ser iguais.');
      confirmacao.focus();
      return;
    }
    corpo.nome = document.getElementById('nome').value;
  }

  const rotulo = enviar.textContent;
  enviar.disabled = true;
  enviar.textContent = cadastro ? 'Criando conta…' : 'Entrando…';
  try {
    await solicitarApi(cadastro ? '/cadastro' : '/sessao', { metodo: 'POST', corpo });
    if (cadastro) {
      location.replace(destino('/entrar/', { criada: '1' }));
    } else {
      let conta = telaValida ? '/conta/' + telaPedida + '/' : '/conta/';
      if (telaPedida === 'leitores') conta = caminhoLeitores(filtrosLeitores(parametros), fichaPedida ? leitorId : null);
      else if (fichaPedida) conta = '/conta/circulacao/leitores/' + encodeURIComponent(leitorId) + '/';
      location.replace(livroValido ? destino('/catalogo/') : conta);
    }
  } catch (erro) {
    mostrarErro(erro.message);
    enviar.disabled = false;
    enviar.textContent = rotulo;
  }
});
