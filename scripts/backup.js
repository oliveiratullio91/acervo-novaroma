import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { prepararBanco } from '../banco.js';

// Ordem de dependência para preservar chaves estrangeiras durante a restauração.
const tabelas = [
  'contas',
  'catalogo',
  'copias',
  'reservas',
  'emprestimos',
  'renovacoes',
  'correcoes',
  'fila',
  'estante',
  'regras',
  'emails_enviados'
];
const nome = pg.escapeIdentifier;
const sequencias = (cliente, esquema) =>
  cliente.query('SELECT sequencename FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename', [esquema]);

export async function salvarBackup(pool, esquema, arquivo) {
  const c = await pool.connect(),
    s = nome(esquema);
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {
      rows: [ambiente]
    } = await c.query(`SELECT demonstracao FROM ${s}.ambiente`);
    const {
      rows: [versao]
    } = await c.query(`SELECT max(versao) AS numero FROM ${s}.migracoes`);
    const dados = {
      formato: 1,
      versao: versao.numero,
      demonstracao: ambiente.demonstracao,
      criadoEm: new Date(),
      tabelas: {},
      sequencias: {}
    };
    for (const t of tabelas) {
      const {
        rows: [r]
      } = await c.query(
        `SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS itens FROM ${s}.${nome(t)} t`
      );
      dados.tabelas[t] = r.itens;
    }
    for (const { sequencename: seq } of (await sequencias(c, esquema)).rows) {
      dados.sequencias[seq] = (
        await c.query(`SELECT last_value::text,is_called FROM ${s}.${nome(seq)}`)
      ).rows[0];
    }
    await c.query('COMMIT');
    await writeFile(arquivo, JSON.stringify(dados), { flag: 'wx', mode: 0o600 });
  } catch (erro) {
    await c.query('ROLLBACK');
    throw erro;
  } finally {
    c.release();
  }
}

export async function restaurarBackup(pool, arquivo, destino) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(destino)) throw Error('Nome de esquema inválido.');
  const dados = JSON.parse(await readFile(arquivo, 'utf8'));
  if (
    dados.formato !== 1 ||
    typeof dados.demonstracao !== 'boolean' ||
    !tabelas.every((t) => Array.isArray(dados.tabelas?.[t]))
  )
    throw Error('Arquivo de backup inválido.');
  if ((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [destino])).rowCount)
    throw Error('O esquema de destino já existe.');
  const temporario = 'acervo_restore_' + randomUUID().replaceAll('-', ''),
    s = nome(temporario);
  await pool.query('CREATE SCHEMA ' + s);
  let publicado = false;
  try {
    await prepararBanco(pool, temporario, dados.demonstracao);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const {
        rows: [versao]
      } = await c.query(`SELECT max(versao) AS numero FROM ${s}.migracoes`);
      if (dados.versao !== versao.numero) throw Error('Use a versão do projeto correspondente ao backup.');
      await c.query(
        'TRUNCATE ' +
          tabelas
            .concat('recuperacao')
            .map((t) => s + '.' + nome(t))
            .join(',')
      );
      for (const tabela of tabelas) {
        const t = s + '.' + nome(tabela);
        await c.query(
          `INSERT INTO ${t} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::${t},$1::jsonb)`,
          [JSON.stringify(dados.tabelas[tabela])]
        );
      }
      for (const { sequencename: seq } of (await sequencias(c, temporario)).rows) {
        const valor = dados.sequencias[seq];
        if (!valor || !/^\d+$/.test(valor.last_value) || typeof valor.is_called !== 'boolean')
          throw Error('Sequência ausente no backup.');
        await c.query('SELECT setval($1::regclass,$2::bigint,$3)', [
          s + '.' + nome(seq),
          valor.last_value,
          valor.is_called
        ]);
      }
      await c.query('ALTER SCHEMA ' + s + ' RENAME TO ' + nome(destino));
      await c.query('COMMIT');
      publicado = true;
    } catch (erro) {
      await c.query('ROLLBACK');
      throw erro;
    } finally {
      c.release();
    }
  } finally {
    if (!publicado) await pool.query('DROP SCHEMA ' + s + ' CASCADE');
  }
}
