const esquema = nome => ({ $ref: '#/components/schemas/' + nome });
const resposta = (descricao, modelo) => ({
  description: descricao,
  ...(modelo ? { content: { 'application/json': { schema: modelo } } } : {})
});
const corpo = modelo => ({ required: true, content: { 'application/json': { schema: modelo } } });
const lista = modelo => ({ type: 'array', items: modelo });
const objeto = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const texto = { type: 'string' };
const inteiro = { type: 'integer', minimum: 0 };
const data = { type: 'string', format: 'date-time' };
const prazoDevolucao = { type: 'string', format: 'date', description: 'Último dia para devolver o livro, no horário de Fortaleza.' };
const leitorNaRota = { name: 'id', in: 'path', required: true, schema: texto, example: 'L-104' };
const emprestimoNaRota = { name: 'emprestimoId', in: 'path', required: true, schema: texto };
const email = { type: 'string', format: 'email', maxLength: 254 };
const senha = { type: 'string', format: 'password' };
const senhaNova = { ...senha, minLength: 8, description: 'Até 72 bytes em UTF-8.' };
const nome = { type: 'string', minLength: 2, maxLength: 120 };
const bearer = [{ bearerAuth: [] }];
const leitor = [{ bearerAuth: [] }, { sessaoCookie: [] }];
const erro = descricao => resposta(descricao, esquema('Mensagem'));
const naoAutenticado = erro('É necessário iniciar uma sessão.');
const respostasLinhaDoTempo = {
  200: resposta('Movimentações do empréstimo, da retirada à última atualização.', objeto({
    emprestimoId: texto, eventos: lista(esquema('EventoEmprestimo')), comprovante: objeto({ titulo: texto, autor: texto, tombo: {...texto,nullable:true}, leitor: texto, prazoDevolucao: {...prazoDevolucao,nullable:true} })
  })),
  401: naoAutenticado, 404: erro('Empréstimo não encontrado nesta conta.')
};
const credenciais = corpo(objeto({ email, senha }));

const operacao = (tag, summary, responses, opcoes = {}) => ({ tags: [tag], summary, ...opcoes, responses });
const indicadoresCirculacao = { emprestimosAtivos: inteiro, leitoresComEmprestimos: inteiro };
const respostasCirculacao = {
  200: resposta('Indicadores de circulação.', objeto(indicadoresCirculacao)),
  401: naoAutenticado,
  403: erro('A conta precisa pertencer à equipe da biblioteca.')
};

export const openApiAcervo = {
  openapi: '3.0.3',
  info: {
    title: 'API da Biblioteca Acervo',
    version: '1.0.0',
    description: 'Consulte o catálogo, acompanhe empréstimos e gerencie reservas. Para testar rotas protegidas, execute POST /api/login e informe o JWT em Authorize. O site usa o cookie HttpOnly emitido por POST /api/sessao.'
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Autenticação' },
    { name: 'Conta' },
    { name: 'Catálogo' },
    { name: 'Reservas e empréstimos' },
    { name: 'Equipe' }
  ],
  paths: {
    '/api/interno/avisos': {
      get: {
        tags: ['Operação'], summary: 'Processar avisos de retirada e vencimento',
        security: [{ credencialAgenda: [] }],
        responses: {
          200: resposta('Quantidade de avisos enviados nesta execução.', objeto({ enviados: inteiro })),
          401: erro('Credencial do agendador ausente ou inválida.'),
          503: erro('Transporte indisponível ou avisos pendentes.')
        }
      }
    },
    '/api/cadastro': {
      post: operacao('Autenticação', 'Criar uma conta de leitor', {
        201: resposta('Conta criada.', esquema('Mensagem')),
        400: erro('Dados inválidos.'),
        409: erro('O e-mail já está cadastrado.')
      }, { requestBody: corpo(objeto({ nome, email, senha: senhaNova })) })
    },
    '/api/login': {
      post: operacao('Autenticação', 'Obter o JWT para autenticar chamadas à API', {
        200: resposta('Token emitido. Validade de cinco minutos.', esquema('LoginBearer')),
        400: erro('Dados inválidos.'),
        401: erro('E-mail ou senha incorretos.')
      }, { requestBody: credenciais })
    },
    '/api/sessao': {
      get: operacao('Autenticação', 'Consultar a sessão do navegador', {
        200: resposta('Sessão ativa.', esquema('Sessao')),
        204: resposta('Sessão ausente ou expirada.')
      }),
      post: operacao('Autenticação', 'Iniciar sessão no navegador', {
        200: {
          ...resposta('Sessão iniciada. Validade de 30 minutos.', esquema('Sessao')),
          headers: { 'Set-Cookie': { description: 'Cookie acervo_sessao com JWT e atributo HttpOnly.', schema: texto } }
        },
        400: erro('Dados inválidos.'),
        401: erro('E-mail ou senha incorretos.')
      }, { requestBody: credenciais }),
      delete: operacao('Autenticação', 'Encerrar sessão no navegador', {
        204: {
          ...resposta('Sessão encerrada no navegador.'),
          headers: { 'Set-Cookie': { description: 'Expira o cookie da sessão.', schema: texto } }
        }
      })
    },
    '/api/conta': {
      get: operacao('Conta', 'Consultar perfil, reservas e empréstimos da conta', {
        200: resposta('Dados da conta autenticada.', esquema('Conta')),
        401: naoAutenticado
      }, { security: leitor })
    },
    '/api/conta/perfil': {
      patch: operacao('Conta', 'Alterar o nome do leitor', {
        200: resposta('Nome atualizado.', objeto({ nome })),
        400: erro('Nome inválido.'),
        401: naoAutenticado,
        403: erro('A conta de demonstração tem perfil fixo.')
      }, { security: leitor, requestBody: corpo(objeto({ nome })) })
    },
    '/api/conta/senha': {
      patch: operacao('Conta', 'Alterar senha e encerrar as sessões anteriores', {
        204: resposta('Senha atualizada. É necessário entrar novamente.'),
        400: erro('Senha atual incorreta ou nova senha inválida.'),
        401: naoAutenticado,
        403: erro('A conta de demonstração tem senha fixa.'),
        409: erro('A senha foi alterada por outra solicitação.')
      }, { security: leitor, requestBody: corpo(objeto({ senhaAtual: senha, novaSenha: senhaNova })) })
    },
    '/api/catalogo': {
      get: operacao('Catálogo', 'Listar os livros e os exemplares disponíveis', {
        200: resposta('Obras do catálogo.', objeto({ livros: lista(esquema('Livro')) }))
      })
    },
    '/api/minhas-reservas': {
      get: operacao('Reservas e empréstimos', 'Consultar reservas ativas', {
        200: resposta('Reservas da conta autenticada.', objeto({ reservas: lista(esquema('Reserva')) })),
        401: naoAutenticado
      }, { security: leitor })
    },
    '/api/reservas': {
      post: operacao('Reservas e empréstimos', 'Reservar um exemplar por 48 horas', {
        201: resposta('Reserva criada.', objeto({ reserva: objeto({ id: texto, retirarAte: data }) })),
        400: erro('Identificador do livro inválido.'),
        401: naoAutenticado,
        404: erro('Livro não encontrado.'),
        409: erro('O livro está indisponível ou já está emprestado ou reservado para esta conta.')
      }, {
        security: leitor,
        requestBody: corpo(objeto({ livroId: { ...texto, example: 'dom-casmurro', pattern: '^[a-z0-9-]{1,64}$' } }))
      })
    },
    '/api/reservas/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { ...texto, pattern: '^[1-9][0-9]{0,17}$' } }],
      delete: operacao('Reservas e empréstimos', 'Cancelar uma reserva ativa da própria conta', {
        204: resposta('Reserva cancelada.'),
        401: naoAutenticado,
        404: erro('Reserva ativa não encontrada para esta conta.')
      }, { security: leitor })
    },
    '/api/meus-emprestimos': {
      get: operacao('Reservas e empréstimos', 'Consultar os empréstimos da própria conta', {
        200: resposta('Livros emprestados.', objeto({ leitor: texto, livros: lista(esquema('Emprestimo')) })),
        401: naoAutenticado
      }, { security: bearer })
    },
    '/api/circulacao': {
      get: operacao('Equipe', 'Consultar o relatório de circulação', respostasCirculacao, { security: bearer })
    },
    '/api/conta/circulacao': {
      get: operacao('Equipe', 'Listar empréstimos ativos com seus leitores', {
        ...respostasCirculacao,
        200: resposta('Totais e relação completa dos empréstimos.', objeto({
          ...indicadoresCirculacao, emprestimos: lista(esquema('EmprestimoCirculacao'))
        }))
      }, { security: leitor })
    },
    '/api/conta/leitores': {
      get: operacao('Equipe', 'Pesquisar leitores cadastrados pelo nome', {
        200: resposta('Até 20 leitores em ordem alfabética, incluindo leitores sem empréstimos.', objeto({
          leitores: lista(objeto({ id: texto, nome, email, emprestimosAtivos: inteiro })),
          pagina: { type: 'integer', minimum: 1 }, temProxima: { type: 'boolean' }
        })),
        400: erro('Nome ou página inválida.'),
        401: naoAutenticado,
        403: respostasCirculacao[403]
      }, { security: leitor, parameters: [
        { name: 'nome', in: 'query', schema: { ...texto, maxLength: 120 }, description: 'Parte do nome ou sobrenome, com ou sem acentos.' },
        { name: 'pagina', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 999999999, default: 1 } }
      ] })
    },
    '/api/conta/leitores/{id}': {
      parameters: [leitorNaRota],
      get: operacao('Equipe', 'Consultar a ficha e as movimentações de um leitor', {
        200: resposta('Cadastro, empréstimos, reservas e históricos de devoluções e renovações do leitor.', objeto({
          leitor: objeto({ id: texto, nome, email, papel: { type: 'string', enum: ['leitor', 'bibliotecaria'] } }),
          livros: lista(esquema('MovimentoEmprestimo')),
          devolucoes: lista(esquema('MovimentoEmprestimo')),
          renovacoes: lista(esquema('Renovacao')),
          reservas: lista(esquema('ReservaConta')),
          historico: lista(esquema('ReservaEncerrada'))
        })),
        401: naoAutenticado,
        403: respostasCirculacao[403],
        404: erro('Leitor não encontrado.')
      }, { security: leitor })
    },
    '/api/conta/leitores/{id}/emprestimos': {
      parameters: [leitorNaRota],
      post: operacao('Equipe', 'Registrar empréstimo para um leitor', {
        201: resposta('Empréstimo registrado. Uma reserva ativa do leitor para este título é marcada como retirada.', objeto({
          emprestimo: objeto({ id: texto, emprestadoEm: data, prazoDevolucao })
        })),
        400: erro('Informe um livro e uma data de devolução válida, de hoje em diante.'), 401: naoAutenticado, 403: respostasCirculacao[403],
        404: erro('Leitor ou livro não encontrado.'),
        409: erro('O leitor já tem este título emprestado ou não há exemplar disponível para ele.')
      }, { security: leitor, requestBody: corpo(objeto({ livroId: { ...texto, example: 'o-alienista', pattern: '^[a-z0-9-]{1,64}$' }, prazoDevolucao, tombo: texto, reservaId: texto }, ['livroId','prazoDevolucao'])) })
    },
    '/api/conta/emprestimos/{emprestimoId}': {
      parameters: [emprestimoNaRota],
      get: operacao('Conta', 'Ver a linha do tempo de um empréstimo próprio', respostasLinhaDoTempo, { security: leitor })
    },
    '/api/conta/leitores/{id}/emprestimos/{emprestimoId}': {
      parameters: [leitorNaRota, emprestimoNaRota],
      get: operacao('Equipe', 'Ver a linha do tempo de um empréstimo da ficha', {
        ...respostasLinhaDoTempo, 403: respostasCirculacao[403]
      }, { security: leitor })
    },
    '/api/conta/leitores/{id}/emprestimos/{emprestimoId}/prazo': {
      parameters: [leitorNaRota, emprestimoNaRota],
      patch: operacao('Equipe', 'Renovar o empréstimo ou definir seu primeiro prazo', {
        200: resposta('Prazo salvo. A prorrogação de um prazo existente acrescenta uma entrada ao histórico de renovações.', objeto({ prazoDevolucao })),
        400: erro('Informe uma data válida de hoje em diante, no horário de Fortaleza.'),
        401: naoAutenticado, 403: respostasCirculacao[403],
        404: erro('Empréstimo não encontrado na ficha deste leitor.'),
        409: erro('O empréstimo já foi devolvido ou a data escolhida não é posterior ao prazo atual.')
      }, { security: leitor, requestBody: corpo(objeto({ prazoDevolucao })) })
    },
    '/api/conta/leitores/{id}/emprestimos/{emprestimoId}/devolucao': {
      parameters: [leitorNaRota, emprestimoNaRota],
      put: operacao('Equipe', 'Registrar a devolução de um empréstimo', {
        204: resposta('Devolução registrada. Repetir a operação preserva a data da primeira devolução.'),
        401: naoAutenticado, 403: respostasCirculacao[403], 404: erro('Empréstimo não encontrado na ficha deste leitor.')
      }, { security: leitor })
    }
  },
  components: {
    securitySchemes: {
      credencialAgenda: { type: 'http', scheme: 'bearer', description: 'Segredo exclusivo do agendador, definido em CRON_SECRET.' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT retornado por POST /api/login.' },
      sessaoCookie: { type: 'apiKey', in: 'cookie', name: 'acervo_sessao', description: 'Cookie enviado automaticamente pelo navegador após POST /api/sessao.' }
    },
    schemas: {
      Mensagem: objeto({ mensagem: texto }),
      Sessao: objeto({ nome: texto, papel: { type: 'string', enum: ['leitor', 'bibliotecaria'] }, expiraEm: inteiro }),
      LoginBearer: { allOf: [esquema('Sessao'), objeto({ token: texto })] },
      Emprestimo: objeto({ titulo: texto, autor: texto }),
      EmprestimoConta: { allOf: [esquema('Emprestimo'), objeto({ livroId: { ...texto, nullable: true } })] },
      EmprestimoComPrazo: { allOf: [esquema('EmprestimoConta'), objeto({
        id: texto,
        registradoPor: { ...texto, nullable: true, description: 'Nome de quem registrou o empréstimo. Nulo quando a autoria é desconhecida.' },
        prazoDevolucao: { ...prazoDevolucao, nullable: true },
        diasEmAtraso: { ...inteiro, description: 'Dias de atraso de um empréstimo ativo. Zero para devolvidos, em dia ou sem prazo.' }
      })] },
      MovimentoEmprestimo: { allOf: [esquema('EmprestimoComPrazo'), objeto({
        emprestadoEm: { ...data, nullable: true, description: 'Data disponível nos empréstimos registrados pelo sistema.' },
        devolvidoEm: { ...data, nullable: true },
        recebidoPor: { ...texto, nullable: true, description: 'Nome de quem recebeu a devolução. Nulo enquanto o empréstimo está ativo ou quando a autoria é desconhecida.' }
      })] },
      EmprestimoCirculacao: { allOf: [esquema('EmprestimoConta'), objeto({
        id: texto, tombo: {...texto, nullable:true}, leitorId: texto, leitor: texto, prazoDevolucao: { ...prazoDevolucao, nullable: true }
      })] },
      EventoEmprestimo: objeto({
        tipo: { type: 'string', enum: ['retirada', 'renovacao', 'devolucao', 'correcao'] },
        data: { ...data, nullable: true }, responsavel: { ...texto, nullable: true },
        prazoAnterior: { type: 'string', format: 'date', nullable: true }, prazoNovo: { type: 'string', format: 'date', nullable: true }, motivo: texto
      }, ['tipo','data','responsavel','prazoAnterior','prazoNovo']),
      Renovacao: { allOf: [esquema('EmprestimoConta'), objeto({
        id: texto, emprestimoId: texto, renovadoEm: data,
        nomeBibliotecario: { ...texto, nullable: true, description: 'Nome da pessoa da equipe no momento da renovação. Nulo em registros antigos sem autoria.' },
        prazoAnterior: { type: 'string', format: 'date' }, prazoNovo: { type: 'string', format: 'date' }
      })] },
      Livro: objeto({ id: texto, titulo: texto, autor: texto, categoria: texto, edicao: texto, capa: texto, descricao: texto, disponiveis: inteiro }),
      Reserva: objeto({ id: texto, titulo: texto, autor: texto, retirarAte: data }),
      ReservaConta: { allOf: [esquema('Reserva'), objeto({ livroId: texto })] },
      ReservaEncerrada: objeto({ id: texto, livroId: texto, titulo: texto, autor: texto, situacao: { type: 'string', enum: ['cancelada', 'expirada', 'retirada'] }, encerradaEm: data }),
      Conta: objeto({
        perfil: objeto({ nome: texto, email, papel: { type: 'string', enum: ['leitor', 'bibliotecaria'] }, demonstracao: { type: 'boolean' } }),
        expiraEm: inteiro,
        livros: lista(esquema('EmprestimoComPrazo')),
        devolucoes: lista(esquema('MovimentoEmprestimo')),
        renovacoes: lista(esquema('Renovacao')),
        reservas: lista(esquema('ReservaConta')),
        historico: lista(esquema('ReservaEncerrada'))
      })
    }
  }
};
