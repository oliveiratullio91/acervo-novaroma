import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { criarAplicacao } from '../servidor.js';
import { conectarBanco } from '../banco.js';
export const esquemaNovo = () => 'acervo_teste_' + randomUUID().replaceAll('-', '');
export async function abrirAmbiente(t, demonstracao = true, opcoes = {}) {
  const pool = conectarBanco(),
    esquema = esquemaNovo(),
    cartas = [];
  let servidor;
  await pool.query('CREATE SCHEMA ' + esquema);
  t.after(async () => {
    try {
      if (servidor) await new Promise(resolve => {
        servidor.close(resolve);
        servidor.closeAllConnections();
      });
      await pool.query('DROP SCHEMA ' + esquema + ' CASCADE');
    } finally {
      await pool.end();
    }
  });
  const app = await criarAplicacao({
    pool,
    esquema,
    demonstracao,
    enviar: async (carta) => {
      cartas.push(carta);
    },
    ...opcoes
  });
  servidor = app.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  const base = 'http://127.0.0.1:' + servidor.address().port;
  const requisitar = async (metodo, url, token, corpo) => {
    const resposta = await fetch(base + '/api' + url, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      body: JSON.stringify(corpo)
    });
    return { status: resposta.status, dados: await resposta.json().catch(() => null) };
  };
  return { pool, esquema, base, cartas, requisitar };
}
