import nodemailer from 'nodemailer';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { falha } from './operacoes-banco.js';

export function criarTransporteSMTP(env = process.env) {
  const usuario = env.GMAIL_USUARIO?.trim();
  const senha = env.GMAIL_SENHA_APP?.replace(/\s/g, '');
  const limites = { connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000 };
  let opcoes, remetente;
  if (usuario || senha) {
    if (!usuario || !senha) return null;
    opcoes = {
      ...limites,
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: usuario, pass: senha }
    };
    remetente = { name: 'Biblioteca Acervo', address: usuario };
  } else if (env.SMTP_URL && env.ACERVO_REMETENTE) {
    opcoes = { ...limites, url: env.SMTP_URL };
    remetente = env.ACERVO_REMETENTE;
  } else return null;
  return nodemailer.createTransport(opcoes, { from: remetente });
}

export function transporteEmail(env = process.env) {
  const smtp = criarTransporteSMTP(env);
  return smtp ? ({ to, ...carta }) => smtp.sendMail({ ...carta, to: { address: to } }) : null;
}

export function origemBiblioteca(demonstracao, env = process.env) {
  const valor =
    env.ACERVO_ORIGEM ||
    (env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL
      ? 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL
      : null) ||
    (demonstracao && !env.VERCEL ? 'http://127.0.0.1:' + (env.PORT || '4176') : null);
  if (!valor) return null;
  try {
    const url = new URL(valor);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

const resumo = (valor) => createHash('sha256').update(valor).digest('hex');
export async function solicitarRecuperacao({ pool, s, email, enviar, origem }) {
  if (!enviar || !origem) falha(503, 'A recuperação por e-mail ainda não está configurada.');
  const token = randomBytes(32).toString('hex');
  const {
    rows: [registro]
  } = await pool.query(
    `INSERT INTO ${s}.recuperacao(conta_id,resumo,expira)
    SELECT id,$2,now()+interval '20 minutes' FROM ${s}.contas WHERE email=$1 AND id NOT IN ('L-104','B-208')
    ON CONFLICT(conta_id) DO UPDATE SET resumo=excluded.resumo,expira=excluded.expira WHERE recuperacao.expira<now()+interval '19 minutes' RETURNING conta_id`,
    [email, resumo(token)]
  );
  if (registro) {
    const link = new URL('/recuperar/', origem);
    link.hash = token;
    try {
      await enviar({
        to: email,
        subject: 'Redefinir a senha do Acervo',
        text: 'Use este link em até 20 minutos para escolher uma nova senha.\n' + link.href
      });
    } catch {
      await pool.query(`DELETE FROM ${s}.recuperacao WHERE resumo=$1`, [resumo(token)]);
      falha(503, 'O serviço de e-mail está indisponível.');
    }
  }
}
export async function redefinirSenha(pool, s, token, senha) {
  const hash = await bcrypt.hash(senha, 10);
  const { rowCount } = await pool.query(
    `WITH usado AS (DELETE FROM ${s}.recuperacao WHERE resumo=$1 AND expira>now() RETURNING conta_id)
    UPDATE ${s}.contas c SET senha_hash=$2,versao_sessao=versao_sessao+1 FROM usado WHERE c.id=usado.conta_id`,
    [resumo(token), hash]
  );
  if (!rowCount) falha(400, 'Este link expirou ou já foi utilizado.');
}
export async function enviarLembretes(pool, s, enviar, { reservas = null, origem = null } = {}) {
  if (!enviar) throw new Error('Configure o transporte de e-mail.');
  // As reservas e os empréstimos ativos são a fonte das pendências, inclusive após reiniciar o servidor.
  const candidatos = `WITH candidatos AS (
    SELECT r.conta_id,'reserva-'||r.id AS chave,'Reserva pronta para retirada' AS assunto,
      'Sua reserva de “'||l.titulo||'” está pronta. Retire o exemplar até '||
      to_char(r.retirada_ate AT TIME ZONE 'America/Fortaleza','DD/MM/YYYY às HH24:MI')||' (horário de Fortaleza).' AS texto,
      '/conta/reservas/' AS pagina
    FROM ${s}.reservas r JOIN ${s}.catalogo l ON l.id=r.livro_id
    WHERE r.retirada_ate>now() AND r.cancelada_em IS NULL AND r.retirada_em IS NULL
      AND ($1::bigint[] IS NULL OR r.id=ANY($1))
    UNION ALL
    SELECT conta_id, 'prazo-'||id||'-'||prazo_devolucao||'-'||(prazo_devolucao<hoje),
      CASE WHEN prazo_devolucao<hoje THEN 'Empréstimo em atraso' ELSE 'Prazo de devolução próximo' END,
      CASE WHEN prazo_devolucao<hoje THEN 'O prazo para devolver “'||titulo||'” terminou em '
           ELSE 'Devolva “'||titulo||'” até ' END || to_char(prazo_devolucao,'DD/MM/YYYY')||'.',
      '/conta/emprestimos/'
    FROM ${s}.emprestimos CROSS JOIN (SELECT (now() AT TIME ZONE 'America/Fortaleza')::date AS hoje) calendario
    WHERE $1::bigint[] IS NULL AND devolvido_em IS NULL AND prazo_devolucao<=hoje+2
  ) SELECT k.*,c.email,c.nome FROM candidatos k JOIN ${s}.contas c ON c.id=k.conta_id
    WHERE c.avisos_email`;
  const { rows } = await pool.query(
    `SELECT chave FROM (${candidatos}) elegiveis WHERE
    NOT EXISTS (SELECT 1 FROM ${s}.emails_enviados e WHERE e.chave=elegiveis.chave) ORDER BY chave`,
    [reservas]
  );
  let falhas = 0;
  let enviados = 0;
  for (const { chave } of rows) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const tomado = await c.query(
        `INSERT INTO ${s}.emails_enviados(chave) VALUES($1) ON CONFLICT DO NOTHING`,
        [chave]
      );
      if (!tomado.rowCount) {
        await c.query('COMMIT');
        continue;
      }
      const {
        rows: [carta]
      } = await c.query(`SELECT * FROM (${candidatos}) elegiveis WHERE chave=$2`, [reservas, chave]);
      if (!carta) {
        await c.query('ROLLBACK');
        continue;
      }
      const link = origem ? '\n\nAcompanhe na sua conta: ' + new URL(carta.pagina, origem).href : '';
      await enviar({
        to: carta.email,
        subject: carta.assunto,
        text: 'Olá, ' + carta.nome + '.\n\n' + carta.texto + link + '\n\nBiblioteca Acervo',
        messageId: '<' + resumo(s + chave) + '@avisos.acervo>'
      });
      await c.query('COMMIT');
      enviados++;
    } catch {
      await c.query('ROLLBACK');
      falhas++;
    } finally {
      c.release();
    }
  }
  if (falhas)
    throw new Error(`Falha no envio de ${falhas} aviso(s). As pendências serão tentadas novamente.`);
  return enviados;
}
