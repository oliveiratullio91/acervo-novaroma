import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { SMTPServer } from 'smtp-server';
import { criarTransporteSMTP, transporteEmail, origemBiblioteca } from '../correio.js';
import { abrirAmbiente } from '../suporte-testes/biblioteca.js';

test('Gmail usa TLS, aceita senha de app agrupada e exige credenciais mesmo com a antiga caixa de teste', () => {
  assert.equal(transporteEmail({ ACERVO_CAIXA_TESTE: 'pasta-de-teste' }), null);
  assert.equal(transporteEmail({ GMAIL_USUARIO: 'remetente@example.test' }), null);
  const transportador = criarTransporteSMTP({
    GMAIL_USUARIO: 'biblioteca@example.test',
    GMAIL_SENHA_APP: 'abcd efgh ijkl mnop'
  });
  const opcoes = transportador.transporter.options;
  assert.equal(opcoes.host, 'smtp.gmail.com');
  assert.equal(opcoes.port, 465);
  assert.equal(opcoes.secure, true);
  assert.equal(opcoes.auth.pass, 'abcdefghijklmnop');
  transportador.close();
  assert.equal(origemBiblioteca(true, { PORT: '4177' }), 'http://127.0.0.1:4177');
  assert.equal(origemBiblioteca(true, { VERCEL: '1' }), null);
  assert.equal(
    origemBiblioteca(false, {
      VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'acervo.example.test'
    }),
    'https://acervo.example.test'
  );
});

test('SMTP recebe recuperação, retirada imediata, lembrete e atraso, com retomada e sem duplicação', async (t) => {
  const entregas = [];
  let recusar = null;
  const smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    disableReverseLookup: true,
    logger: false,
    onAuth(auth, _, responder) {
      if (auth.username !== 'biblioteca' || auth.password !== 'ensaio')
        return responder(new Error('Acesso recusado.'));
      responder(null, { user: 'biblioteca' });
    },
    onRcptTo(destino, _, responder) {
      responder(
        destino.address === recusar
          ? Object.assign(new Error('Temporariamente indisponível.'), { responseCode: 450 })
          : null
      );
    },
    onData(stream, sessao, responder) {
      let mensagem = '';
      stream.on('data', (parte) => {
        mensagem += parte.toString();
      });
      stream.on('end', () => {
        entregas.push({ destino: sessao.envelope.rcptTo[0].address, mensagem });
        responder(null, 'Mensagem aceita.');
      });
    }
  });
  smtp.listen(0, '127.0.0.1');
  await once(smtp.server, 'listening');
  t.after(() => new Promise((resolve) => smtp.close(resolve)));
  const env = {
    SMTP_URL: 'smtp://biblioteca:ensaio@127.0.0.1:' + smtp.server.address().port,
    ACERVO_REMETENTE: 'biblioteca@acervo.test'
  };
  const origem = 'https://biblioteca.example.test';
  const { requisitar, pool, esquema } = await abrirAmbiente(t, true, {
    enviar: transporteEmail(env),
    segredoCron: 'segredo-no-teste',
    origem
  });
  async function req(status, ...args) {
    const r = await requisitar(...args);
    assert.equal(r.status, status, args[1]);
    return r.dados;
  }
  async function cadastrar(nome) {
    const email = nome + '@acervo.test',
      senha = 'LivroNovo123';
    await req(201, 'POST', '/cadastro', null, { email, senha, nome });
    const { token } = await req(200, 'POST', '/login', null, { email, senha });
    const { id } = await req(200, 'GET', '/conta/carteira', token);
    return { id, email, token };
  }
  const ana = await cadastrar('ana'),
    bia = await cadastrar('bia');
  await req(204, 'POST', '/recuperar', null, { email: ana.email });
  assert.equal(entregas.length, 1);
  assert.equal(entregas[0].destino, ana.email);
  const mime = entregas[0].mensagem.replace(/=\r?\n/g, '');
  assert.match(mime, /Subject: Redefinir a senha do Acervo/);
  assert.match(mime, /https:\/\/biblioteca\.example\.test\/recuperar\/#([0-9a-f]{64})/);
  await req(204, 'PATCH', '/conta/avisos-email', ana.token, { ativar: true });
  await req(204, 'PATCH', '/conta/avisos-email', bia.token, { ativar: true });
  recusar = bia.email;
  await req(201, 'POST', '/reservas', bia.token, { livroId: 'iracema' });
  await req(201, 'POST', '/reservas', ana.token, { livroId: 'mensagem' });
  assert.equal(entregas.length, 2);
  assert.match(entregas[1].mensagem, /Subject: Reserva pronta para retirada/);
  assert.equal(entregas[1].destino, ana.email);
  await req(401, 'GET', '/interno/avisos');
  await req(401, 'GET', '/interno/avisos', ana.token);
  await pool.query(
    `INSERT INTO ${esquema}.emprestimos (conta_id,titulo,autor,prazo_devolucao)
    VALUES($1,'Livro da vez','Ana',(now() AT TIME ZONE 'America/Fortaleza')::date + 2)`,
    [ana.id]
  );
  await req(503, 'GET', '/interno/avisos', 'segredo-no-teste');
  assert.equal(entregas.length, 3);
  assert.equal(entregas[2].destino, ana.email);
  recusar = null;
  const rodar = () => req(200, 'GET', '/interno/avisos', 'segredo-no-teste');
  await Promise.all([rodar(), rodar()]);
  assert.equal(entregas.length, 4);
  assert.equal(entregas[3].destino, bia.email);
  await pool.query(
    `UPDATE ${esquema}.emprestimos SET prazo_devolucao=(now() AT TIME ZONE 'America/Fortaleza')::date-1 WHERE conta_id=$1`,
    [ana.id]
  );
  await rodar();
  await rodar();
  assert.equal(entregas.length, 5);
  assert.equal(entregas[4].destino, ana.email);
  assert.notEqual(
    entregas[2].mensagem.match(/^Subject:.*$/m)[0],
    entregas[4].mensagem.match(/^Subject:.*$/m)[0]
  );
  await req(204, 'PATCH', '/conta/avisos-email', ana.token, { ativar: false });
  await pool.query(
    `UPDATE ${esquema}.emprestimos SET prazo_devolucao=(now() AT TIME ZONE 'America/Fortaleza')::date WHERE conta_id=$1`,
    [ana.id]
  );
  await rodar();
  assert.equal(entregas.length, 5);
  // Uma vaga liberada por cancelamento também precisa disparar o aviso sem esperar pelo cron.
  const equipe = (
    await req(200, 'POST', '/login', null, { email: 'equipe@acervo.test', senha: 'Equipe!208' })
  ).token;
  const { id: livroId } = await req(200, 'POST', '/equipe/livros', equipe, {
    titulo: 'Exemplar único',
    autor: 'Lia',
    categoria: 'Literatura'
  });
  await req(200, 'POST', '/equipe/exemplares', equipe, { livroId, localizacao: 'A1', estado: 'regular' });
  const { reserva } = await req(201, 'POST', '/reservas', ana.token, { livroId });
  await req(204, 'PUT', '/conta/fila/' + livroId, bia.token);
  await req(204, 'DELETE', '/reservas/' + reserva.id, ana.token);
  assert.equal(entregas.length, 6);
  assert.equal(entregas.at(-1).destino, bia.email);
  assert.match(entregas.at(-1).mensagem, /Subject: Reserva pronta para retirada/);
  await rodar();
  assert.equal(entregas.length, 6);
});
