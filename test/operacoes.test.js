import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abrirAmbiente, esquemaNovo } from '../suporte-testes/biblioteca.js';
import { prepararBanco } from '../banco.js';
import { enviarLembretes } from '../correio.js';
import { salvarBackup, restaurarBackup } from '../scripts/backup.js';
import { diaDaBiblioteca } from '../public/conta/calendario.js';

test('operação integrada da biblioteca', async (t) => {
  const { requisitar, pool, esquema, cartas } = await abrirAmbiente(t);
  async function req(status, ...args) {
    const resposta = await requisitar(...args);
    assert.equal(resposta.status, status, args[1] + ' ' + JSON.stringify(resposta.dados));
    return resposta.dados;
  }
  const login = async (email, senha) => (await req(200, 'POST', '/login', null, { email, senha })).token;
  const equipe = await login('equipe@acervo.test', 'Equipe!208');
  const leitores = [];
  for (const nome of ['Alice', 'Beatriz', 'Carlos']) {
    const email = nome.toLowerCase() + '@acervo.test';
    await req(201, 'POST', '/cadastro', null, { nome, email, senha: 'Leituras123' });
    const token = await login(email, 'Leituras123');
    leitores.push({ ...(await req(200, 'GET', '/conta/carteira', token)), email, token });
  }
  const [a, b, c] = leitores,
    livros = '/equipe/livros',
    copias = '/equipe/exemplares';
  const edicao = {
    titulo: 'Rios da cidade',
    autor: 'Lia Melo',
    categoria: 'Literatura',
    edicao: '1ª',
    descricao: 'Ensaio de circulação.',
    capa: ''
  };
  let id, tombo, idEmprestimo;
  const data = diaDaBiblioteca(),
    amanha = diaDaBiblioteca(new Date(Date.now() + 86400000));
  const emprestimos = (p) => '/conta/leitores/' + p.id + '/emprestimos';
  const tomar = (p, reservaId) =>
    req(201, 'POST', emprestimos(p), equipe, { livroId: id, tombo, prazoDevolucao: data, reservaId });
  const lista = (p) => req(200, 'GET', '/conta/fila', p.token);
  const disponibilidade = async () =>
    (await req(200, 'GET', '/catalogo')).livros.find((l) => l.id === id)?.disponiveis;
  await t.test('perfis, edições, arquivo, tombos e conferência', async () => {
    await req(401, 'GET', livros);
    await req(403, 'POST', livros, a.token, edicao);
    id = (await req(200, 'POST', livros, equipe, edicao)).id;
    await req(409, 'POST', livros, equipe, edicao);
    const segunda = (await req(200, 'POST', livros, equipe, { ...edicao, edicao: '2ª' })).id;
    await req(200, 'PUT', livros + '/' + segunda, equipe, {
      ...edicao,
      edicao: '2ª',
      descricao: 'Texto revisto.'
    });
    await req(204, 'PATCH', livros + '/' + segunda + '/arquivo', equipe, { arquivado: true });
    assert.ok(!(await req(200, 'GET', '/catalogo')).livros.some((l) => l.id === segunda));
    const copia = { livroId: id, localizacao: 'E2 · P1', estado: 'regular' };
    tombo = (await req(200, 'POST', copias, equipe, copia)).tombo;
    await req(200, 'PUT', copias + '/' + tombo, equipe, { ...copia, estado: 'manutencao' });
    assert.equal(await disponibilidade(), 0);
    await req(200, 'PUT', copias + '/' + tombo, equipe, copia);
    await req(204, 'POST', copias + '/' + tombo + '/conferencia', equipe);
    assert.ok((await req(200, 'GET', copias, equipe)).find((x) => x.tombo === tombo).conferidoEm);
    assert.equal(await disponibilidade(), 1);
  });
  await t.test('balcão, fila FIFO e retirada de reserva por quem tem prioridade', async () => {
    idEmprestimo = (await tomar(a)).emprestimo.id;
    await req(409, 'PATCH', livros + '/' + id + '/arquivo', equipe, { arquivado: true });
    const entrada = (p) => req(204, 'PUT', '/conta/fila/' + id, p.token);
    await entrada(b);
    await entrada(b);
    await entrada(c);
    assert.equal((await lista(b))[0].posicao, 1);
    assert.equal((await lista(c))[0].posicao, 2);
    await req(409, 'PATCH', emprestimos(a) + '/' + idEmprestimo + '/prazo', equipe, {
      prazoDevolucao: amanha
    });
    await req(204, 'PUT', emprestimos(a) + '/' + idEmprestimo + '/devolucao', equipe);
    const reservas = await req(200, 'GET', '/equipe/reservas', equipe);
    const primeira = reservas.find((r) => r.livroId === id);
    assert.equal(primeira.leitorId, b.id);
    assert.ok(Date.parse(primeira.retirarAte) > Date.now() + 47 * 3600000);
    await req(409, 'POST', emprestimos(c), equipe, { livroId: id, prazoDevolucao: data });
    await req(204, 'DELETE', '/reservas/' + primeira.id, b.token);
    await req(404, 'DELETE', '/reservas/' + primeira.id, b.token);
    const segunda = (await req(200, 'GET', '/equipe/reservas', equipe)).find((r) => r.livroId === id);
    assert.equal(segunda.leitorId, c.id);
    await req(409, 'POST', emprestimos(c), equipe, {
      livroId: id,
      tombo,
      prazoDevolucao: data,
      reservaId: primeira.id
    });
    const emprestimo = (await tomar(c, segunda.id)).emprestimo;
    assert.equal((await req(200, 'GET', copias, equipe)).find((x) => x.tombo === tombo).leitorId, c.id);
    await req(204, 'PUT', emprestimos(c) + '/' + emprestimo.id + '/devolucao', equipe);
    assert.equal(await disponibilidade(), 1);
  });
  await t.test(
    'dois atendimentos não ocupam o mesmo tombo e duas cópias têm leitores distintos',
    async () => {
      const obra = (await req(200, 'POST', livros, equipe, { ...edicao, titulo: 'Manual da estante' })).id;
      const nova = () =>
        req(200, 'POST', copias, equipe, { livroId: obra, localizacao: 'F1', estado: 'regular' });
      const [x, y] = await Promise.all([nova(), nova()]);
      assert.notEqual(x.tombo, y.tombo);
      const pegar = (leitor, etiqueta) =>
        requisitar('POST', emprestimos(leitor), equipe, {
          livroId: obra,
          tombo: etiqueta,
          prazoDevolucao: data
        });
      const respostas = await Promise.all([pegar(b, x.tombo), pegar(c, x.tombo)]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 409]);
      const indice = respostas.findIndex((r) => r.status === 201),
        dono = [b, c][indice],
        segundo = [b, c][1 - indice];
      const outra = await pegar(segundo, y.tombo);
      assert.equal(outra.status, 201);
      const itens = (await req(200, 'GET', copias, equipe)).filter((i) => i.livroId === obra);
      assert.equal(itens.find((i) => i.tombo === x.tombo).leitorId, dono.id);
      assert.equal(itens.find((i) => i.tombo === y.tombo).leitorId, segundo.id);
      await req(409, 'PUT', copias + '/' + x.tombo, equipe, {
        livroId: obra,
        localizacao: 'F1',
        estado: 'extraviado'
      });
      for (const [leitor, id] of [
        [dono, respostas[indice].dados.emprestimo.id],
        [segundo, outra.dados.emprestimo.id]
      ]) {
        await req(204, 'PUT', emprestimos(leitor) + '/' + id + '/devolucao', equipe);
      }
    }
  );
  await t.test('correção mantém recebedor e justificativa, com reaplicação impedida', async () => {
    const rota = '/equipe/leitores/' + a.id + '/emprestimos/' + idEmprestimo + '/correcao';
    await req(403, 'POST', rota, a.token, { motivo: 'Conferência' });
    await req(204, 'POST', rota, equipe, { motivo: 'O exemplar permaneceu com a leitora.' });
    await req(409, 'POST', rota, equipe, { motivo: 'Duplicada' });
    const eventos = (await req(200, 'GET', '/conta/emprestimos/' + idEmprestimo, a.token)).eventos;
    assert.deepEqual(
      eventos.map((e) => e.tipo),
      ['retirada', 'devolucao', 'correcao']
    );
    assert.equal(eventos.at(-1).responsavel, 'Lia Ramos');
    assert.match(eventos.at(-1).motivo, /permaneceu/);
    await req(404, 'GET', '/conta/emprestimos/' + idEmprestimo, b.token);
    const regras = { dias: 7, limite: 1, renovacoes: 0, respeitar_fila: true };
    await req(204, 'PUT', '/equipe/regras', equipe, regras);
    assert.deepEqual(await req(200, 'GET', '/conta/regras', a.token), regras);
    await req(409, 'PATCH', emprestimos(a) + '/' + idEmprestimo + '/prazo', equipe, {
      prazoDevolucao: amanha
    });
    await req(409, 'POST', emprestimos(a), equipe, { livroId: 'mensagem', prazoDevolucao: data });
  });
  await t.test('estante, avisos por preferência e indicadores', async () => {
    await req(204, 'PUT', '/conta/estante/' + id, a.token);
    assert.equal((await req(200, 'GET', '/conta/estante', a.token))[0].id, id);
    assert.deepEqual(await req(200, 'GET', '/conta/estante', b.token), []);
    await req(204, 'DELETE', '/conta/estante/' + id, a.token);
    const mail = () => enviarLembretes(pool, esquema, async (carta) => cartas.push(carta));
    await mail();
    assert.equal(cartas.length, 0);
    await req(204, 'PATCH', '/conta/avisos-email', a.token, { ativar: true });
    await mail();
    await mail();
    assert.equal(cartas.length, 1);
    assert.equal(cartas[0].to, a.email);
    await pool.query(`UPDATE ${esquema}.emprestimos SET prazo_devolucao=$1::date-1 WHERE id=$2`, [
      data,
      idEmprestimo
    ]);
    await mail();
    assert.equal(cartas.at(-1).subject, 'Empréstimo em atraso');
    const ind = (await req(200, 'GET', '/equipe/indicadores?de=' + data + '&ate=' + data, equipe)).find(
      (i) => i.titulo === edicao.titulo && i.edicao === '1ª'
    );
    assert.equal(ind.retiradas, 2);
    assert.equal(ind.pedidos, 2);
    assert.ok(ind.esperaDias !== null);
  });
  await t.test('expiração da reserva promove o próximo e o aviso de retirada é único', async () => {
    await req(204, 'PUT', '/conta/fila/' + id, b.token);
    await req(204, 'PUT', '/conta/fila/' + id, c.token);
    await req(204, 'PUT', emprestimos(a) + '/' + idEmprestimo + '/devolucao', equipe);
    await pool.query(
      `UPDATE ${esquema}.reservas SET retirada_ate=now()-interval '1 minute' WHERE conta_id=$1 AND livro_id=$2 AND cancelada_em IS NULL`,
      [b.id, id]
    );
    const conta = await req(200, 'GET', '/conta', c.token);
    assert.equal(conta.reservas[0].livroId, id);
    await req(204, 'PATCH', '/conta/avisos-email', c.token, { ativar: true });
    const antes = cartas.length;
    for (let i = 0; i < 2; i++) await enviarLembretes(pool, esquema, async (carta) => cartas.push(carta));
    assert.equal(cartas.length, antes + 1);
    assert.equal(cartas.at(-1).subject, 'Reserva pronta para retirada');
  });
  await t.test('busca e paginação do histórico preservam isolamento e filtro por período', async () => {
    await pool.query(
      `INSERT INTO ${esquema}.emprestimos(conta_id,titulo,autor,emprestado_em,devolvido_em) SELECT $1,'Outros contos','Ana',now(),now() FROM generate_series(1,12)`,
      [a.id]
    );
    const rota = '/conta/arquivo?q=Outros&de=' + data + '&ate=' + data;
    const p1 = await req(200, 'GET', rota, a.token),
      p2 = await req(200, 'GET', rota + '&pagina=2', a.token);
    assert.equal(p1.itens.length, 20);
    assert.equal(p1.mais, true);
    assert.equal(p2.itens.length, 4);
    assert.equal(p2.mais, false);
    assert.equal(new Set([...p1.itens, ...p2.itens].map((i) => i.tipo + i.id)).size, 24);
    assert.deepEqual((await req(200, 'GET', rota, b.token)).itens, []);
    await req(400, 'GET', '/conta/arquivo?pagina=-2', a.token);
  });
  await t.test('recuperação por e-mail expira, revoga sessões e rejeita reuso do link', async () => {
    const antes = cartas.length;
    await req(204, 'POST', '/recuperar', null, { email: 'ausente@acervo.test' });
    assert.equal(cartas.length, antes);
    await req(204, 'POST', '/recuperar', null, { email: a.email });
    const token = cartas.at(-1).text.split('#').at(-1);
    await pool.query(`UPDATE ${esquema}.recuperacao SET expira=now()-interval '1 minute' WHERE conta_id=$1`, [
      a.id
    ]);
    await req(400, 'POST', '/redefinir', null, { token, senha: 'NovaSenha123' });
    await req(204, 'POST', '/recuperar', null, { email: a.email });
    const novo = cartas.at(-1).text.split('#').at(-1);
    await req(204, 'POST', '/redefinir', null, { token: novo, senha: 'NovaSenha123' });
    await req(400, 'POST', '/redefinir', null, { token: novo, senha: 'NovaSenha123' });
    await req(401, 'GET', '/conta', a.token);
    assert.ok(await login(a.email, 'NovaSenha123'));
  });
  await t.test('backup restaura circulação, vínculos, sequência e históricos em outro esquema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acervo-regressao-')),
      arquivo = join(dir, 'backup.json'),
      destino = esquemaNovo();
    let restaurado = false;
    try {
      await salvarBackup(pool, esquema, arquivo);
      await assert.rejects(restaurarBackup(pool, arquivo, esquema), /já existe/);
      await restaurarBackup(pool, arquivo, destino);
      restaurado = true;
      const origem = await prepararBanco(pool, esquema, true),
        copia = await prepararBanco(pool, destino, true);
      assert.notEqual(origem.chaveJwt, copia.chaveJwt);
      assert.deepEqual(
        await copia.eventosDoEmprestimo(a.id, idEmprestimo),
        await origem.eventosDoEmprestimo(a.id, idEmprestimo)
      );
      assert.deepEqual(await copia.catalogo(), await origem.catalogo());
      const adicionado = await copia.salvarCopia(id, null, 'Prateleira de teste', 'regular');
      assert.notEqual(adicionado.tombo, tombo);
    } finally {
      if (restaurado) await pool.query('DROP SCHEMA ' + destino + ' CASCADE');
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('modo real inicia vazio e rejeita reutilização como demonstração', async (t) => {
  const { pool, esquema, requisitar } = await abrirAmbiente(t, false);
  assert.deepEqual((await requisitar('GET', '/catalogo')).dados.livros, []);
  assert.equal((await requisitar('GET', '/ambiente')).dados.demonstracao, false);
  assert.equal(
    (await requisitar('POST', '/login', null, { email: 'equipe@acervo.test', senha: 'Equipe!208' })).status,
    401
  );
  await assert.rejects(prepararBanco(pool, esquema, true), /modo/);
});
