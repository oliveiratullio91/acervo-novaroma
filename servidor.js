import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { conectarBanco, prepararBanco } from './banco.js';

const emissor = 'acervo-api';
const audiencia = 'acervo-web';
// Mesmo custo de comparação para e-mails existentes e desconhecidos.
const hashDeComparacao = await bcrypt.hash(randomBytes(24).toString('hex'), 10);

export async function criarAplicacao({ pool = conectarBanco(), esquema = 'acervo', app = express() } = {}) {
  const banco = await prepararBanco(pool, esquema);
  const chave = banco.chaveJwt;
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '4kb' }));

  app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body ?? {};
    if (typeof email !== 'string' || typeof senha !== 'string' || !senha || Buffer.byteLength(senha) > 72) {
      return res.status(400).json({ mensagem: 'Informe e-mail e senha válidos.' });
    }
    const conta = await banco.contaPorEmail(email.trim().toLowerCase());
    const corresponde = await bcrypt.compare(senha, conta?.senha_hash ?? hashDeComparacao);
    if (!conta || !corresponde) return res.status(401).json({ mensagem: 'E-mail ou senha incorretos.' });

    const token = jwt.sign({}, chave, {
      subject: conta.id, issuer: emissor, audience: audiencia, algorithm: 'HS256', expiresIn: '5m'
    });
    res.json({ token, nome: conta.nome, papel: conta.papel, expiraEm: 300 });
  });

  async function autenticar(req, res, next) {
    const token = /^Bearer (\S+)$/i.exec(req.get('Authorization') ?? '')?.[1];
    let dados;
    try {
      dados = jwt.verify(token, chave, { algorithms: ['HS256'], issuer: emissor, audience: audiencia });
    } catch {
      return exigirLogin(res);
    }
    req.conta = await banco.contaPorId(dados.sub);
    if (!req.conta) return exigirLogin(res);
    next();
  }

  function exigirLogin(res) {
    return res.set('WWW-Authenticate', 'Bearer').status(401).json({ mensagem: 'Faça login para consultar esta rota.' });
  }

  app.get('/api/meus-emprestimos', autenticar, async (req, res) => {
    const livros = await banco.emprestimosDaConta(req.conta.id);
    res.json({ leitor: req.conta.nome, livros });
  });
  app.get('/api/circulacao', autenticar, async (req, res) => {
    if (req.conta.papel !== 'bibliotecaria') {
      return res.status(403).json({ mensagem: 'Somente a equipe da biblioteca pode consultar o relatório.' });
    }
    res.json(await banco.circulacao());
  });
  app.use(express.static(fileURLToPath(new URL('./public/', import.meta.url))));
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    res.status(status).json({ mensagem: status < 500 ? 'Requisição inválida.' : 'Falha interna.' });
  });
  return app;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const app = await criarAplicacao();
  const porta = Number(process.env.PORT ?? 4176);
  app.listen(porta, '127.0.0.1', () => console.log('Acervo em http://127.0.0.1:' + porta));
}
