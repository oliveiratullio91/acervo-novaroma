import pg from 'pg';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

export function conectarBanco() {
  if (!process.env.DATABASE_URL) {
    try { loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url))); }
    catch (erro) { if (erro.code !== 'ENOENT') throw erro; }
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Configure DATABASE_URL com a conexão PostgreSQL do Acervo.');
  const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 15000, allowExitOnIdle: true });
  pool.on('error', () => console.error('A conexão ociosa com o banco foi encerrada.'));
  return pool;
}

// A versão identifica a carga inicial. Reiniciar o servidor nunca repõe dados editados.
export async function prepararBanco(pool, esquema = 'acervo') {
  const schema = pg.escapeIdentifier(esquema);
  const cliente = await pool.connect();
  let chaveJwt;
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT pg_advisory_xact_lock(420176, hashtext($1))', [esquema]);
    await cliente.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await cliente.query(`CREATE TABLE IF NOT EXISTS ${schema}.migracoes (versao integer PRIMARY KEY)`);
    const aplicada = await cliente.query(`SELECT versao FROM ${schema}.migracoes WHERE versao = 1`);
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
        INSERT INTO ${schema}.migracoes (versao) VALUES (1);
      `);
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

  return {
    chaveJwt,
    async contaPorEmail(email) {
      const { rows } = await pool.query(`SELECT id, nome, papel, senha_hash FROM ${schema}.contas WHERE email = $1`, [email]);
      return rows[0];
    },
    async contaPorId(id) {
      const { rows } = await pool.query(`SELECT id, nome, papel FROM ${schema}.contas WHERE id = $1`, [id]);
      return rows[0];
    },
    async emprestimosDaConta(id) {
      const { rows } = await pool.query(`SELECT titulo, autor FROM ${schema}.emprestimos WHERE conta_id = $1 ORDER BY id`, [id]);
      return rows;
    },
    async circulacao() {
      const { rows } = await pool.query(`
        SELECT count(*)::int AS "emprestimosAtivos", count(DISTINCT conta_id)::int AS "leitoresComEmprestimos"
        FROM ${schema}.emprestimos
      `);
      return rows[0];
    }
  };
}
