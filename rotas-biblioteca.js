import pg from 'pg';
import { createRequire } from 'node:module';
import { falha } from './operacoes-banco.js';
import { solicitarRecuperacao, redefinirSenha } from './correio.js';
const require = createRequire(import.meta.url);
export const documentacaoBiblioteca = {};

function campo(valor, max = 120, obrigatorio = true) {
  if (typeof valor !== 'string' || valor.trim().length > max || (obrigatorio && !valor.trim()))
    falha(400, 'Revise os campos obrigatórios e o tamanho do texto.');
  return valor.trim();
}
function numero(n, min, max) {
  if (!Number.isInteger(n) || n < min || n > max) falha(400, 'Número fora do intervalo permitido.');
  return n;
}
function booleano(v) {
  if (typeof v !== 'boolean') falha(400, 'Opção inválida.');
  return v;
}
function data(v) {
  if (!v) return null;
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d\d-\d\d$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    falha(400, 'Data inválida.');
  return v;
}
function periodo(q) {
  const de = data(q.de),
    ate = data(q.ate);
  if (de && ate && de > ate) falha(400, 'O início deve anteceder o fim.');
  return [de, ate];
}
export function instalarBiblioteca({
  app,
  banco,
  pool,
  esquema,
  demonstracao,
  enviar,
  origem,
  autenticarConta,
  exigirEquipe,
  exigirContaEditavel,
  senhaNovaValida,
  emprestimoIdValido
}) {
  const s = pg.escapeIdentifier(esquema);
  function rota(metodo, caminho, acesso, resumo, acao, campos = {}) {
    const guards = {
      publico: [],
      leitor: [autenticarConta],
      pessoal: [autenticarConta, exigirContaEditavel],
      equipe: [autenticarConta, exigirEquipe]
    }[acesso];
    app[metodo](caminho, ...guards, async (req, res) => {
      const resultado = await acao(req);
      if (resultado === undefined || resultado?.command) res.sendStatus(204);
      else res.json(resultado);
    });
    const url = caminho.replace(/:(\w+)/g, '{$1}');
    const spec = (documentacaoBiblioteca[url] ??= {});
    const auth = acesso === 'publico' ? [] : [{ bearerAuth: [] }, { sessaoCookie: [] }];
    spec[metodo] = {
      tags: [acesso === 'equipe' ? 'Equipe' : 'Conta'],
      summary: resumo,
      security: auth,
      parameters: [...caminho.matchAll(/:(\w+)/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' }
      })),
      responses: {
        200: { description: 'Resultado da consulta ou operação.' },
        204: { description: 'Operação concluída.' },
        400: { description: 'Dados inválidos.' },
        403: { description: 'Acesso restrito.' },
        409: { description: 'Conflito com a circulação.' }
      }
    };
    if (Object.keys(campos).length)
      spec[metodo].requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: Object.fromEntries(Object.entries(campos).map(([k, t]) => [k, { type: t }]))
            }
          }
        }
      };
  }
  const livros = '/api/equipe/livros',
    copias = '/api/equipe/exemplares',
    leitor = '/api/conta';
  async function gravarLivro(req) {
    const b = req.body ?? {},
      dados = {};
    for (const [k, max] of Object.entries({
      titulo: 200,
      autor: 150,
      categoria: 80,
      edicao: 100,
      descricao: 3000,
      capa: 1500
    }))
      dados[k] = campo(b[k] ?? '', max, ['titulo', 'autor', 'categoria'].includes(k));
    if (dados.capa) {
      let url;
      try {
        url = new URL(dados.capa);
      } catch {
        falha(400, 'Informe uma URL HTTPS para a capa.');
      }
      if (url.protocol !== 'https:' || url.username || url.password)
        falha(400, 'Informe uma URL HTTPS para a capa.');
    }
    return banco.cadastrarLivro(req.params.id, dados);
  }
  const cadastro = {
    titulo: 'string',
    autor: 'string',
    categoria: 'string',
    edicao: 'string',
    descricao: 'string',
    capa: 'string'
  };
  rota('get', livros, 'equipe', 'Listar edições e títulos arquivados', () => banco.gestaoLivros());
  rota('post', livros, 'equipe', 'Cadastrar edição', gravarLivro, cadastro);
  rota('put', livros + '/:id', 'equipe', 'Editar edição', gravarLivro, cadastro);
  rota(
    'patch',
    livros + '/:id/arquivo',
    'equipe',
    'Arquivar ou reativar título',
    (req) => banco.mudarArquivo(req.params.id, booleano(req.body?.arquivado)),
    { arquivado: 'boolean' }
  );
  rota('get', copias, 'equipe', 'Consultar inventário e localização', () => banco.copias());
  async function salvarCopia(req) {
    const b = req.body ?? {},
      local = campo(b.localizacao, 120);
    if (!['regular', 'manutencao', 'extraviado'].includes(b.estado)) falha(400, 'Situação inválida.');
    return banco.salvarCopia(campo(b.livroId), req.params.tombo, local, b.estado);
  }
  const exemplar = { livroId: 'string', localizacao: 'string', estado: 'string' };
  rota('post', copias, 'equipe', 'Tombar exemplar', salvarCopia, exemplar);
  rota('put', copias + '/:tombo', 'equipe', 'Atualizar localização ou situação', salvarCopia, exemplar);
  rota('post', copias + '/:tombo/conferencia', 'equipe', 'Registrar conferência física', (req) =>
    banco.conferir(req.params.tombo, req.conta.id)
  );
  rota('get', '/api/equipe/reservas', 'equipe', 'Reservas aguardando retirada', async () => {
    await banco.atualizarFilas();
    return banco.reservasBalcao();
  });
  rota('get', '/api/conta/regras', 'leitor', 'Política de empréstimos', () => banco.regras());
  rota(
    'put',
    '/api/equipe/regras',
    'equipe',
    'Configurar regras de circulação',
    (req) => {
      const b = req.body ?? {};
      return banco.salvarRegras({
        dias: numero(b.dias, 1, 365),
        limite: numero(b.limite, 1, 100),
        renovacoes: numero(b.renovacoes, 0, 100),
        respeitar_fila: booleano(b.respeitar_fila)
      });
    },
    { dias: 'integer', limite: 'integer', renovacoes: 'integer', respeitar_fila: 'boolean' }
  );
  rota(
    'post',
    '/api/equipe/leitores/:id/emprestimos/:emprestimoId/correcao',
    'equipe',
    'Reabrir devolução com justificativa',
    (req) => {
      if (!emprestimoIdValido(req.params.emprestimoId)) falha(404, 'Empréstimo não encontrado.');
      return banco.corrigirDevolucao(
        req.params.id,
        req.params.emprestimoId,
        campo(req.body?.motivo, 500),
        req.conta
      );
    },
    { motivo: 'string' }
  );
  rota('get', '/api/equipe/indicadores', 'equipe', 'Indicadores de circulação por período', (req) => {
    const [de, ate] = periodo(req.query);
    if (!de || !ate) falha(400, 'Informe as duas datas.');
    return banco.indicadores(de, ate);
  });
  rota('get', leitor + '/fila', 'leitor', 'Consultar posição na fila', async (req) => {
    await banco.atualizarFilas();
    return banco.minhaFila(req.conta.id);
  });
  rota('put', leitor + '/fila/:livroId', 'leitor', 'Entrar na fila de um livro', (req) =>
    banco.entrarFila(req.conta.id, req.params.livroId)
  );
  rota('delete', leitor + '/fila/:livroId', 'leitor', 'Sair da fila', (req) =>
    banco.sairFila(req.conta.id, req.params.livroId)
  );
  rota('get', leitor + '/estante', 'leitor', 'Listar Quero ler', (req) => banco.estante(req.conta.id));
  rota('put', leitor + '/estante/:livroId', 'leitor', 'Guardar na estante', (req) =>
    banco.favoritar(req.conta.id, req.params.livroId)
  );
  rota('delete', leitor + '/estante/:livroId', 'leitor', 'Remover da estante', (req) =>
    banco.desfavoritar(req.conta.id, req.params.livroId)
  );
  rota('get', leitor + '/carteira', 'leitor', 'Carteirinha e preferências', (req) =>
    banco.preferencias(req.conta.id)
  );
  rota(
    'patch',
    leitor + '/avisos-email',
    'pessoal',
    'Preferência de lembretes',
    (req) => banco.preferirEmail(req.conta.id, booleano(req.body?.ativar)),
    { ativar: 'boolean' }
  );
  rota(
    'put',
    leitor + '/foto',
    'pessoal',
    'Atualizar ou remover foto JPEG',
    (req) => {
      const foto = req.body?.foto;
      if (
        foto !== null &&
        (typeof foto !== 'string' ||
          foto.length > 100000 ||
          !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+=*$/.test(foto))
      )
        falha(400, 'Foto JPEG inválida.');
      return banco.salvarFoto(req.conta.id, foto);
    },
    { foto: 'string' }
  );
  rota('get', leitor + '/arquivo', 'leitor', 'Pesquisar todo o histórico por título e período', (req) =>
    banco.historico(
      req.conta.id,
      campo(req.query.q ?? '', 200, false),
      ...periodo(req.query),
      numero(Number(req.query.pagina ?? 1), 1, 1000000)
    )
  );
  for (const [path, keys] of [
    ['/api/equipe/indicadores', ['de', 'ate']],
    ['/api/conta/arquivo', ['q', 'de', 'ate', 'pagina']]
  ]) {
    documentacaoBiblioteca[path].get.parameters.push(
      ...keys.map((name) => ({
        name,
        in: 'query',
        required: path.endsWith('indicadores'),
        schema: { type: name === 'pagina' ? 'integer' : 'string' }
      }))
    );
  }
  rota('get', '/api/ambiente', 'publico', 'Identificar ambiente de demonstração', () => ({ demonstracao }));
  rota(
    'post',
    '/api/recuperar',
    'publico',
    'Enviar link temporário de recuperação',
    (req) =>
      solicitarRecuperacao({
        pool,
        s,
        email: campo(req.body?.email, 254).toLowerCase(),
        enviar,
        origem
      }),
    { email: 'string' }
  );
  rota(
    'post',
    '/api/redefinir',
    'publico',
    'Usar link de recuperação uma única vez',
    (req) => {
      if (!senhaNovaValida(req.body?.senha) || !/^[a-f0-9]{64}$/.test(req.body?.token ?? ''))
        falha(400, 'Revise o link e a nova senha.');
      return redefinirSenha(pool, s, req.body.token, req.body.senha);
    },
    { token: 'string', senha: 'string' }
  );
  app.get('/biblioteca/barcode.js', (_req, res) =>
    res.sendFile(require.resolve('jsbarcode/dist/JsBarcode.all.min.js'))
  );
  documentacaoBiblioteca['/api/capa/{id}'] = {
    get: {
      summary: 'Abrir a capa da edição',
      tags: ['Catálogo'],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 302: { description: 'Endereço da capa.' }, 404: { description: 'Edição inexistente.' } }
    }
  };
  app.get('/api/capa/:id', async (req, res) => {
    const {
      rows: [livro]
    } = await pool.query(`SELECT capa FROM ${s}.catalogo WHERE id=$1`, [req.params.id]);
    if (!livro) return res.sendStatus(404);
    res.redirect(
      /^https:\/\//i.test(livro.capa) ? livro.capa : '/capas/' + encodeURIComponent(req.params.id) + '.webp'
    );
  });
}
