import { randomUUID } from 'node:crypto';

export function falha(status, mensagem) {
  throw Object.assign(new Error(mensagem), { status, publica: true });
}
export const conflito = (mensagem) => falha(409, mensagem);
export function operacoesBiblioteca({ pool, schema: s, emTransacao, disponiveis, reservaAtiva }) {
  const consultar = async (sql, valores = [], cliente = pool) => (await cliente.query(sql, valores)).rows;
  const unico = async (sql, valores, cliente) => (await consultar(sql, valores, cliente))[0];
  async function travarLivro(cliente, id) {
    const livro = await unico(`SELECT * FROM ${s}.catalogo WHERE id=$1 FOR UPDATE`, [id], cliente);
    if (!livro) falha(404, 'Livro não encontrado.');
    return livro;
  }
  async function promoverFila(cliente, livroId) {
    const estoque = await unico(
      `SELECT ${disponiveis} AS n FROM ${s}.catalogo l WHERE l.id=$1 AND NOT arquivado`,
      [livroId],
      cliente
    );
    if (!estoque?.n) return;
    const fila = await consultar(
      `SELECT id,conta_id FROM ${s}.fila WHERE livro_id=$1 AND saida IS NULL ORDER BY id LIMIT $2 FOR UPDATE`,
      [livroId, estoque.n],
      cliente
    );
    for (const pessoa of fila) {
      const reserva = await cliente.criarReserva(livroId, pessoa.conta_id);
      await cliente.query(`UPDATE ${s}.fila SET saida=now(),reserva_id=$2 WHERE id=$1`, [
        pessoa.id,
        reserva.id
      ]);
    }
  }
  async function atualizarFilas() {
    const pendentes = await consultar(`SELECT l.id FROM ${s}.catalogo l WHERE NOT arquivado AND EXISTS
      (SELECT 1 FROM ${s}.fila f WHERE f.livro_id=l.id AND saida IS NULL) AND ${disponiveis}>0 ORDER BY l.id`);
    for (const { id } of pendentes)
      await emTransacao(async (c) => {
        await travarLivro(c, id);
        await promoverFila(c, id);
      });
  }
  async function travarObraDoEmprestimo(cliente, conta, id) {
    const e = await unico(
      `SELECT livro_id FROM ${s}.emprestimos WHERE id=$1 AND conta_id=$2`,
      [id, conta],
      cliente
    );
    if (e?.livro_id) await travarLivro(cliente, e.livro_id);
    return e?.livro_id;
  }
  async function cadastrarLivro(id, dados) {
    return emTransacao(async (c) => {
      const campos = [dados.titulo, dados.autor, dados.edicao, dados.categoria, dados.descricao, dados.capa];
      if (id) {
        await travarLivro(c, id);
        await c.query(
          `UPDATE ${s}.catalogo SET titulo=$1,autor=$2,edicao=$3,categoria=$4,descricao=$5,capa=$6 WHERE id=$7`,
          [...campos, id]
        );
      } else {
        id = randomUUID();
        await c.query(
          `INSERT INTO ${s}.catalogo(titulo,autor,edicao,categoria,descricao,capa,id,exemplares,ordem)
          VALUES($1,$2,$3,$4,$5,$6,$7,0,(SELECT coalesce(max(ordem),0)+1 FROM ${s}.catalogo))`,
          [...campos, id]
        );
      }
      return { id };
    });
  }
  async function mudarArquivo(id, arquivado) {
    await emTransacao(async (c) => {
      await travarLivro(c, id);
      const uso = await unico(
        `SELECT EXISTS(SELECT 1 FROM ${s}.emprestimos WHERE livro_id=$1 AND devolvido_em IS NULL
        UNION ALL SELECT 1 FROM ${s}.reservas WHERE livro_id=$1 AND ${reservaAtiva}
        UNION ALL SELECT 1 FROM ${s}.fila WHERE livro_id=$1 AND saida IS NULL) AS ativo`,
        [id],
        c
      );
      if (arquivado && uso.ativo) conflito('Conclua os empréstimos, reservas e esperas antes de arquivar.');
      await c.query(`UPDATE ${s}.catalogo SET arquivado=$2 WHERE id=$1`, [id, arquivado]);
    });
  }
  async function salvarCopia(id, tombo, localizacao, estado) {
    return emTransacao(async (c) => {
      const livro = await travarLivro(c, id);
      if (livro.arquivado) conflito('Reative o título antes de alterar seus exemplares.');
      if (!tombo) {
        const copia = await unico(
          `INSERT INTO ${s}.copias(livro_id,localizacao,estado) VALUES($1,$2,$3) RETURNING tombo`,
          [id, localizacao, estado],
          c
        );
        await c.query(`UPDATE ${s}.catalogo SET exemplares=exemplares+1 WHERE id=$1`, [id]);
        tombo = copia.tombo;
      } else {
        const copia = await unico(
          `SELECT estado FROM ${s}.copias WHERE livro_id=$1 AND tombo=$2 FOR UPDATE`,
          [id, tombo],
          c
        );
        if (!copia) falha(404, 'Tombo não encontrado para esta edição.');
        if (copia.estado === 'regular' && estado !== 'regular') {
          const uso = await unico(
            `SELECT ${disponiveis} AS livres,EXISTS(SELECT 1 FROM ${s}.emprestimos WHERE tombo=$2 AND devolvido_em IS NULL) AS ocupado
            FROM ${s}.catalogo l WHERE l.id=$1`,
            [id, tombo],
            c
          );
          if (uso.ocupado || !uso.livres)
            conflito('O exemplar está emprestado ou comprometido com uma reserva.');
        }
        await c.query(`UPDATE ${s}.copias SET localizacao=$2,estado=$3 WHERE tombo=$1`, [
          tombo,
          localizacao,
          estado
        ]);
      }
      await promoverFila(c, id);
      return { tombo };
    });
  }
  const regras = (cliente) =>
    unico(`SELECT dias,limite,renovacoes,respeitar_fila FROM ${s}.regras WHERE id=1`, [], cliente);
  return {
    promoverFila,
    atualizarFilas,
    travarObraDoEmprestimo,
    cadastrarLivro,
    mudarArquivo,
    salvarCopia,
    regras,
    gestaoLivros: () =>
      consultar(
        `SELECT id,titulo,autor,categoria,edicao,capa,descricao,arquivado FROM ${s}.catalogo ORDER BY titulo,edicao`
      ),
    copias: () =>
      consultar(`SELECT c.tombo,c.livro_id AS "livroId",l.titulo,l.edicao,c.localizacao,c.estado,
      CASE WHEN e.id IS NOT NULL THEN 'emprestado' WHEN l.arquivado THEN 'arquivado' ELSE c.estado END AS situacao,
      c.conferido_em AS "conferidoEm",e.id::text AS "emprestimoId",e.conta_id AS "leitorId",a.nome AS leitor
      FROM ${s}.copias c JOIN ${s}.catalogo l ON l.id=c.livro_id LEFT JOIN ${s}.emprestimos e ON e.tombo=c.tombo AND e.devolvido_em IS NULL
      LEFT JOIN ${s}.contas a ON a.id=e.conta_id ORDER BY l.titulo,c.tombo`),
    conferir: async (tombo, equipe) => {
      if (
        !(
          await pool.query(`UPDATE ${s}.copias SET conferido_em=now(),conferido_por=$2 WHERE tombo=$1`, [
            tombo,
            equipe
          ])
        ).rowCount
      )
        falha(404, 'Tombo não encontrado.');
    },
    salvarRegras: (r) =>
      pool.query(`UPDATE ${s}.regras SET dias=$1,limite=$2,renovacoes=$3,respeitar_fila=$4 WHERE id=1`, [
        r.dias,
        r.limite,
        r.renovacoes,
        r.respeitar_fila
      ]),
    reservasBalcao: () =>
      consultar(`SELECT r.id::text,r.livro_id AS "livroId",r.conta_id AS "leitorId",c.nome AS leitor,l.titulo,r.retirada_ate AS "retirarAte"
      FROM ${s}.reservas r JOIN ${s}.catalogo l ON l.id=r.livro_id JOIN ${s}.contas c ON c.id=r.conta_id WHERE ${reservaAtiva} ORDER BY retirada_ate,r.id`),
    async entrarFila(conta, livroId) {
      return emTransacao(async (c) => {
        const livro = await travarLivro(c, livroId);
        if (livro.arquivado) conflito('Livro arquivado.');
        await promoverFila(c, livroId);
        const uso = await unico(
          `SELECT ${disponiveis} AS livres, EXISTS(SELECT 1 FROM ${s}.emprestimos WHERE livro_id=$1 AND conta_id=$2 AND devolvido_em IS NULL
          UNION ALL SELECT 1 FROM ${s}.reservas WHERE livro_id=$1 AND conta_id=$2 AND ${reservaAtiva}) AS ativo FROM ${s}.catalogo l WHERE id=$1`,
          [livroId, conta],
          c
        );
        if (uso.livres || uso.ativo)
          conflito('Consulte a disponibilidade e os vínculos deste livro na sua conta.');
        await c.query(`INSERT INTO ${s}.fila(conta_id,livro_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [
          conta,
          livroId
        ]);
      });
    },
    sairFila: (conta, id) =>
      pool.query(`UPDATE ${s}.fila SET saida=now() WHERE conta_id=$1 AND livro_id=$2 AND saida IS NULL`, [
        conta,
        id
      ]),
    minhaFila: (conta) =>
      consultar(
        `SELECT f.livro_id AS "livroId",l.titulo,(SELECT count(*)::int FROM ${s}.fila a WHERE a.livro_id=f.livro_id AND a.saida IS NULL AND a.id<=f.id) AS posicao
      FROM ${s}.fila f JOIN ${s}.catalogo l ON l.id=f.livro_id WHERE f.conta_id=$1 AND f.saida IS NULL ORDER BY f.id`,
        [conta]
      ),
    estante: (conta) =>
      consultar(
        `SELECT l.id,l.titulo,l.arquivado,${disponiveis} AS disponiveis FROM ${s}.estante f JOIN ${s}.catalogo l ON l.id=f.livro_id WHERE conta_id=$1 ORDER BY l.titulo`,
        [conta]
      ),
    async favoritar(conta, id) {
      await emTransacao(async (c) => {
        const livro = await travarLivro(c, id);
        if (livro.arquivado) conflito('Esta edição está arquivada.');
        await c.query(`INSERT INTO ${s}.estante VALUES($1,$2) ON CONFLICT DO NOTHING`, [conta, id]);
      });
    },
    desfavoritar: (conta, id) =>
      pool.query(`DELETE FROM ${s}.estante WHERE conta_id=$1 AND livro_id=$2`, [conta, id]),
    preferencias: (conta) => unico(`SELECT id,nome,foto,avisos_email FROM ${s}.contas WHERE id=$1`, [conta]),
    preferirEmail: (conta, sim) =>
      pool.query(`UPDATE ${s}.contas SET avisos_email=$2 WHERE id=$1`, [conta, sim]),
    salvarFoto: (conta, foto) => pool.query(`UPDATE ${s}.contas SET foto=$2 WHERE id=$1`, [conta, foto]),
    async corrigirDevolucao(conta, id, motivo, equipe) {
      await emTransacao(async (c) => {
        const obra = await travarObraDoEmprestimo(c, conta, id);
        const e = await unico(
          `SELECT * FROM ${s}.emprestimos WHERE id=$1 AND conta_id=$2 FOR UPDATE`,
          [id, conta],
          c
        );
        if (!e) falha(404, 'Empréstimo não encontrado.');
        if (!e.devolvido_em) conflito('Este empréstimo já está ativo.');
        if (obra) {
          const uso = await unico(
            `SELECT ${disponiveis} AS livres,l.arquivado, EXISTS(SELECT 1 FROM ${s}.emprestimos WHERE devolvido_em IS NULL AND (tombo=$2 OR (livro_id=$1 AND conta_id=$3))) AS ocupado,
            EXISTS(SELECT 1 FROM ${s}.copias WHERE tombo=$2 AND estado<>'regular') AS impedido FROM ${s}.catalogo l WHERE l.id=$1`,
            [obra, e.tombo, conta],
            c
          );
          if (!uso.livres || uso.ocupado || uso.impedido || uso.arquivado)
            conflito('O exemplar está indisponível para reabrir este empréstimo.');
        }
        await c.query(
          `INSERT INTO ${s}.correcoes(emprestimo_id,responsavel,equipe_id,motivo,devolucao_anterior,recebedor_anterior) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, equipe.nome, equipe.id, motivo, e.devolvido_em, e.nome_recebedor]
        );
        await c.query(
          `UPDATE ${s}.emprestimos SET devolvido_em=NULL,recebido_por=NULL,nome_recebedor=NULL WHERE id=$1`,
          [id]
        );
      });
    },
    async historico(conta, termo, de, ate, pagina) {
      const linhas = await consultar(
        `WITH movimentos AS (
        SELECT e.id::text AS id,e.titulo,'devolucao' AS tipo,e.devolvido_em AS data,e.id::text AS "emprestimoId" FROM ${s}.emprestimos e WHERE conta_id=$1 AND devolvido_em IS NOT NULL
        UNION ALL SELECT r.id::text,e.titulo,'renovacao',r.renovado_em,e.id::text FROM ${s}.renovacoes r JOIN ${s}.emprestimos e ON e.id=r.emprestimo_id WHERE e.conta_id=$1
        UNION ALL SELECT r.id::text,l.titulo,CASE WHEN retirada_em IS NOT NULL THEN 'retirada' WHEN cancelada_em IS NOT NULL THEN 'cancelada' ELSE 'expirada' END,
          coalesce(retirada_em,cancelada_em,retirada_ate),e.id::text FROM ${s}.reservas r JOIN ${s}.catalogo l ON l.id=r.livro_id LEFT JOIN ${s}.emprestimos e ON e.reserva_id=r.id
          WHERE r.conta_id=$1 AND NOT (r.cancelada_em IS NULL AND r.retirada_em IS NULL AND r.retirada_ate>now())
        UNION ALL SELECT id::text,titulo,'emprestimo',emprestado_em,id::text FROM ${s}.emprestimos WHERE conta_id=$1
        UNION ALL SELECT c.id::text,e.titulo,'devolucao',c.devolucao_anterior,e.id::text FROM ${s}.correcoes c JOIN ${s}.emprestimos e ON e.id=c.emprestimo_id WHERE e.conta_id=$1
        UNION ALL SELECT c.id::text,e.titulo,'correcao',c.em,e.id::text FROM ${s}.correcoes c JOIN ${s}.emprestimos e ON e.id=c.emprestimo_id WHERE e.conta_id=$1
      ) SELECT * FROM movimentos WHERE strpos(lower(titulo),lower($2))>0 AND ($3::date IS NULL OR (data AT TIME ZONE 'America/Fortaleza')::date >= $3)
        AND ($4::date IS NULL OR (data AT TIME ZONE 'America/Fortaleza')::date <= $4) ORDER BY data DESC NULLS LAST,tipo,id LIMIT 21 OFFSET $5`,
        [conta, termo, de, ate, (pagina - 1) * 20]
      );
      return { itens: linhas.slice(0, 20), pagina, mais: linhas.length > 20 };
    },
    async indicadores(de, ate) {
      return consultar(
        `WITH retiradas AS (SELECT livro_id,count(*)::int n FROM ${s}.emprestimos WHERE (emprestado_em AT TIME ZONE 'America/Fortaleza')::date BETWEEN $1 AND $2 GROUP BY livro_id),
        procura AS (SELECT livro_id,count(*)::int n,round(avg(extract(epoch FROM (saida-entrada))/86400) FILTER(WHERE reserva_id IS NOT NULL),1) AS espera
        FROM ${s}.fila WHERE (entrada AT TIME ZONE 'America/Fortaleza')::date BETWEEN $1 AND $2 GROUP BY livro_id)
        SELECT l.titulo,l.edicao,coalesce(r.n,0) AS retiradas,coalesce(p.n,0) AS pedidos,p.espera AS "esperaDias",
        (SELECT count(*)::int FROM ${s}.copias WHERE livro_id=l.id AND estado<>'regular') AS indisponiveis,
        (SELECT count(*)::int FROM ${s}.fila WHERE livro_id=l.id AND saida IS NULL) AS aguardando
        FROM ${s}.catalogo l LEFT JOIN retiradas r ON r.livro_id=l.id LEFT JOIN procura p ON p.livro_id=l.id
        ORDER BY coalesce(r.n,0)+coalesce(p.n,0) DESC,l.titulo`,
        [de, ate]
      );
    }
  };
}
