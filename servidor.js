import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import swaggerUi from 'swagger-ui-dist';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { conectarBanco, prepararBanco } from './banco.js';
import { instalarBiblioteca, documentacaoBiblioteca } from './rotas-biblioteca.js';
import pg from 'pg';
import { transporteEmail, enviarLembretes, origemBiblioteca } from './correio.js';
import { openApiAcervo } from './openapi.js';
import { paginaDaConta, rotasDaConta, telaDaEquipe } from './paginas-conta.js';
import { diaDaBiblioteca } from './public/conta/calendario.js';

const emissor = 'acervo-api';
const audiencia = 'acervo-web';
const cookieSessao = 'acervo_sessao';
const duracaoLaboratorio = 5 * 60;
const duracaoSessao = 30 * 60;
const contasDemonstracao = new Set(['L-104', 'B-208']);
const erroNome = 'Informe um nome com 2 a 120 caracteres.';
const erroSenha = 'Use pelo menos 8 caracteres e até 72 bytes na senha.';
// Mesmo custo de comparação para e-mails existentes e desconhecidos.
const hashDeComparacao = await bcrypt.hash(randomBytes(24).toString('hex'), 10);

function normalizarNome(valor) {
  const nome = typeof valor === 'string' ? valor.trim() : '';
  return nome.length >= 2 && nome.length <= 120 && !/\p{Cc}/u.test(nome) ? nome : null;
}

function senhaNovaValida(senha) {
  return typeof senha === 'string' && Array.from(senha).length >= 8 && Boolean(senha.trim())
    && Buffer.byteLength(senha) <= 72;
}

function livroIdValido(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id);
}

function emprestimoIdValido(id) {
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
}

function prazoValido(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || valor < diaDaBiblioteca()) return false;
  const dia = new Date(valor + 'T00:00:00Z');
  return Number.isFinite(dia.getTime()) && dia.toISOString().slice(0, 10) === valor;
}

export async function criarAplicacao({ pool = conectarBanco(), demonstracao = process.env.ACERVO_MODO !== 'real', esquema = process.env.ACERVO_ESQUEMA || (demonstracao ? 'acervo' : 'acervo_real'), enviar = transporteEmail(), origem = origemBiblioteca(demonstracao), segredoCron = process.env.CRON_SECRET, app = express() } = {}) {
  const schema = pg.escapeIdentifier(esquema);
  const avisarReservas = enviar && (reservas => enviarLembretes(pool,schema,enviar,{reservas,origem}));
  const banco = await prepararBanco(pool, esquema, demonstracao, avisarReservas);
  const chave = banco.chaveJwt;
  if (enviar) app.locals.processarAvisos = async () => {
    await banco.atualizarFilas();
    return enviarLembretes(pool,schema,enviar,{origem});
  };
  if (!demonstracao) app.use('/laboratorio', (_req,res)=>res.redirect('/api-docs/'));
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/conta/foto', express.json({ limit: '112kb' }));
  app.use(express.json({ limit: '8kb' }));
  app.get('/api/interno/avisos', async (req,res) => {
    const recebido = Buffer.from(req.get('authorization') || '');
    const esperado = Buffer.from('Bearer ' + (segredoCron || ''));
    if (!segredoCron || recebido.length !== esperado.length || !timingSafeEqual(recebido,esperado))
      return res.sendStatus(401);
    if (!app.locals.processarAvisos) return res.status(503).json({mensagem:'O envio de e-mail ainda não está configurado.'});
    try { res.json({enviados:await app.locals.processarAvisos()}); }
    catch { res.status(503).json({mensagem:'O processamento dos avisos não foi concluído.'}); }
  });
  instalarBiblioteca({app,banco,pool,esquema,demonstracao,enviar,origem,autenticarConta,exigirEquipe,exigirContaEditavel,senhaNovaValida,emprestimoIdValido});

  app.post('/api/cadastro', async (req, res) => {
    const { email, senha } = req.body ?? {};
    const nome = normalizarNome(req.body?.nome);
    const endereco = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!nome) return res.status(400).json({ mensagem: erroNome });
    if (endereco.length > 254 || !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(endereco)) {
      return res.status(400).json({ mensagem: 'Informe um e-mail válido.' });
    }
    if (!senhaNovaValida(senha)) return res.status(400).json({ mensagem: erroSenha });
    const senhaHash = await bcrypt.hash(senha, 10);
    const criada = await banco.criarLeitor({ nome, email: endereco, senhaHash });
    if (!criada) return res.status(409).json({ mensagem: 'Já existe uma conta com este e-mail. Entre na sua conta.' });
    res.status(201).json({ mensagem: 'Conta criada. Entre com seu e-mail e senha.' });
  });

  function opcoesCookie(req) {
    return { httpOnly: true, sameSite: 'lax', secure: req.secure || Boolean(process.env.VERCEL), path: '/' };
  }

  function login({ navegador = false } = {}) {
    return async (req, res) => {
      const { email, senha } = req.body ?? {};
      if (typeof email !== 'string' || typeof senha !== 'string' || !senha || Buffer.byteLength(senha) > 72) {
        return res.status(400).json({ mensagem: 'Informe e-mail e senha válidos.' });
      }
      const conta = await banco.contaPorEmail(email.trim().toLowerCase());
      const corresponde = await bcrypt.compare(senha, conta?.senha_hash ?? hashDeComparacao);
      if (!conta || !corresponde) return res.status(401).json({ mensagem: 'E-mail ou senha incorretos.' });

      const expiraEm = navegador ? duracaoSessao : duracaoLaboratorio;
      const token = jwt.sign({ vs: conta.versao_sessao }, chave, {
        subject: conta.id, issuer: emissor, audience: audiencia, algorithm: 'HS256', expiresIn: expiraEm
      });
      const perfil = { nome: conta.nome, papel: conta.papel, expiraEm };
      if (navegador) {
        return res.cookie(cookieSessao, token, { ...opcoesCookie(req), maxAge: expiraEm * 1000 }).json(perfil);
      }
      res.json({ token, ...perfil });
    };
  }

  function tokenDoCabecalho(req) {
    return /^Bearer (\S+)$/i.exec(req.get('Authorization') ?? '')?.[1];
  }

  function tokenDoCookie(req) {
    const cookies = (req.get('Cookie') ?? '').split(';');
    const prefixo = cookieSessao + '=';
    return cookies.map(cookie => cookie.trim()).find(cookie => cookie.startsWith(prefixo))?.slice(prefixo.length);
  }

  async function localizarSessao(token) {
    if (!token) return null;
    let dados;
    try {
      dados = jwt.verify(token, chave, { algorithms: ['HS256'], issuer: emissor, audience: audiencia });
    } catch {
      return null;
    }
    const conta = await banco.contaPorId(dados.sub);
    if (!conta || conta.versao_sessao !== (dados.vs ?? 0)) return null;
    return { conta, expiraEm: Math.max(0, dados.exp - Math.floor(Date.now() / 1000)) };
  }

  async function autenticarComToken(token, req, res, next) {
    const sessao = await localizarSessao(token);
    if (!sessao || !sessao.expiraEm) {
      return res.set('WWW-Authenticate', 'Bearer').status(401).json({ mensagem: 'Faça login para consultar esta rota.' });
    }
    req.conta = sessao.conta;
    req.expiraEm = sessao.expiraEm;
    next();
  }

  function autenticar(req, res, next) {
    return autenticarComToken(tokenDoCabecalho(req), req, res, next);
  }

  function autenticarConta(req, res, next) {
    const token = req.get('Authorization') === undefined ? tokenDoCookie(req) : tokenDoCabecalho(req);
    return autenticarComToken(token, req, res, next);
  }

  app.post('/api/login', login());
  app.post('/api/sessao', login({ navegador: true }));
  app.get('/api/sessao', async (req, res) => {
    const sessao = await localizarSessao(tokenDoCookie(req));
    if (!sessao || !sessao.expiraEm) return res.sendStatus(204);
    const { nome, papel } = sessao.conta;
    res.json({ nome, papel, ...(sessao.conta.foto && {foto:sessao.conta.foto}), expiraEm: sessao.expiraEm });
  });
  app.delete('/api/sessao', (req, res) => {
    res.clearCookie(cookieSessao, opcoesCookie(req)).sendStatus(204);
  });
  async function movimentacaoDaConta(id, limiteHistorico = 20) {
    const [livros, reservas, historico, devolucoes, renovacoes] = await Promise.all([
      banco.emprestimosDaConta(id),
      banco.reservasDaConta(id),
      banco.reservasEncerradasDaConta(id, limiteHistorico),
      banco.emprestimosDaConta(id, { devolvidos: true, limite: limiteHistorico }),
      banco.renovacoesDaConta(id)
    ]);
    return { livros, reservas, historico, devolucoes, renovacoes };
  }

  app.get('/api/conta', autenticarConta, async (req, res) => {
    const { id, nome, email, papel } = req.conta;
    const { livros, reservas, historico, devolucoes, renovacoes } = await movimentacaoDaConta(id);
    res.json({ perfil: { nome, email, papel, ...(req.conta.foto && {foto:req.conta.foto}), demonstracao: contasDemonstracao.has(id) },
      expiraEm: req.expiraEm, livros: livros.map(({ id, titulo, autor, livroId, tombo, registradoPor, prazoDevolucao, diasEmAtraso }) =>
        ({ id, titulo, autor, livroId, ...(tombo && {tombo}), registradoPor, prazoDevolucao, diasEmAtraso })), reservas, historico, devolucoes, renovacoes });
  });

  async function enviarHistoricoEmprestimo(req, res) {
    const { id = req.conta.id, emprestimoId } = req.params;
    const eventos = emprestimoIdValido(emprestimoId) ? await banco.eventosDoEmprestimo(id, emprestimoId) : [];
    if (!eventos.length) return res.status(404).json({ mensagem: 'Empréstimo não encontrado nesta conta.' });
    res.json({ emprestimoId, eventos, comprovante: await banco.comprovante(id,emprestimoId) });
  }
  app.get('/api/conta/emprestimos/:emprestimoId', autenticarConta, enviarHistoricoEmprestimo);
  app.get('/api/conta/leitores/:id/emprestimos/:emprestimoId', autenticarConta, exigirEquipe, enviarHistoricoEmprestimo);

  function exigirContaEditavel(req, res, next) {
    if (contasDemonstracao.has(req.conta.id)) {
      return res.status(403).json({ mensagem: 'Cadastre sua própria conta para editar o perfil e a senha.' });
    }
    next();
  }

  app.patch('/api/conta/perfil', autenticarConta, exigirContaEditavel, async (req, res) => {
    const nome = normalizarNome(req.body?.nome);
    if (!nome) return res.status(400).json({ mensagem: erroNome });
    await banco.atualizarNome(req.conta.id, nome);
    res.json({ nome });
  });

  app.patch('/api/conta/senha', autenticarConta, exigirContaEditavel, async (req, res) => {
    const { senhaAtual, novaSenha } = req.body ?? {};
    if (!senhaNovaValida(novaSenha)) return res.status(400).json({ mensagem: erroSenha });
    if (typeof senhaAtual !== 'string' || !senhaAtual || Buffer.byteLength(senhaAtual) > 72) {
      return res.status(400).json({ mensagem: 'Informe a senha atual.' });
    }
    if (senhaAtual === novaSenha) return res.status(400).json({ mensagem: 'Escolha uma senha diferente da atual.' });
    const conta = await banco.contaPorEmail(req.conta.email);
    if (!conta || !await bcrypt.compare(senhaAtual, conta.senha_hash)) {
      return res.status(400).json({ mensagem: 'A senha atual está incorreta.' });
    }
    const atualizada = await banco.atualizarSenha(req.conta.id, conta.senha_hash, await bcrypt.hash(novaSenha, 10));
    if (!atualizada) return res.status(409).json({ mensagem: 'A senha já foi alterada. Entre novamente.' });
    res.clearCookie(cookieSessao, opcoesCookie(req)).sendStatus(204);
  });
  app.get('/api/catalogo', async (_req, res) => {
    res.json({ livros: await banco.catalogo() });
  });
  app.get('/api/minhas-reservas', autenticarConta, async (req, res) => {
    const reservas = await banco.reservasDaConta(req.conta.id);
    res.json({ reservas: reservas.map(({ id, titulo, autor, retirarAte }) => ({ id, titulo, autor, retirarAte })) });
  });
  app.post('/api/reservas', autenticarConta, async (req, res) => {
    const { livroId } = req.body ?? {};
    if (!livroIdValido(livroId)) {
      return res.status(400).json({ mensagem: 'Selecione um livro do catálogo.' });
    }
    const { reserva, erro } = await banco.reservarLivro(req.conta.id, livroId);
    if (erro === 'livroInexistente') return res.status(404).json({ mensagem: 'Livro não encontrado.' });
    if (erro === 'livroJaVinculado') {
      return res.status(409).json({ mensagem: 'Você já tem este livro emprestado ou reservado.' });
    }
    if (erro === 'livroIndisponivel') {
      return res.status(409).json({ mensagem: 'Não há exemplares disponíveis para reserva.' });
    }
    res.status(201).json({ reserva });
  });
  app.delete('/api/reservas/:id', autenticarConta, async (req, res) => {
    const { id } = req.params;
    const cancelada = /^[1-9]\d{0,17}$/.test(id) && await banco.cancelarReserva(req.conta.id, id);
    if (!cancelada) return res.status(404).json({ mensagem: 'Reserva ativa não encontrada.' });
    res.sendStatus(204);
  });
  app.get('/api/meus-emprestimos', autenticar, async (req, res) => {
    const livros = await banco.emprestimosDaConta(req.conta.id);
    res.json({ leitor: req.conta.nome, livros: livros.map(({ titulo, autor }) => ({ titulo, autor })) });
  });
  function exigirEquipe(req, res, next) {
    if (req.conta.papel !== 'bibliotecaria') {
      return res.status(403).json({ mensagem: 'Acesso exclusivo da equipe da biblioteca.' });
    }
    next();
  }
  app.get('/api/circulacao', autenticar, exigirEquipe, async (_req, res) => {
    res.json(await banco.circulacao());
  });
  app.get('/api/conta/circulacao', autenticarConta, exigirEquipe, async (_req, res) => {
    res.json(await banco.circulacaoDetalhada());
  });
  app.get('/api/conta/leitores', autenticarConta, exigirEquipe, async (req, res) => {
    const { nome = '', pagina = '1' } = req.query;
    if (typeof nome !== 'string' || nome.length > 120 || /\p{Cc}/u.test(nome)) {
      return res.status(400).json({ mensagem: 'Pesquise por um nome de até 120 caracteres.' });
    }
    if (typeof pagina !== 'string' || !/^[1-9]\d{0,8}$/.test(pagina)) {
      return res.status(400).json({ mensagem: 'Informe uma página válida.' });
    }
    res.json(await banco.pesquisarLeitores(nome.trim(), Number(pagina)));
  });
  app.get('/api/conta/leitores/:id', autenticarConta, exigirEquipe, async (req, res) => {
    const conta = await banco.contaPorId(req.params.id);
    if (!conta) return res.status(404).json({ mensagem: 'Leitor não encontrado.' });
    const { id, nome, email, papel } = conta;
    const movimentos = await movimentacaoDaConta(id, null);
    res.json({ leitor: { id, nome, email, papel }, ...movimentos });
  });
  app.post('/api/conta/leitores/:id/emprestimos', autenticarConta, exigirEquipe, async (req, res) => {
    const { livroId, prazoDevolucao } = req.body ?? {};
    if (!livroIdValido(livroId)) return res.status(400).json({ mensagem: 'Selecione um livro do catálogo.' });
    if (!prazoValido(prazoDevolucao)) return res.status(400).json({ mensagem: 'Escolha uma data de devolução válida a partir de hoje.' });
    if (!await banco.contaPorId(req.params.id)) return res.status(404).json({ mensagem: 'Leitor não encontrado.' });
    const {tombo = null, reservaId = null} = req.body;
    if ((tombo !== null && (typeof tombo !== 'string' || !/^AC-\d{1,19}$/.test(tombo))) ||
        (reservaId !== null && !emprestimoIdValido(String(reservaId)))) return res.status(400).json({mensagem:'Tombo ou reserva inválidos.'});
    const { emprestimo, erro } = await banco.registrarEmprestimo(req.params.id, livroId, req.conta, prazoDevolucao, tombo, reservaId && String(reservaId));
    if (erro === 'livroInexistente') return res.status(404).json({ mensagem: 'Livro não encontrado.' });
    if (erro === 'livroJaVinculado') return res.status(409).json({ mensagem: 'Este leitor já tem um empréstimo ativo deste título.' });
    if (erro === 'livroIndisponivel') return res.status(409).json({ mensagem: 'Não há exemplares disponíveis para este leitor.' });
    res.status(201).json({ emprestimo });
  });
  app.patch('/api/conta/leitores/:id/emprestimos/:emprestimoId/prazo', autenticarConta, exigirEquipe, async (req, res) => {
    const { id, emprestimoId } = req.params;
    const { prazoDevolucao } = req.body ?? {};
    if (!prazoValido(prazoDevolucao)) return res.status(400).json({ mensagem: 'Escolha uma data de devolução válida a partir de hoje.' });
    const resultado = emprestimoIdValido(emprestimoId)
      ? await banco.atualizarPrazoEmprestimo(id, emprestimoId, prazoDevolucao, req.conta) : 'inexistente';
    if (resultado === 'inexistente') return res.status(404).json({ mensagem: 'Empréstimo não encontrado na ficha deste leitor.' });
    if (resultado === 'devolvido') return res.status(409).json({ mensagem: 'Este empréstimo já foi devolvido.' });
    if (resultado === 'prazoNaoProrrogado') return res.status(409).json({ mensagem: 'Escolha uma data posterior ao prazo atual.' });
    res.json({ prazoDevolucao });
  });
  app.put('/api/conta/leitores/:id/emprestimos/:emprestimoId/devolucao', autenticarConta, exigirEquipe, async (req, res) => {
    const { id, emprestimoId } = req.params;
    if (!emprestimoIdValido(emprestimoId) ||
        !await banco.devolverEmprestimo(id, emprestimoId, req.conta)) {
      return res.status(404).json({ mensagem: 'Empréstimo não encontrado na ficha deste leitor.' });
    }
    res.sendStatus(204);
  });
  app.get(['/conta/', '/conta/index.html', ...rotasDaConta, '/conta/circulacao/leitores/:id/', '/conta/leitores/:id/'], async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const caminho = req.path.toLowerCase().replace(/\/?$/, '/');
    const tela = req.params.id ? 'leitor' : rotasDaConta.includes(caminho) ? caminho.split('/')[2] : null;
    const viaLeitores = caminho.startsWith('/conta/leitores/');
    const sessao = await localizarSessao(tokenDoCookie(req));
    if (!sessao?.expiraEm) {
      if (viaLeitores) {
        const retorno = new URLSearchParams({ tela: 'leitores' });
        if (req.params.id) retorno.set('id', req.params.id);
        for (const chave of ['nome', 'pagina']) {
          if (typeof req.query[chave] === 'string') retorno.set(chave, req.query[chave]);
        }
        return res.redirect('/entrar/?' + retorno);
      }
      if (tela === 'leitor') return res.redirect('/entrar/?tela=leitor&id=' + encodeURIComponent(req.params.id));
      const aba = req.query.aba === 'reservas' ? '?aba=reservas' : '';
      return res.redirect('/entrar/' + (tela ? '?tela=' + tela : aba));
    }
    const equipe = sessao.conta.papel === 'bibliotecaria';
    if (!tela) {
      const inicio = equipe && req.query.aba !== 'reservas' ? 'circulacao' : 'reservas';
      return res.redirect('/conta/' + inicio + '/');
    }
    if (telaDaEquipe(tela) && !equipe) return res.redirect('/conta/reservas/');
    res.send(paginaDaConta(tela, equipe, viaLeitores ? 'leitores' : 'circulacao'));
  });
  app.get('/api-docs/openapi.json', (_req, res) => res.json({...openApiAcervo,paths:{...openApiAcervo.paths,...documentacaoBiblioteca}}));
  app.use('/api-docs/assets', express.static(swaggerUi.absolutePath(), { index: false }));
  app.use(express.static(fileURLToPath(new URL('./public/', import.meta.url))));
  app.use((err, _req, res, _next) => {
    const duplicado = err.code === '23505';
    const status = err.status ?? (duplicado ? 409 : 500);
    res.status(status).json({ mensagem: err.publica ? err.message : duplicado ? 'Já existe um registro com esses dados.' : status < 500 ? 'Requisição inválida.' : 'Falha interna.' });
  });
  return app;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const pool = conectarBanco();
  const app = await criarAplicacao({ pool });
  const porta = Number(process.env.PORT ?? 4176);
  const servidor = app.listen(porta, '127.0.0.1', () => console.log('Acervo em http://127.0.0.1:' + porta));
  if (app.locals.processarAvisos) {
    let executando=false;
    const processar = async () => {
      if (executando) return;
      executando=true;
      try { await app.locals.processarAvisos(); }
      catch { console.error('Falha ao processar avisos da biblioteca.'); }
      finally { executando=false; }
    };
    void processar();
    const timer=setInterval(processar,15*60*1000);
    timer.unref();
    servidor.on('close',()=>clearInterval(timer));
  }
}
