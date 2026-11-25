import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { criarAplicacao } from '../servidor.js';
import { conectarBanco } from '../banco.js';

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
  const app = await criarAplicacao({ pool, esquema });
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
test('leitor vê apenas os próprios livros e recebe 403 no relatório', async () => {
  const sessao = await login('leitor@acervo.test', 'Leitura!104');
  assert.equal(sessao.status, 200);
  const { token } = await sessao.json();
  const resposta = await consulta('meus-emprestimos', token);
  assert.equal(resposta.status, 200);
  assert.deepEqual((await resposta.json()).livros.map(livro => livro.titulo), ['Dom Casmurro', 'O Quinze']);
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
});
