import pg from 'pg';
import { readFileSync } from 'node:fs';
import { operacoesBiblioteca, conflito } from './operacoes-banco.js';
import bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { catalogoInicial, expansaoCatalogo } from './catalogo-inicial.js';
import { diaDaBiblioteca } from './public/conta/calendario.js';

const { Pool } = pg;

export function carregarAmbiente() {
  try { loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url))); }
  catch (erro) { if (erro.code !== 'ENOENT') throw erro; }
}

export function conectarBanco() {
  carregarAmbiente();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Configure DATABASE_URL com a conexão PostgreSQL do Acervo.');
  const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 15000, allowExitOnIdle: true });
  pool.on('error', () => console.error('A conexão ociosa com o banco foi encerrada.'));
  return pool;
}

async function incluirTitulos(cliente, schema, livros) {
  await cliente.query(`
    INSERT INTO ${schema}.catalogo (id, titulo, autor, categoria, capa, descricao, exemplares, ordem)
    SELECT novos.id, novos.titulo, novos.autor, novos.categoria, novos.capa, novos.descricao, novos.exemplares,
      novos.ordem + (SELECT COALESCE(MAX(ordem), -1) + 1 FROM ${schema}.catalogo)
    FROM jsonb_to_recordset($1::jsonb) AS novos(
      id text, titulo text, autor text, categoria text, capa text, descricao text, exemplares integer, ordem integer
    )
    ON CONFLICT DO NOTHING
  `, [JSON.stringify(livros.map((livro, ordem) => ({ ...livro, ordem })))]);
}

// A versão identifica a carga inicial. Reiniciar o servidor nunca repõe dados editados.
export async function prepararBanco(pool, esquema = 'acervo', demonstracao = true, avisarReservas = null) {
  const schema = pg.escapeIdentifier(esquema);
  const cliente = await pool.connect();
  let chaveJwt;
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT pg_advisory_xact_lock(420176, hashtext($1))', [esquema]);
    await cliente.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await cliente.query(`CREATE TABLE IF NOT EXISTS ${schema}.migracoes (versao integer PRIMARY KEY)`);
    const aplicada = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 1`);
    await cliente.query(`CREATE TABLE IF NOT EXISTS ${schema}.ambiente (id integer PRIMARY KEY CHECK(id=1), demonstracao boolean NOT NULL)`);
    if (aplicada.rowCount && !demonstracao) {
      const seeds = await cliente.query(`SELECT id FROM ${schema}.contas WHERE id IN ('B-208','L-104') LIMIT 1`);
      if (seeds.rowCount) throw new Error('Use um esquema separado para os dados reais.');
    }
    await cliente.query(`INSERT INTO ${schema}.ambiente VALUES(1,$1) ON CONFLICT DO NOTHING`,[demonstracao]);
    const ambiente = await cliente.query(`SELECT demonstracao FROM ${schema}.ambiente WHERE id=1`);
    if (ambiente.rows[0].demonstracao !== demonstracao) throw new Error('O modo solicitado é diferente do modo deste esquema.');
    if (!aplicada.rowCount) {
      await cliente.query(`
        CREATE TABLE ${schema}.contas (
          id text PRIMARY KEY,
          nome text NOT NULL,
          papel text NOT NULL CHECK (papel IN ('leitor', 'bibliotecaria')),
          email text NOT NULL UNIQUE CHECK (email = lower(trim(email))),
          senha_hash text NOT NULL
        );
        CREATE TABLE ${schema}.emprestimos (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          conta_id text NOT NULL REFERENCES ${schema}.contas(id),
          titulo text NOT NULL,
          autor text NOT NULL
        );
        CREATE INDEX emprestimos_por_conta ON ${schema}.emprestimos(conta_id, id);
      `);
      if (demonstracao) {
        const [hashLeitor, hashEquipe] = await Promise.all([
          bcrypt.hash('Leitura!104', 10), bcrypt.hash('Equipe!208', 10)
        ]);
        await cliente.query(`
          INSERT INTO ${schema}.contas (id, nome, papel, email, senha_hash) VALUES
          ('L-104', 'Caio Alves', 'leitor', 'leitor@acervo.test', $1),
          ('B-208', 'Lia Ramos', 'bibliotecaria', 'equipe@acervo.test', $2)
        `, [hashLeitor, hashEquipe]);
        await cliente.query(`
          INSERT INTO ${schema}.emprestimos (conta_id, titulo, autor) VALUES
          ('L-104', 'Dom Casmurro', 'Machado de Assis'),
          ('L-104', 'O Quinze', 'Rachel de Queiroz'),
          ('B-208', 'Clara dos Anjos', 'Lima Barreto');
        `);
      }
      await cliente.query(`INSERT INTO ${schema}.migracoes VALUES (1)`);
    }
    const catalogoCriado = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 2`);
    if (!catalogoCriado.rowCount) {
      await cliente.query(`
        CREATE TABLE ${schema}.catalogo (
          id text PRIMARY KEY,
          titulo text NOT NULL,
          autor text NOT NULL,
          categoria text NOT NULL,
          capa text NOT NULL,
          descricao text NOT NULL,
          exemplares integer NOT NULL CHECK (exemplares > 0),
          ordem integer NOT NULL,
          UNIQUE (titulo, autor)
        );
        CREATE TABLE ${schema}.reservas (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          livro_id text NOT NULL REFERENCES ${schema}.catalogo(id),
          conta_id text NOT NULL REFERENCES ${schema}.contas(id),
          retirada_ate timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
          cancelada_em timestamptz
        );
        CREATE INDEX emprestimos_por_obra ON ${schema}.emprestimos(titulo, autor);
        CREATE INDEX reservas_por_obra ON ${schema}.reservas(livro_id, retirada_ate) WHERE cancelada_em IS NULL;
        CREATE INDEX reservas_por_conta ON ${schema}.reservas(conta_id, retirada_ate) WHERE cancelada_em IS NULL;
      `);
      if (demonstracao) await incluirTitulos(cliente, schema, catalogoInicial);
      await cliente.query(`INSERT INTO ${schema}.migracoes (versao) VALUES (2)`);
    }
    const expansaoAplicada = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 3`);
    if (!expansaoAplicada.rowCount) {
      if (demonstracao) await incluirTitulos(cliente, schema, expansaoCatalogo);
      await cliente.query(`INSERT INTO ${schema}.migracoes (versao) VALUES (3)`);
    }
    const versaoSessaoCriada = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 4`);
    if (!versaoSessaoCriada.rowCount) {
      await cliente.query(`
        ALTER TABLE ${schema}.contas ADD COLUMN versao_sessao integer NOT NULL DEFAULT 0;
        INSERT INTO ${schema}.migracoes (versao) VALUES (4);
      `);
    }
    const circulacaoCriada = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 5`);
    if (!circulacaoCriada.rowCount) {
      await cliente.query(`
        ALTER TABLE ${schema}.reservas ADD COLUMN retirada_em timestamptz;
        ALTER TABLE ${schema}.emprestimos
          ADD COLUMN livro_id text REFERENCES ${schema}.catalogo(id),
          ADD COLUMN reserva_id bigint UNIQUE REFERENCES ${schema}.reservas(id),
          ADD COLUMN emprestado_em timestamptz,
          ADD COLUMN devolvido_em timestamptz,
          ADD COLUMN registrado_por text REFERENCES ${schema}.contas(id),
          ADD COLUMN recebido_por text REFERENCES ${schema}.contas(id);
        UPDATE ${schema}.emprestimos e SET livro_id = l.id FROM ${schema}.catalogo l
          WHERE e.titulo = l.titulo AND e.autor = l.autor;
        CREATE INDEX emprestimos_ativos_por_livro ON ${schema}.emprestimos(livro_id, conta_id) WHERE devolvido_em IS NULL;
        INSERT INTO ${schema}.migracoes (versao) VALUES (5);
      `);
    }
    const prazoCriado = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 6`);
    if (!prazoCriado.rowCount) {
      await cliente.query(`
        ALTER TABLE ${schema}.emprestimos ADD COLUMN prazo_devolucao date;
        INSERT INTO ${schema}.migracoes (versao) VALUES (6);
      `);
    }
    const historicoRenovacoes = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 7`);
    if (!historicoRenovacoes.rowCount) {
      await cliente.query(`
        CREATE TABLE ${schema}.renovacoes (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          emprestimo_id bigint NOT NULL REFERENCES ${schema}.emprestimos(id),
          renovado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
          prazo_anterior date NOT NULL,
          prazo_novo date NOT NULL CHECK (prazo_novo > prazo_anterior)
        );
        CREATE INDEX renovacoes_por_emprestimo ON ${schema}.renovacoes(emprestimo_id, id);
        INSERT INTO ${schema}.migracoes (versao) VALUES (7);
      `);
    }
    const autoriaRenovacoes = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 8`);
    if (!autoriaRenovacoes.rowCount) {
      await cliente.query(`
        ALTER TABLE ${schema}.renovacoes
          ADD COLUMN renovado_por text REFERENCES ${schema}.contas(id),
          ADD COLUMN nome_responsavel text,
          ADD CHECK ((renovado_por IS NULL) = (nome_responsavel IS NULL));
        INSERT INTO ${schema}.migracoes (versao) VALUES (8);
      `);
    }
    const autoriaEmprestimos = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 9`);
    if (!autoriaEmprestimos.rowCount) {
      await cliente.query(`
        ALTER TABLE ${schema}.emprestimos
          ADD COLUMN nome_registrante text,
          ADD COLUMN nome_recebedor text;
        UPDATE ${schema}.emprestimos e SET nome_registrante = c.nome
          FROM ${schema}.contas c WHERE e.registrado_por = c.id;
        UPDATE ${schema}.emprestimos e SET nome_recebedor = c.nome
          FROM ${schema}.contas c WHERE e.recebido_por = c.id;
        INSERT INTO ${schema}.migracoes (versao) VALUES (9);
      `);
    }
    const operacao = await cliente.query(`SELECT 1 FROM ${schema}.migracoes WHERE versao=10`);
    if (!operacao.rowCount) {
      const sql = readFileSync(new URL('./migracoes/010-operacao.sql', import.meta.url), 'utf8');
      await cliente.query(sql.replaceAll('__acervo__', schema));
    }
    // Todas as instâncias da API precisam reconhecer o mesmo JWT.
    await cliente.query(`CREATE TABLE IF NOT EXISTS ${schema}.assinatura (
      id integer PRIMARY KEY CHECK (id = 1), chave bytea NOT NULL CHECK (octet_length(chave) = 32)
    )`);
    await cliente.query(`INSERT INTO ${schema}.assinatura (id, chave) VALUES (1, $1)
      ON CONFLICT (id) DO NOTHING`, [randomBytes(32)]);
    const assinatura = await cliente.query(`SELECT chave FROM ${schema}.assinatura WHERE id = 1`);
    chaveJwt = assinatura.rows[0].chave;
    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }

  const reservaAtiva = 'cancelada_em IS NULL AND retirada_em IS NULL AND retirada_ate > now()';
  const mesmaObra = `(e.livro_id = l.id OR (e.livro_id IS NULL AND l.edicao = \'\' AND e.titulo = l.titulo AND e.autor = l.autor))`;
  const disponiveis = `GREATEST((SELECT count(*)::int FROM ${schema}.copias cp WHERE cp.livro_id=l.id AND cp.estado='regular')
    - (SELECT count(*)::int FROM ${schema}.emprestimos e WHERE ${mesmaObra} AND e.devolvido_em IS NULL)
    - (SELECT count(*)::int FROM ${schema}.reservas r WHERE r.livro_id = l.id AND r.${reservaAtiva}), 0)`;

  async function emTransacao(operacao) {
    const conexao = await pool.connect();
    const reservas = [];
    const transacao = {
      query: conexao.query.bind(conexao),
      async criarReserva(livroId, contaId) {
        const {rows:[reserva]} = await conexao.query(`INSERT INTO ${schema}.reservas(livro_id,conta_id)
          VALUES($1,$2) RETURNING id::text, retirada_ate AS "retirarAte"`, [livroId,contaId]);
        reservas.push(reserva.id);
        return reserva;
      }
    };
    let resultado;
    try {
      await conexao.query('BEGIN');
      resultado = await operacao(transacao);
      await conexao.query('COMMIT');
    } catch (erro) {
      await conexao.query('ROLLBACK');
      throw erro;
    } finally {
      conexao.release();
    }
    if (avisarReservas && reservas.length) {
      try { await avisarReservas(reservas); }
      catch { console.error('Aviso de retirada pendente. O próximo processamento tentará novamente.'); }
    }
    return resultado;
  }

  const operacoes = operacoesBiblioteca({pool, schema, emTransacao, disponiveis, reservaAtiva});

  async function verificarExemplar(cliente, contaId, livroId, permitirRetirada) {
    // Reservas e empréstimos disputam o mesmo estoque. Recalcula após obter o bloqueio.
    const bloqueado = await cliente.query(`SELECT id FROM ${schema}.catalogo WHERE id = $1 AND NOT arquivado FOR UPDATE`, [livroId]);
    if (!bloqueado.rowCount) return { erro: 'livroInexistente' };
    await operacoes.promoverFila(cliente, livroId);

    const { rows: [reserva] } = await cliente.query(`
      SELECT id FROM ${schema}.reservas WHERE conta_id = $1 AND livro_id = $2 AND ${reservaAtiva} FOR UPDATE
    `, [contaId, livroId]);
    const { rows: [livro] } = await cliente.query(`
      SELECT l.titulo, l.autor, ${disponiveis} AS disponiveis, EXISTS (
        SELECT 1 FROM ${schema}.emprestimos e WHERE ${mesmaObra} AND e.conta_id = $2 AND e.devolvido_em IS NULL
      ) AS emprestado
      FROM ${schema}.catalogo l WHERE l.id = $1
    `, [livroId, contaId]);
    if (livro.emprestado || (reserva && !permitirRetirada)) return { erro: 'livroJaVinculado' };
    if (!reserva && !livro.disponiveis) return { erro: 'livroIndisponivel' };
    return { livro, reserva };
  }

  return {
    chaveJwt, ...operacoes,
    async criarLeitor({ nome, email, senhaHash }) {
      const { rowCount } = await pool.query(
        `INSERT INTO ${schema}.contas (id, nome, papel, email, senha_hash)
         VALUES ($1, $2, 'leitor', $3, $4) ON CONFLICT (email) DO NOTHING`,
        [randomUUID(), nome, email, senhaHash]
      );
      return rowCount === 1;
    },
    async contaPorEmail(email) {
      const { rows } = await pool.query(`
        SELECT id, nome, papel, senha_hash, versao_sessao FROM ${schema}.contas WHERE email = $1
      `, [email]);
      return rows[0];
    },
    async contaPorId(id) {
      const { rows } = await pool.query(`
        SELECT id, nome, email, papel, foto, versao_sessao FROM ${schema}.contas WHERE id = $1
      `, [id]);
      return rows[0];
    },
    async pesquisarLeitores(nome, pagina) {
      const porPagina = 20;
      const { rows } = await pool.query(`
        WITH cadastro AS (
          SELECT id, nome, email,
            lower(regexp_replace(normalize(nome, NFD), '[\u0300-\u036f]', '', 'g')) AS nome_busca
          FROM ${schema}.contas WHERE papel = 'leitor'
        )
        SELECT c.id, c.nome, c.email,
          (SELECT count(*)::int FROM ${schema}.emprestimos e WHERE e.conta_id = c.id AND e.devolvido_em IS NULL) AS "emprestimosAtivos"
        FROM cadastro c
        WHERE strpos(c.nome_busca, lower(regexp_replace(normalize($1::text, NFD), '[\u0300-\u036f]', '', 'g'))) > 0
        ORDER BY c.nome_busca, c.id
        LIMIT $2 OFFSET $3
      `, [nome, porPagina + 1, (pagina - 1) * porPagina]);
      return { leitores: rows.slice(0, porPagina), pagina, temProxima: rows.length > porPagina };
    },
    async atualizarNome(id, nome) {
      await pool.query(`UPDATE ${schema}.contas SET nome = $2 WHERE id = $1`, [id, nome]);
    },
    async atualizarSenha(id, hashAnterior, novoHash) {
      const { rowCount } = await pool.query(`
        UPDATE ${schema}.contas
        SET senha_hash = $3, versao_sessao = versao_sessao + 1
        WHERE id = $1 AND senha_hash = $2
      `, [id, hashAnterior, novoHash]);
      return rowCount === 1;
    },
    async emprestimosDaConta(id, { devolvidos = false, limite = null } = {}) {
      const { rows } = await pool.query(`
        SELECT e.id::text, e.tombo, e.titulo, e.autor, l.id AS "livroId", e.emprestado_em AS "emprestadoEm", e.devolvido_em AS "devolvidoEm",
          e.nome_registrante AS "registradoPor", e.nome_recebedor AS "recebidoPor",
          to_char(e.prazo_devolucao, 'YYYY-MM-DD') AS "prazoDevolucao",
          CASE WHEN e.devolvido_em IS NULL AND e.prazo_devolucao < $3::date
               THEN $3::date - e.prazo_devolucao ELSE 0 END AS "diasEmAtraso"
        FROM ${schema}.emprestimos e
        LEFT JOIN ${schema}.catalogo l ON ${mesmaObra}
        WHERE e.conta_id = $1 AND e.devolvido_em IS ${devolvidos ? 'NOT NULL' : 'NULL'}
        ORDER BY e.devolvido_em DESC, e.id LIMIT $2
      `, [id, limite, diaDaBiblioteca()]);
      return rows;
    },
    async comprovante(contaId, emprestimoId) {
      const {rows:[registro]} = await pool.query(`SELECT e.titulo,e.autor,e.tombo,c.nome AS leitor,
        to_char(e.prazo_devolucao,'YYYY-MM-DD') AS "prazoDevolucao"
        FROM ${schema}.emprestimos e JOIN ${schema}.contas c ON c.id=e.conta_id
        WHERE e.conta_id=$1 AND e.id=$2`,[contaId,emprestimoId]);
      return registro;
    },
    async eventosDoEmprestimo(contaId, emprestimoId) {
      const { rows } = await pool.query(`
        WITH emprestimo AS (
          SELECT id, emprestado_em, nome_registrante, devolvido_em, nome_recebedor
          FROM ${schema}.emprestimos WHERE conta_id = $1 AND id = $2
        ), eventos AS (
          SELECT 'retirada' AS tipo, emprestado_em AS data, nome_registrante AS responsavel,
            NULL::date AS anterior, NULL::date AS novo, 1 AS etapa, 0::bigint AS sequencia FROM emprestimo
          UNION ALL
          SELECT 'renovacao', r.renovado_em, r.nome_responsavel, r.prazo_anterior, r.prazo_novo, 2, r.id
          FROM emprestimo e JOIN ${schema}.renovacoes r ON r.emprestimo_id = e.id
          UNION ALL
          SELECT 'devolucao', devolvido_em, nome_recebedor, NULL, NULL, 3, 0
          FROM emprestimo WHERE devolvido_em IS NOT NULL
          UNION ALL SELECT 'devolucao', c.devolucao_anterior, c.recebedor_anterior,NULL,NULL,3,c.id FROM ${schema}.correcoes c JOIN emprestimo e ON e.id=c.emprestimo_id
          UNION ALL SELECT 'correcao',c.em,c.responsavel,NULL,NULL,4,c.id FROM ${schema}.correcoes c JOIN emprestimo e ON e.id=c.emprestimo_id
        )
        SELECT tipo, data, responsavel, to_char(anterior, 'YYYY-MM-DD') AS "prazoAnterior",
          to_char(novo, 'YYYY-MM-DD') AS "prazoNovo"
          , CASE WHEN tipo='correcao' THEN (SELECT c.motivo FROM ${schema}.correcoes c WHERE c.id=sequencia) END AS motivo
        FROM eventos ORDER BY data NULLS FIRST, etapa, sequencia
      `, [contaId, emprestimoId]);
      return rows.map(({motivo,...evento}) => motivo ? {...evento,motivo} : evento);
    },
    async renovacoesDaConta(contaId) {
      const { rows } = await pool.query(`
        SELECT r.id::text, e.id::text AS "emprestimoId", l.id AS "livroId", e.titulo, e.autor,
          r.renovado_em AS "renovadoEm", r.nome_responsavel AS "nomeBibliotecario",
          to_char(r.prazo_anterior, 'YYYY-MM-DD') AS "prazoAnterior",
          to_char(r.prazo_novo, 'YYYY-MM-DD') AS "prazoNovo"
        FROM ${schema}.emprestimos e
        JOIN ${schema}.renovacoes r ON r.emprestimo_id = e.id
        LEFT JOIN ${schema}.catalogo l ON ${mesmaObra}
        WHERE e.conta_id = $1
        ORDER BY r.renovado_em DESC, r.id DESC
      `, [contaId]);
      return rows;
    },
    async catalogo() {
      await operacoes.atualizarFilas();
      const { rows } = await pool.query(`
        SELECT l.id, l.titulo, l.autor, l.categoria, l.capa, l.descricao, l.edicao, ${disponiveis} AS disponiveis
        FROM ${schema}.catalogo l WHERE NOT l.arquivado ORDER BY l.ordem, l.id
      `);
      return rows;
    },
    async reservasDaConta(contaId) {
      await operacoes.atualizarFilas();
      const { rows } = await pool.query(`
        SELECT r.id::text, r.livro_id AS "livroId", l.titulo, l.autor, r.retirada_ate AS "retirarAte"
        FROM ${schema}.reservas r JOIN ${schema}.catalogo l ON l.id = r.livro_id
        WHERE r.conta_id = $1 AND r.${reservaAtiva}
        ORDER BY r.retirada_ate, r.id
      `, [contaId]);
      return rows;
    },
    async reservasEncerradasDaConta(contaId, limite = 20) {
      const { rows } = await pool.query(`
        SELECT r.id::text, r.livro_id AS "livroId", l.titulo, l.autor,
          CASE WHEN r.retirada_em IS NOT NULL THEN 'retirada'
               WHEN r.cancelada_em IS NOT NULL THEN 'cancelada' ELSE 'expirada' END AS situacao,
          COALESCE(r.retirada_em, r.cancelada_em, r.retirada_ate) AS "encerradaEm"
        FROM ${schema}.reservas r JOIN ${schema}.catalogo l ON l.id = r.livro_id
        WHERE r.conta_id = $1 AND NOT (${reservaAtiva})
        ORDER BY "encerradaEm" DESC, r.id DESC LIMIT $2
      `, [contaId, limite]);
      return rows;
    },
    async reservarLivro(contaId, livroId) {
      return emTransacao(async cliente => {
        const { erro } = await verificarExemplar(cliente, contaId, livroId, false);
        if (erro) return { erro };
        const reserva = await cliente.criarReserva(livroId, contaId);
        return { reserva };
      });
    },
    async registrarEmprestimo(contaId, livroId, responsavel, prazoDevolucao, tombo = null, reservaEsperada = null) {
      return emTransacao(async cliente => {
        const { livro, reserva, erro } = await verificarExemplar(cliente, contaId, livroId, true);
        if (erro) return { erro };
        if (reservaEsperada && reserva?.id !== reservaEsperada) conflito('Esta reserva já encerrou.');
        await cliente.query(`SELECT id FROM ${schema}.contas WHERE id=$1 FOR UPDATE`,[contaId]);
        const regras = await operacoes.regras(cliente);
        const ativos = await cliente.query(`SELECT count(*)::int AS n FROM ${schema}.emprestimos WHERE conta_id=$1 AND devolvido_em IS NULL`,[contaId]);
        if (ativos.rows[0].n >= regras.limite) conflito('O leitor atingiu o limite de empréstimos ativos.');
        const {rows:[copia]} = await cliente.query(`SELECT c.tombo FROM ${schema}.copias c
          WHERE c.livro_id=$1 AND c.estado='regular' AND ($2::text IS NULL OR c.tombo=$2)
          AND NOT EXISTS(SELECT 1 FROM ${schema}.emprestimos e WHERE e.tombo=c.tombo AND e.devolvido_em IS NULL)
          ORDER BY c.tombo LIMIT 1 FOR UPDATE`,[livroId,tombo]);
        if (!copia) conflito('O exemplar selecionado está indisponível.');
        const { rows: [emprestimo] } = await cliente.query(`
          INSERT INTO ${schema}.emprestimos
            (conta_id, livro_id, titulo, autor, reserva_id, emprestado_em, registrado_por, nome_registrante, prazo_devolucao, tombo)
          VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9)
          RETURNING id::text, emprestado_em AS "emprestadoEm", to_char(prazo_devolucao, 'YYYY-MM-DD') AS "prazoDevolucao"
        `, [contaId, livroId, livro.titulo, livro.autor, reserva?.id ?? null, responsavel.id, responsavel.nome, prazoDevolucao, copia.tombo]);
        if (reserva) await cliente.query(`UPDATE ${schema}.reservas SET retirada_em = now() WHERE id = $1`, [reserva.id]);
        return { emprestimo };
      });
    },
    async atualizarPrazoEmprestimo(contaId, emprestimoId, prazo, responsavel) {
      return emTransacao(async cliente => {
        const { rows: [emprestimo] } = await cliente.query(`
          SELECT livro_id, devolvido_em, to_char(prazo_devolucao, 'YYYY-MM-DD') AS anterior
          FROM ${schema}.emprestimos WHERE conta_id = $1 AND id = $2 FOR UPDATE
        `, [contaId, emprestimoId]);
        if (!emprestimo) return 'inexistente';
        if (emprestimo.devolvido_em) return 'devolvido';
        if (emprestimo.anterior && prazo <= emprestimo.anterior) return 'prazoNaoProrrogado';
        if (emprestimo.anterior) {
          const regras = await operacoes.regras(cliente);
          const {rows:[uso]}=await cliente.query(`SELECT (SELECT count(*)::int FROM ${schema}.renovacoes WHERE emprestimo_id=$1) AS n,
            EXISTS(SELECT 1 FROM ${schema}.fila WHERE livro_id=$2 AND saida IS NULL) AS espera`,[emprestimoId,emprestimo.livro_id]);
          if (uso.n >= regras.renovacoes) conflito('Limite de renovações atingido.');
          if (regras.respeitar_fila && uso.espera) conflito('Há leitores na fila de espera deste livro.');
        }
        await cliente.query(`UPDATE ${schema}.emprestimos SET prazo_devolucao = $2 WHERE id = $1`, [emprestimoId, prazo]);
        if (emprestimo.anterior) {
          await cliente.query(`
            INSERT INTO ${schema}.renovacoes (emprestimo_id, prazo_anterior, prazo_novo, renovado_por, nome_responsavel)
            VALUES ($1, $2, $3, $4, $5)
          `, [emprestimoId, emprestimo.anterior, prazo, responsavel.id, responsavel.nome]);
        }
        return 'atualizado';
      });
    },
    async devolverEmprestimo(contaId, emprestimoId, responsavel) {
      return emTransacao(async cliente => {
        const livro = await operacoes.travarObraDoEmprestimo(cliente,contaId,emprestimoId);
        const { rowCount } = await cliente.query(`
        UPDATE ${schema}.emprestimos SET
          recebido_por = CASE WHEN devolvido_em IS NULL THEN $3 ELSE recebido_por END,
          nome_recebedor = CASE WHEN devolvido_em IS NULL THEN $4 ELSE nome_recebedor END,
          devolvido_em = COALESCE(devolvido_em, now())
        WHERE conta_id = $1 AND id = $2
      `, [contaId, emprestimoId, responsavel.id, responsavel.nome]);
        if (livro) await operacoes.promoverFila(cliente,livro);
        return rowCount === 1;
      });
    },
    async cancelarReserva(contaId, reservaId) {
      return emTransacao(async cliente => {
        const {rows:[livro]} = await cliente.query(`SELECT l.id FROM ${schema}.catalogo l JOIN ${schema}.reservas r ON r.livro_id=l.id WHERE r.id=$1 AND r.conta_id=$2 FOR UPDATE OF l`,[reservaId,contaId]);
        if (!livro) return false;
        const {rowCount} = await cliente.query(`UPDATE ${schema}.reservas SET cancelada_em=now() WHERE id=$1 AND conta_id=$2 AND ${reservaAtiva}`,[reservaId,contaId]);
        if (rowCount) await operacoes.promoverFila(cliente,livro.id);
        return Boolean(rowCount);
      });
    },
    async circulacao() {
      const { rows } = await pool.query(`
        SELECT count(*)::int AS "emprestimosAtivos", count(DISTINCT conta_id)::int AS "leitoresComEmprestimos"
        FROM ${schema}.emprestimos WHERE devolvido_em IS NULL
      `);
      return rows[0];
    },
    async circulacaoDetalhada() {
      const { rows: emprestimos } = await pool.query(`
        SELECT e.id::text AS id, e.titulo, e.autor, l.id AS "livroId",
          e.tombo, c.id AS "leitorId", c.nome AS leitor, to_char(e.prazo_devolucao, 'YYYY-MM-DD') AS "prazoDevolucao"
        FROM ${schema}.emprestimos e
        JOIN ${schema}.contas c ON c.id = e.conta_id
        LEFT JOIN ${schema}.catalogo l ON ${mesmaObra}
        WHERE e.devolvido_em IS NULL
        ORDER BY e.titulo, e.autor, c.nome, e.id
      `);
      return {
        emprestimosAtivos: emprestimos.length,
        leitoresComEmprestimos: new Set(emprestimos.map(item => item.leitorId)).size,
        emprestimos
      };
    }
  };
}
