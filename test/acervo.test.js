import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { criarAplicacao } from '../servidor.js';
import { conectarBanco } from '../banco.js';
import { diaDaBiblioteca } from '../public/conta/calendario.js';

let servidor;
let base;
let pool;
const esquema = 'acervo_teste_' + randomUUID().replaceAll('-', '');
let criouEsquema = false;
before(async () => {
  pool = conectarBanco();
  await pool.query(`CREATE SCHEMA ${esquema}`);
  criouEsquema = true;
  await iniciarServidor();
});
async function iniciarServidor() {
  const app = await criarAplicacao({ pool, esquema, enviar: null });
  servidor = app.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  base = 'http://127.0.0.1:' + servidor.address().port;
}
function fecharServidor() {
  return new Promise((resolve, reject) => servidor.close(erro => erro ? reject(erro) : resolve()));
}
after(async () => {
  try {
    if (servidor?.listening) await fecharServidor();
    if (criouEsquema) await pool.query(`DROP SCHEMA ${esquema} CASCADE`);
  } finally {
    await pool?.end();
  }
});

function login(email, senha) {
  return fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha })
  });
}
function consulta(rota, token) {
  return fetch(base + '/api/' + rota, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
}

test('as duas consultas exigem login', async () => {
  for (const rota of ['meus-emprestimos', 'circulacao']) {
    assert.equal((await consulta(rota)).status, 401);
  }
});
test('senha incorreta não abre sessão', async () => {
  const resposta = await login('leitor@acervo.test', 'incorreta');
  assert.equal(resposta.status, 401);
  assert.equal((await resposta.json()).token, undefined);
});

test('as páginas da conta e o relatório respeitam o perfil da sessão do site', async () => {
  const visitante = await fetch(base + '/conta/historico/', { redirect: 'manual' });
  assert.equal(visitante.headers.get('location'), '/entrar/?tela=historico');
  const caminhoFicha = '/conta/circulacao/leitores/L-104/';
  const fichaSemLogin = await fetch(base + caminhoFicha, { redirect: 'manual' });
  assert.equal(fichaSemLogin.headers.get('location'), '/entrar/?tela=leitor&id=L-104');
  const viaDiretorio = await fetch(base + '/conta/leitores/L-104/?nome=Alves&pagina=2', { redirect: 'manual' });
  assert.equal(viaDiretorio.headers.get('location'), '/entrar/?tela=leitores&id=L-104&nome=Alves&pagina=2');
  assert.equal((await consulta('conta/circulacao')).status, 401);
  for (const [email, senha, inicio] of [
    ['leitor@acervo.test', 'Leitura!104', 'reservas'],
    ['equipe@acervo.test', 'Equipe!208', 'circulacao']
  ]) {
    const sessao = await fetch(base + '/api/sessao', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha })
    });
    const headers = { Cookie: sessao.headers.get('set-cookie').split(';')[0] };
    const abrir = caminho => fetch(base + caminho, { headers, redirect: 'manual' });
    assert.equal((await abrir('/conta/')).headers.get('location'), '/conta/' + inicio + '/');
    const equipe = inicio === 'circulacao';
    const ficha = await abrir(caminhoFicha);
    if (equipe) {
      assert.equal(ficha.status, 200);
      assert.match(await ficha.text(), /data-tela="leitor"/);
      assert.equal((await abrir('/api/conta/leitores/L-104')).status, 200);
    } else {
      assert.equal(ficha.headers.get('location'), '/conta/reservas/');
      assert.equal((await abrir('/api/conta/leitores/B-208')).status, 403);
    }
    for (const tela of ['reservas', 'emprestimos', 'historico', 'perfil', 'circulacao', 'leitores']) {
      const resposta = await abrir('/conta/' + tela + '/');
      if (['circulacao', 'leitores'].includes(tela) && !equipe) {
        assert.equal(resposta.headers.get('location'), '/conta/reservas/');
        continue;
      }
      assert.equal(resposta.status, 200);
      const html = await resposta.text();
      assert.deepEqual([...html.matchAll(/<section class="conta-cartao" id="([^"]+)"/g)].map(m => m[1]), [tela]);
      assert.ok(html.includes('href="/conta/' + tela + '/" aria-current="page"'));
      assert.equal(html.includes('href="/conta/circulacao/"'), equipe);
      assert.equal(html.includes('href="/conta/leitores/"'), equipe);
      assert.equal(html.includes('id="dialogo-prazo"'), tela === 'circulacao');
    }
    const relatorio = await abrir('/api/conta/circulacao');
    assert.equal(relatorio.status, equipe ? 200 : 403);
    if (equipe) {
      const dados = await relatorio.json();
      assert.equal(dados.emprestimosAtivos, dados.emprestimos.length);
      assert.equal(dados.leitoresComEmprestimos, 2);
      assert.ok(dados.emprestimos.every(e => /^AC-\d+$/.test(e.tombo)));
      assert.equal(new Set(dados.emprestimos.map(e => e.tombo)).size, 3);
      assert.deepEqual(dados.emprestimos.map(({tombo,...emprestimo}) => emprestimo), [
        { id: '3', titulo: 'Clara dos Anjos', autor: 'Lima Barreto', livroId: 'clara-dos-anjos', leitor: 'Lia Ramos', leitorId: 'B-208', prazoDevolucao: null },
        { id: '1', titulo: 'Dom Casmurro', autor: 'Machado de Assis', livroId: 'dom-casmurro', leitor: 'Caio Alves', leitorId: 'L-104', prazoDevolucao: null },
        { id: '2', titulo: 'O Quinze', autor: 'Rachel de Queiroz', livroId: 'o-quinze', leitor: 'Caio Alves', leitorId: 'L-104', prazoDevolucao: null }
      ]);
    }
  }
});

test('diretório restrito à equipe pesquisa leitores sem empréstimos e pagina homônimos', async () => {
  const rota = 'conta/leitores';
  const { token: leitor } = await (await login('leitor@acervo.test', 'Leitura!104')).json();
  const { token: equipe } = await (await login('equipe@acervo.test', 'Equipe!208')).json();
  assert.equal((await consulta(rota)).status, 401);
  assert.equal((await consulta(rota + '?nome=Caio', leitor)).status, 403);
  const pesquisar = async (nome, pagina = 1) => {
    const parametros = new URLSearchParams({ nome, pagina });
    const resposta = await consulta(rota + '?' + parametros, equipe);
    assert.equal(resposta.status, 200);
    return resposta.json();
  };
  const { leitores: iniciais } = await pesquisar('');
  assert.deepEqual(iniciais.map(l => [l.id, l.emprestimosAtivos]), [['L-104', 2]]);
  await pool.query(`INSERT INTO ${esquema}.contas (id, nome, email, papel, senha_hash)
    SELECT 'busca-' || n, 'Júlia do Vale', 'julia' || n || '@acervo.test', 'leitor', c.senha_hash
    FROM ${esquema}.contas c CROSS JOIN generate_series(1, 21) n WHERE c.id = 'L-104'`);
  const primeira = await pesquisar('  JULIA  ');
  const segunda = await pesquisar('VALE', 2);
  assert.equal(primeira.leitores.length, 20);
  assert.equal(primeira.temProxima, true);
  assert.equal(segunda.temProxima, false);
  assert.equal(segunda.leitores.length, 1);
  const encontrados = [...primeira.leitores, ...segunda.leitores];
  assert.equal(new Set(encontrados.map(l => l.id)).size, 21);
  assert.ok(encontrados.every(l => l.emprestimosAtivos === 0));
  const [registro] = segunda.leitores;
  const ficha = await (await consulta(rota + '/' + registro.id, equipe)).json();
  assert.equal(ficha.leitor.email, registro.email);
  assert.deepEqual(ficha.livros, []);
  assert.deepEqual((await pesquisar('%')).leitores, []);
  assert.equal((await consulta(rota + '?pagina=0', equipe)).status, 400);
});

test('cadastro cria um leitor com senha protegida e login separado por cookie', async () => {
  const email = 'cadastro@acervo.test';
  const senha = 'Senha biblioteca 26';
  const cadastrar = senhaInformada => fetch(base + '/api/cadastro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Leitora cadastrada', email: ' Cadastro@acervo.test ', senha: senhaInformada, papel: 'bibliotecaria' })
  });
  assert.equal((await cadastrar('curta')).status, 400);
  const respostas = await Promise.all([cadastrar(senha), cadastrar(senha)]);
  assert.deepEqual(respostas.map(resposta => resposta.status).sort(), [201, 409]);
  assert.equal(respostas.find(resposta => resposta.status === 201).headers.get('set-cookie'), null);
  assert.equal((await consulta('sessao')).status, 204);

  const { rows: [conta] } = await pool.query(
    'SELECT papel, senha_hash FROM ' + esquema + '.contas WHERE email = $1', [email]
  );
  assert.equal(conta.papel, 'leitor');
  assert.notEqual(conta.senha_hash, senha);
  assert.equal(await bcrypt.compare(senha, conta.senha_hash), true);

  const inicio = await fetch(base + '/api/sessao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, senha })
  });
  assert.equal(inicio.status, 200);
  const perfil = await inicio.json();
  assert.equal(perfil.nome, 'Leitora cadastrada');
  assert.equal(perfil.token, undefined);
  const sessao = inicio.headers.get('set-cookie');
  assert.match(sessao, /HttpOnly/i);
  assert.match(sessao, /SameSite=Lax/i);
  const cookie = sessao.split(';')[0];
  const opcoes = { headers: { Cookie: cookie } };
  const recuperada = await (await fetch(base + '/api/sessao', opcoes)).json();
  assert.equal(recuperada.papel, 'leitor');
  const painel = await (await fetch(base + '/api/conta', opcoes)).json();
  assert.deepEqual(painel.perfil, { nome: perfil.nome, email, papel: 'leitor', demonstracao: false });
  assert.deepEqual([painel.livros, painel.reservas, painel.historico], [[], [], []]);
  assert.equal((await fetch(base + '/conta/', opcoes)).status, 200);
  const semSessao = await fetch(base + '/conta/', { redirect: 'manual' });
  assert.equal(semSessao.status, 302);
  assert.equal(semSessao.headers.get('location'), '/entrar/');
  assert.equal((await fetch(base + '/api/circulacao', opcoes)).status, 401);

  const alterar = (parte, corpo) => fetch(base + '/api/conta/' + parte, {
    method: 'PATCH',
    headers: { ...opcoes.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  });
  const novoNome = 'Leitora com perfil atualizado';
  assert.equal((await alterar('perfil', { nome: novoNome })).status, 200);
  assert.equal((await (await fetch(base + '/api/conta', opcoes)).json()).perfil.nome, novoNome);
  const novaSenha = 'Minha nova senha 2026';
  assert.equal((await alterar('senha', { senhaAtual: 'Senha antiga errada', novaSenha })).status, 400);
  const tokenAntesDaTroca = (await (await login(email, senha)).json()).token;
  assert.equal((await alterar('senha', { senhaAtual: senha, novaSenha })).status, 204);
  assert.equal((await fetch(base + '/api/conta', opcoes)).status, 401);
  assert.equal((await consulta('conta', tokenAntesDaTroca)).status, 401);
  assert.equal((await login(email, senha)).status, 401);
  assert.equal((await login(email, novaSenha)).status, 200);

  const saida = await fetch(base + '/api/sessao', { ...opcoes, method: 'DELETE' });
  assert.equal(saida.status, 204);
  assert.match(saida.headers.get('set-cookie'), /^acervo_sessao=;/);
});
test('leitor vê apenas os próprios livros e recebe 403 no relatório', async () => {
  const sessao = await login('leitor@acervo.test', 'Leitura!104');
  assert.equal(sessao.status, 200);
  const { token } = await sessao.json();
  const resposta = await consulta('meus-emprestimos', token);
  assert.equal(resposta.status, 200);
  assert.deepEqual((await resposta.json()).livros.map(livro => livro.titulo), ['Dom Casmurro', 'O Quinze']);
  const conta = await (await consulta('conta', token)).json();
  assert.deepEqual(conta.livros.map(livro => livro.livroId), ['dom-casmurro', 'o-quinze']);
  assert.equal((await consulta('circulacao', token)).status, 403);
});
test('equipe consulta o relatório e sua própria lista', async () => {
  const sessao = await login('equipe@acervo.test', 'Equipe!208');
  assert.equal(sessao.status, 200);
  const { token } = await sessao.json();
  const relatorio = await consulta('circulacao', token);
  assert.equal(relatorio.status, 200);
  assert.deepEqual(await relatorio.json(), { emprestimosAtivos: 3, leitoresComEmprestimos: 2 });
  assert.equal((await (await consulta('meus-emprestimos', token)).json()).livros.length, 1);
});

test('nova conta e empréstimo continuam disponíveis após reiniciar a aplicação', async () => {
  const hash = await bcrypt.hash('Senha de ensaio', 10);
  await pool.query(`INSERT INTO ${esquema}.contas (id, nome, papel, email, senha_hash)
    VALUES ('teste', 'Leitora de teste', 'leitor', 'teste@acervo.test', $1)`, [hash]);
  await pool.query(`INSERT INTO ${esquema}.emprestimos (conta_id, titulo, autor)
    VALUES ('teste', 'Úrsula', 'Maria Firmina dos Reis')`);
  const sessaoAnterior = await login('teste@acervo.test', 'Senha de ensaio');
  const tokenAnterior = (await sessaoAnterior.json()).token;
  await fecharServidor();
  await pool.end();
  pool = conectarBanco();
  await iniciarServidor();
  assert.equal((await consulta('meus-emprestimos', tokenAnterior)).status, 200);
  const sessao = await login('teste@acervo.test', 'Senha de ensaio');
  assert.equal(sessao.status, 200);
  const resposta = await consulta('meus-emprestimos', (await sessao.json()).token);
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), {
    leitor: 'Leitora de teste', livros: [{ titulo: 'Úrsula', autor: 'Maria Firmina dos Reis' }]
  });
  const conta = await (await consulta('conta', tokenAnterior)).json();
  const equipe = await (await login('equipe@acervo.test', 'Equipe!208')).json();
  const relatorio = await (await consulta('conta/circulacao', equipe.token)).json();
  assert.equal(relatorio.emprestimosAtivos, 4);
  assert.equal(relatorio.leitoresComEmprestimos, 3);
  const legado = relatorio.emprestimos.find(item => item.leitorId === 'teste');
  assert.deepEqual(conta.livros, [{ id: legado.id, titulo: 'Úrsula', autor: 'Maria Firmina dos Reis', livroId: null, registradoPor: null, prazoDevolucao: null, diasEmAtraso: 0 }]);
  const detalhe = await (await consulta('conta/emprestimos/' + legado.id, tokenAnterior)).json();
  assert.deepEqual(detalhe.eventos, [{ tipo: 'retirada', data: null, responsavel: null, prazoAnterior: null, prazoNovo: null }]);
  assert.equal(legado.titulo, 'Úrsula');
  assert.equal(legado.leitor, 'Leitora de teste');
  assert.equal(legado.livroId, null);
});

test('catálogo público considera empréstimos existentes e reservas exigem sessão', async () => {
  const resposta = await fetch(base + '/api/catalogo');
  assert.equal(resposta.status, 200);
  const { livros } = await resposta.json();
  assert.equal(livros.length, 16);
  const capas = await Promise.all(livros.map(livro => fetch(base + '/capas/' + livro.id + '.webp')));
  assert.ok(capas.every(capa => capa.ok && capa.headers.get('content-type') === 'image/webp'));
  await Promise.all(capas.map(capa => capa.body.cancel()));
  assert.equal(livros.find(livro => livro.id === 'clara-dos-anjos').disponiveis, 0);
  assert.equal(livros.find(livro => livro.id === 'dom-casmurro').disponiveis, 2);
  assert.equal((await consulta('minhas-reservas')).status, 401);
  assert.equal((await fetch(base + '/api/reservas', { method: 'POST' })).status, 401);
});

test('a ficha da equipe identifica o leitor e separa suas movimentações, incluindo todo o histórico', async () => {
  const rota = 'conta/leitores/';
  const leitor = await (await login('leitor@acervo.test', 'Leitura!104')).json();
  const equipe = await (await login('equipe@acervo.test', 'Equipe!208')).json();
  assert.equal((await consulta(rota + 'L-104')).status, 401);
  assert.equal((await consulta(rota + 'L-104', leitor.token)).status, 403);
  assert.equal((await consulta(rota + 'inexistente', equipe.token)).status, 404);
  const ficha = async id => {
    const resposta = await consulta(rota + id, equipe.token);
    assert.equal(resposta.status, 200);
    return resposta.json();
  };
  // Um homônimo com histórico maior que o limite da área pessoal.
  const id = randomUUID();
  await pool.query(`INSERT INTO ${esquema}.contas (id, nome, email, papel, senha_hash)
    SELECT $1, nome, 'homonimo@acervo.test', papel, senha_hash FROM ${esquema}.contas WHERE id = 'L-104'`, [id]);
  const inicial = await ficha(id);
  assert.deepEqual([inicial.livros, inicial.reservas, inicial.historico], [[], [], []]);
  await pool.query(`INSERT INTO ${esquema}.reservas (conta_id, livro_id, retirada_ate)
    SELECT $1, 'o-alienista', now() - n * interval '1 day' FROM generate_series(1, 21) AS n`, [id]);
  await pool.query(`INSERT INTO ${esquema}.reservas (conta_id, livro_id) VALUES ($1, 'o-quinze')`, [id]);
  const homonimo = await ficha(id);
  assert.deepEqual(homonimo.leitor, { id, nome: 'Caio Alves', email: 'homonimo@acervo.test', papel: 'leitor' });
  assert.equal(homonimo.reservas[0].titulo, 'O Quinze');
  assert.equal(homonimo.historico.length, 21);
  assert.ok(homonimo.historico.every(r => r.situacao === 'expirada'));
  const caio = await ficha('L-104');
  assert.deepEqual(caio.livros.map(l => [l.id, l.titulo]), [['1', 'Dom Casmurro'], ['2', 'O Quinze']]);
  assert.deepEqual([caio.reservas, caio.historico], [[], []]);
  assert.equal((await ficha('B-208')).livros[0].titulo, 'Clara dos Anjos');
});

test('reservas concorrentes do mesmo leitor não duplicam e o exemplar é liberado no cancelamento', async () => {
  const leitor = await (await login('leitor@acervo.test', 'Leitura!104')).json();
  const equipe = await (await login('equipe@acervo.test', 'Equipe!208')).json();
  const reservar = () => fetch(base + '/api/reservas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + leitor.token },
    body: JSON.stringify({ livroId: 'o-alienista' })
  });
  const respostas = await Promise.all([reservar(), reservar()]);
  assert.deepEqual(respostas.map(resposta => resposta.status).sort(), [201, 409]);
  const { reserva } = await respostas.find(resposta => resposta.status === 201).json();

  async function exemplaresDisponiveis() {
    const { livros } = await (await consulta('catalogo')).json();
    return livros.find(livro => livro.id === 'o-alienista').disponiveis;
  }
  async function cancelar(token, id = reserva.id) {
    return fetch(base + '/api/reservas/' + id, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token }
    });
  }

  assert.equal(await exemplaresDisponiveis(), 1);
  await fecharServidor();
  await iniciarServidor();
  const lista = await (await consulta('minhas-reservas', leitor.token)).json();
  assert.equal(lista.reservas[0].id, reserva.id);
  assert.equal(lista.reservas[0].titulo, 'O Alienista');
  const conta = await (await consulta('conta', leitor.token)).json();
  assert.equal(conta.reservas[0].livroId, 'o-alienista');
  assert.equal((await cancelar(equipe.token)).status, 404);
  assert.equal((await cancelar(leitor.token)).status, 204);
  assert.equal((await cancelar(leitor.token)).status, 404);
  assert.equal(await exemplaresDisponiveis(), 2);
  assert.deepEqual(await (await consulta('minhas-reservas', leitor.token)).json(), { reservas: [] });
  const { historico } = await (await consulta('conta', leitor.token)).json();
  assert.equal(historico.length, 1);
  const [cancelada] = historico;
  assert.equal(cancelada.id, reserva.id);
  assert.equal(cancelada.situacao, 'cancelada');
  assert.equal(cancelada.livroId, 'o-alienista');

  const novaResposta = await reservar();
  assert.equal(novaResposta.status, 201);
  const { reserva: novaReserva } = await novaResposta.json();
  assert.notEqual(novaReserva.id, reserva.id);
  assert.equal((await cancelar(leitor.token, novaReserva.id)).status, 204);
  const contaAtualizada = await (await consulta('conta', leitor.token)).json();
  assert.deepEqual(contaAtualizada.historico.map(item => [item.id, item.situacao]), [
    [novaReserva.id, 'cancelada'], [reserva.id, 'cancelada']
  ]);
  const ficha = await (await consulta('conta/leitores/L-104', equipe.token)).json();
  assert.deepEqual(ficha.historico, contaAtualizada.historico);
  assert.deepEqual((await (await consulta('conta', equipe.token)).json()).historico, []);
});

test('balcão registra empréstimos e devoluções, respeita reservas e mantém um único histórico', async () => {
  const leitor = (await (await login('leitor@acervo.test', 'Leitura!104')).json()).token;
  const equipe = (await (await login('equipe@acervo.test', 'Equipe!208')).json()).token;
  const mover = (rota, metodo, token, corpo) => fetch(base + '/api/' + rota, {
    method: metodo, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: corpo && JSON.stringify(corpo)
  });
  const emprestar = (conta, livro, token = equipe) => mover('conta/leitores/' + conta + '/emprestimos', 'POST', token, {
    livroId: livro, prazoDevolucao: diaDaBiblioteca()
  });
  const devolver = (conta, id, token = equipe) => mover('conta/leitores/' + conta + '/emprestimos/' + id + '/devolucao', 'PUT', token);
  const consultar = async (rota, token = equipe) => (await consulta(rota, token)).json();
  const estoque = async livro => (await consultar('catalogo')).livros.find(l => l.id === livro).disponiveis;
  const ficha = id => consultar('conta/leitores/' + id);
  const conta = 'L-104';
  assert.equal((await emprestar(conta, 'alice', null)).status, 401);
  assert.equal((await emprestar(conta, 'alice', leitor)).status, 403);
  assert.equal((await devolver(conta, '1', null)).status, 401);
  assert.equal((await devolver(conta, '1', leitor)).status, 403);
  assert.equal((await emprestar('ausente', 'alice')).status, 404);
  assert.equal((await emprestar(conta, 'ausente')).status, 404);
  assert.equal((await emprestar(conta, '')).status, 400);
  assert.equal((await devolver(conta, '3')).status, 404);
  assert.equal((await emprestar(conta, 'clara-dos-anjos')).status, 409);

  const ativosAntes = (await consultar('circulacao')).emprestimosAtivos;
  await pool.query(`INSERT INTO ${esquema}.contas (id, nome, email, papel, senha_hash)
    VALUES ('B-310', 'Rui Silva', 'rui@acervo.test', 'bibliotecaria', $1)`, [await bcrypt.hash('Senha de ensaio', 10)]);
  const { token: rui } = await (await login('rui@acervo.test', 'Senha de ensaio')).json();
  const pedidos = await Promise.all([emprestar(conta, 'alice', rui), emprestar(conta, 'alice', rui)]);
  assert.deepEqual(pedidos.map(r => r.status).sort(), [201, 409]);
  const { emprestimo } = await pedidos.find(r => r.status === 201).json();
  assert.ok(emprestimo.emprestadoEm);
  assert.equal((await mover('conta/perfil', 'PATCH', rui, { nome: 'Rui Oliveira' })).status, 200);
  const ativo = (await ficha(conta)).livros.find(l => l.id === emprestimo.id);
  assert.equal(ativo.registradoPor, 'Rui Silva');
  assert.equal(ativo.recebidoPor, null);
  assert.equal((await consultar('conta', leitor)).livros.find(l => l.livroId === 'alice').registradoPor, 'Rui Silva');
  assert.equal(await estoque('alice'), 1);
  assert.equal((await consultar('circulacao')).emprestimosAtivos, ativosAntes + 1);
  assert.equal((await consultar('conta/leitores?nome=alves')).leitores.find(l => l.id === conta).emprestimosAtivos, 3);
  const repeticoes = await Promise.all([devolver(conta, emprestimo.id), devolver(conta, emprestimo.id)]);
  assert.ok(repeticoes.every(r => r.status === 204));
  const devolucoes = (await ficha(conta)).devolucoes;
  assert.equal(devolucoes.length, 1);
  assert.equal(devolucoes[0].id, emprestimo.id);
  assert.ok(devolucoes[0].devolvidoEm);
  assert.equal(devolucoes[0].registradoPor, 'Rui Silva');
  assert.equal(devolucoes[0].recebidoPor, 'Lia Ramos');
  assert.deepEqual((await consultar('conta', leitor)).devolucoes, devolucoes);
  assert.equal(await estoque('alice'), 2);
  assert.equal((await consultar('circulacao')).emprestimosAtivos, ativosAntes);
  assert.ok(!(await consultar('conta/circulacao')).emprestimos.some(e => e.id === emprestimo.id));
  assert.equal((await emprestar(conta, 'alice')).status, 201);
  assert.equal((await devolver(conta, emprestimo.id, rui)).status, 204);
  assert.equal(await estoque('alice'), 1);
  assert.deepEqual((await ficha(conta)).devolucoes, devolucoes);

  // A devolução de um empréstimo legado libera o único exemplar do catálogo.
  const unico = 'clara-dos-anjos';
  assert.equal((await devolver('B-208', '3')).status, 204);
  const devolvidoLegado = (await ficha('B-208')).devolucoes[0];
  assert.equal(devolvidoLegado.emprestadoEm, null);
  assert.equal(devolvidoLegado.registradoPor, null);
  assert.equal(devolvidoLegado.recebidoPor, 'Lia Ramos');
  const reserva = await mover('reservas', 'POST', leitor, { livroId: unico });
  assert.equal(reserva.status, 201);
  const { reserva: retirada } = await reserva.json();
  assert.equal(await estoque(unico), 0);
  assert.equal((await emprestar('B-208', unico)).status, 409);
  const entrega = await emprestar(conta, unico);
  assert.equal(entrega.status, 201);
  const aposRetirada = await ficha(conta);
  assert.ok(!aposRetirada.reservas.some(r => r.id === retirada.id));
  assert.equal(aposRetirada.historico.find(r => r.id === retirada.id).situacao, 'retirada');
  assert.equal((await mover('reservas/' + retirada.id, 'DELETE', leitor)).status, 404);
  assert.equal(await estoque(unico), 0);
  const { emprestimo: reservado } = await entrega.json();
  await devolver(conta, reservado.id);
  assert.equal(await estoque(unico), 1);
  const disputa = await Promise.all([emprestar(conta, unico), emprestar('B-208', unico)]);
  assert.deepEqual(disputa.map(r => r.status).sort(), [201, 409]);
  assert.equal(await estoque(unico), 0);
});

test('prazo é obrigatório, vale até o fim do dia em Fortaleza e determina o atraso nas duas contas', async () => {
  assert.equal(diaDaBiblioteca(new Date('2028-03-01T02:59:59Z')), '2028-02-29');
  assert.equal(diaDaBiblioteca(new Date('2028-03-01T03:00:00Z')), '2028-03-01');
  const { token: leitor } = await (await login('leitor@acervo.test', 'Leitura!104')).json();
  const { token: equipe } = await (await login('equipe@acervo.test', 'Equipe!208')).json();
  const hoje = diaDaBiblioteca();
  const dataRelativa = dias => {
    const data = new Date(hoje + 'T00:00:00Z');
    data.setUTCDate(data.getUTCDate() + dias);
    return data.toISOString().slice(0, 10);
  };
  const rota = '/api/conta/leitores/L-104/emprestimos';
  const headers = { Authorization: 'Bearer ' + equipe, 'Content-Type': 'application/json' };
  const livroId = 'mensagem';
  const registrar = prazoDevolucao => fetch(base + rota, {
    method: 'POST', headers, body: JSON.stringify({ livroId, prazoDevolucao })
  });
  for (const invalido of [undefined, null, '', dataRelativa(-1), '2099-02-30', '2099-13-25', '25/12/2099', hoje + 'T00:00:00Z']) {
    assert.equal((await registrar(invalido)).status, 400);
  }
  const futuro = dataRelativa(7);
  const novo = await registrar(futuro);
  assert.equal(novo.status, 201);
  const { emprestimo } = await novo.json();
  assert.equal(emprestimo.prazoDevolucao, futuro);
  const conferir = async (prazo, atraso, lista = 'livros') => {
    for (const [caminho, token] of [['conta', leitor], ['conta/leitores/L-104', equipe]]) {
      const dados = await (await consulta(caminho, token)).json();
      const livro = dados[lista].find(l => l.livroId === livroId);
      assert.equal(livro.prazoDevolucao, prazo);
      assert.equal(livro.diasEmAtraso, atraso);
      if (lista === 'devolucoes') assert.ok(!dados.livros.some(l => l.livroId === livroId));
    }
  };
  await conferir(futuro, 0);
  for (const dias of [0, -1, -3]) {
    const prazo = dataRelativa(dias);
    await pool.query(`UPDATE ${esquema}.emprestimos SET prazo_devolucao = $1 WHERE id = $2`, [prazo, emprestimo.id]);
    await conferir(prazo, Math.abs(dias));
  }
  assert.equal((await fetch(base + rota + '/' + emprestimo.id + '/devolucao', { method: 'PUT', headers })).status, 204);
  await conferir(dataRelativa(-3), 0, 'devolucoes');
});

test('a equipe define o primeiro prazo e renova empréstimos ativos na ficha correta', async () => {
  const { token: leitor } = await (await login('leitor@acervo.test', 'Leitura!104')).json();
  const { token: equipe } = await (await login('equipe@acervo.test', 'Equipe!208')).json();
  const hoje = diaDaBiblioteca();
  const { rows: [datas] } = await pool.query(`SELECT
    to_char($1::date - 1, 'YYYY-MM-DD') AS ontem,
    to_char($1::date + 1, 'YYYY-MM-DD') AS amanha,
    to_char($1::date + 7, 'YYYY-MM-DD') AS semana`, [hoje]);
  const { rows: [antigo] } = await pool.query(`INSERT INTO ${esquema}.emprestimos (conta_id, titulo, autor)
    VALUES ('L-104', 'Livro de arquivo', 'Autora de teste') RETURNING id::text`);
  const { rows: [vencido] } = await pool.query(`INSERT INTO ${esquema}.emprestimos
    (conta_id, titulo, autor, livro_id, prazo_devolucao)
    SELECT 'L-104', titulo, autor, id, $1 FROM ${esquema}.catalogo WHERE id = 'iracema' RETURNING id::text`, [datas.ontem]);
  const { rows: [legado] } = await pool.query(`INSERT INTO ${esquema}.renovacoes
    (emprestimo_id, prazo_anterior, prazo_novo) VALUES ($1, $2::date - 1, $2::date)
    RETURNING id::text`, [vencido.id, datas.ontem]);
  await pool.query(`INSERT INTO ${esquema}.contas (id, nome, email, papel, senha_hash)
    VALUES ('B-209', 'Ana Lima', 'ana@acervo.test', 'bibliotecaria', $1)`, [await bcrypt.hash('Senha de ensaio', 10)]);
  const { token: ana } = await (await login('ana@acervo.test', 'Senha de ensaio')).json();
  const alterar = (id, prazoDevolucao, token = equipe, conta = 'L-104') => fetch(
    base + '/api/conta/leitores/' + conta + '/emprestimos/' + id + '/prazo', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ prazoDevolucao })
    });
  const consultar = async (rota, token) => (await consulta(rota, token)).json();
  const estoque = async () => (await consultar('catalogo')).livros.find(l => l.id === 'iracema').disponiveis;
  const estoqueAntes = await estoque();
  const fichaAntes = await consultar('conta/leitores/L-104', equipe);
  assert.equal(fichaAntes.livros.find(l => l.id === vencido.id).diasEmAtraso, 1);
  assert.equal((await alterar(antigo.id, hoje, null)).status, 401);
  assert.equal((await alterar(antigo.id, hoje, leitor)).status, 403);
  assert.equal((await alterar(antigo.id, hoje, equipe, 'B-208')).status, 404);
  assert.equal((await alterar('9999999999999999999', hoje)).status, 404);
  for (const invalido of [undefined, null, datas.ontem, '2099-02-30']) {
    assert.equal((await alterar(antigo.id, invalido)).status, 400);
  }
  const primeiro = await alterar(antigo.id, hoje);
  assert.equal(primeiro.status, 200);
  assert.deepEqual(await primeiro.json(), { prazoDevolucao: hoje });
  assert.deepEqual((await consultar('conta', leitor)).renovacoes, fichaAntes.renovacoes);
  const simultaneas = await Promise.all([alterar(antigo.id, datas.semana), alterar(antigo.id, datas.semana)]);
  assert.deepEqual(simultaneas.map(r => r.status).sort(), [200, 409]);
  assert.equal((await alterar(antigo.id, datas.amanha)).status, 409);
  assert.equal((await alterar(vencido.id, datas.amanha)).status, 200);
  const ficha = await consultar('conta/leitores/L-104', equipe);
  assert.deepEqual(ficha.livros.map(l => l.id), fichaAntes.livros.map(l => l.id));
  assert.equal(ficha.livros.find(l => l.id === antigo.id).prazoDevolucao, datas.semana);
  assert.equal(await estoque(), estoqueAntes);
  const conta = await consultar('conta', leitor);
  const iracema = conta.livros.find(l => l.livroId === 'iracema');
  assert.equal(iracema.prazoDevolucao, datas.amanha);
  assert.equal(iracema.diasEmAtraso, 0);
  assert.equal((await alterar(vencido.id, datas.semana, ana)).status, 200);
  const relatorio = await consultar('conta/circulacao', equipe);
  assert.equal(relatorio.emprestimos.find(l => l.id === vencido.id).prazoDevolucao, datas.semana);
  const trocaNome = await fetch(base + '/api/conta/perfil', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ana },
    body: JSON.stringify({ nome: 'Ana Costa' })
  });
  assert.equal(trocaNome.status, 200);
  const devolucao = await fetch(base + '/api/conta/leitores/L-104/emprestimos/' + vencido.id + '/devolucao', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + equipe }
  });
  assert.equal(devolucao.status, 204);
  const aposDevolucao = await consultar('conta/circulacao', equipe);
  assert.equal(aposDevolucao.emprestimosAtivos, relatorio.emprestimosAtivos - 1);
  assert.ok(!aposDevolucao.emprestimos.some(l => l.id === vencido.id));
  assert.equal((await alterar(vencido.id, datas.semana)).status, 409);
  await fecharServidor();
  await iniciarServidor();
  const fichaFinal = await consultar('conta/leitores/L-104', equipe);
  assert.equal(fichaFinal.devolucoes.find(l => l.id === vencido.id).prazoDevolucao, datas.semana);
  assert.equal(fichaFinal.renovacoes.find(r => r.id === legado.id).nomeBibliotecario, null);
  const historico = fichaFinal.renovacoes.filter(r => [antigo.id, vencido.id].includes(r.emprestimoId) && r.id !== legado.id);
  assert.deepEqual(historico.map(r => r.nomeBibliotecario), ['Ana Lima', 'Lia Ramos', 'Lia Ramos']);
  assert.deepEqual(historico.map(r => [r.emprestimoId, r.prazoAnterior, r.prazoNovo]), [
    [vencido.id, datas.amanha, datas.semana],
    [vencido.id, datas.ontem, datas.amanha],
    [antigo.id, hoje, datas.semana]
  ]);
  assert.ok(historico.every(r => Number.isFinite(Date.parse(r.renovadoEm))));
  assert.ok(historico.every((r, i) => i === 0 || r.renovadoEm <= historico[i - 1].renovadoEm));
  assert.equal(historico[0].titulo, 'Iracema');
  assert.equal(historico[2].titulo, 'Livro de arquivo');
  assert.equal(historico[2].livroId, null);
  assert.deepEqual((await consultar('conta', leitor)).renovacoes, fichaFinal.renovacoes);
  assert.deepEqual((await consultar('conta', equipe)).renovacoes, []);
});

test('linha do tempo separa retiradas do mesmo título e respeita o leitor da ficha', async () => {
  const { token: leitor } = await (await login('leitor@acervo.test', 'Leitura!104')).json();
  const { token: equipe } = await (await login('equipe@acervo.test', 'Equipe!208')).json();
  const { rows: [primeiro, segundo] } = await pool.query(`INSERT INTO ${esquema}.emprestimos
    (conta_id, titulo, autor, emprestado_em, nome_registrante, devolvido_em, nome_recebedor) VALUES
    ('L-104', 'Livro de teste', 'Autora', '2026-02-01T10:00Z', 'Lia Ramos', '2026-02-15T15:30Z', 'Ana Lima'),
    ('L-104', 'Livro de teste', 'Autora', '2026-02-18T10:00Z', 'Ana Lima', NULL, NULL) RETURNING id::text`);
  await pool.query(`INSERT INTO ${esquema}.renovacoes
    (emprestimo_id, renovado_em, prazo_anterior, prazo_novo, renovado_por, nome_responsavel) VALUES
    ($1, '2026-02-10T11:00Z', '2026-02-11', '2026-02-16', 'B-208', 'Lia Ramos'),
    ($1, '2026-02-06T12:00Z', '2026-02-08', '2026-02-11', NULL, NULL)`, [primeiro.id]);
  const rota = 'conta/emprestimos/' + primeiro.id;
  const ficha = 'conta/leitores/L-104/emprestimos/' + primeiro.id;
  assert.equal((await consulta(rota)).status, 401);
  assert.equal((await consulta(rota, equipe)).status, 404);
  assert.equal((await consulta(ficha, leitor)).status, 403);
  assert.equal((await consulta('conta/leitores/B-208/emprestimos/' + primeiro.id, equipe)).status, 404);
  const detalhe = await (await consulta(rota, leitor)).json();
  assert.deepEqual(await (await consulta(ficha, equipe)).json(), detalhe);
  assert.equal(detalhe.emprestimoId, primeiro.id);
  assert.deepEqual(detalhe.eventos.map(e => [e.tipo, e.data, e.responsavel, e.prazoAnterior, e.prazoNovo]), [
    ['retirada', '2026-02-01T10:00:00.000Z', 'Lia Ramos', null, null],
    ['renovacao', '2026-02-06T12:00:00.000Z', null, '2026-02-08', '2026-02-11'],
    ['renovacao', '2026-02-10T11:00:00.000Z', 'Lia Ramos', '2026-02-11', '2026-02-16'],
    ['devolucao', '2026-02-15T15:30:00.000Z', 'Ana Lima', null, null]
  ]);
  const ativo = await (await consulta('conta/emprestimos/' + segundo.id, leitor)).json();
  assert.deepEqual(ativo.eventos.map(e => e.tipo), ['retirada']);
});

test('Swagger serve a documentação e descreve a autenticação JWT', async () => {
  const [pagina, recursos, spec] = await Promise.all([
    fetch(base + '/api-docs/'),
    fetch(base + '/api-docs/assets/swagger-ui-bundle.js'),
    fetch(base + '/api-docs/openapi.json')
  ]);
  assert.match(await pagina.text(), /id="swagger-ui"/);
  assert.equal(recursos.status, 200);
  await recursos.body.cancel();
  const openapi = await spec.json();
  assert.equal(openapi.components.securitySchemes.bearerAuth.bearerFormat, 'JWT');
  assert.deepEqual(openapi.paths['/api/circulacao'].get.security, [{ bearerAuth: [] }]);
  assert.ok(openapi.paths['/api/conta/senha'].patch.responses[204]);
  assert.ok(openapi.paths['/api/conta/leitores/{id}/emprestimos'].post.responses[201]);
  assert.ok(openapi.paths['/api/conta/leitores/{id}/emprestimos'].post.requestBody.content['application/json'].schema.required.includes('prazoDevolucao'));
  assert.ok(openapi.paths['/api/conta/leitores/{id}/emprestimos/{emprestimoId}/devolucao'].put.responses[204]);
  assert.ok(openapi.paths['/api/conta/leitores/{id}/emprestimos/{emprestimoId}/prazo'].patch.responses[200]);
});
