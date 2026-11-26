import pg from 'pg';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { conectarBanco, prepararBanco } from '../banco.js';
import { transporteEmail, enviarLembretes, origemBiblioteca } from '../correio.js';
import { salvarBackup, restaurarBackup } from './backup.js';
const pool = conectarBanco(),
  demo = process.env.ACERVO_MODO !== 'real';
const esquema = process.env.ACERVO_ESQUEMA || (demo ? 'acervo' : 'acervo_real'),
  s = pg.escapeIdentifier(esquema);
const [acao, arquivo, destino] = process.argv.slice(2);
try {
  if (acao === 'backup' && arquivo) await salvarBackup(pool, esquema, arquivo);
  else if (acao === 'restaurar' && arquivo && destino) await restaurarBackup(pool, arquivo, destino);
  else if (acao === 'avisos') {
    const banco = await prepararBanco(pool, esquema, demo);
    await banco.atualizarFilas();
    await enviarLembretes(pool, s, transporteEmail(), {origem:origemBiblioteca(demo)});
  } else if (acao === 'equipe') {
    const email = process.env.ACERVO_EQUIPE_EMAIL?.trim().toLowerCase(),
      nome = process.env.ACERVO_EQUIPE_NOME?.trim(),
      senha = process.env.ACERVO_EQUIPE_SENHA;
    if (
      !nome ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '') ||
      !senha?.trim() ||
      senha.length < 8 ||
      Buffer.byteLength(senha) > 72
    )
      throw Error('Configure ACERVO_EQUIPE_NOME, ACERVO_EQUIPE_EMAIL e ACERVO_EQUIPE_SENHA.');
    await prepararBanco(pool, esquema, demo);
    await pool.query(
      `INSERT INTO ${s}.contas(id,nome,email,senha_hash,papel) VALUES($1,$2,$3,$4,'bibliotecaria')`,
      [randomUUID(), nome, email, await bcrypt.hash(senha, 10)]
    );
  } else throw Error('Uso: administrar.js backup arquivo | restaurar arquivo novo_esquema | avisos | equipe');
  console.log('Operação concluída.');
} catch (erro) {
  console.error(erro.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
