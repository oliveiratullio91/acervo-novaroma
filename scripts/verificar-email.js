import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { carregarAmbiente } from '../banco.js';
import { criarTransporteSMTP } from '../correio.js';

carregarAmbiente();
const smtp = criarTransporteSMTP();
try {
  if (!smtp)
    throw new Error(
      'Configure GMAIL_USUARIO e GMAIL_SENHA_APP, ou as credenciais SMTP, no ambiente privado.'
    );
  await smtp.verify();
  console.log('Conexão SMTP e autenticação verificadas.');
  if (process.argv.includes('--salvar')) {
    const usuario = process.env.GMAIL_USUARIO?.trim(),
      senha = process.env.GMAIL_SENHA_APP?.replace(/\s/g, '');
    if (
      !/^[a-zA-Z0-9_.+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(usuario ?? '') ||
      !/^[a-zA-Z0-9]{16}$/.test(senha ?? '')
    )
      throw new Error('Confira o endereço do Gmail e a senha de app.');
    const arquivo = new URL('../.env', import.meta.url);
    const anterior = await readFile(arquivo, 'utf8').catch((erro) => {
      if (erro.code === 'ENOENT') return '';
      throw erro;
    });
    const quebra = anterior.includes('\r\n') ? '\r\n' : '\n';
    const texto = anterior.replace(
      /^[ \t]*(?:export\s+)?GMAIL_(?:USUARIO|SENHA_APP)[ \t]*=[^\r\n]*(?:\r?\n|$)/gm,
      ''
    );
    const novo =
      texto +
      (texto && !texto.endsWith('\n') ? quebra : '') +
      'GMAIL_USUARIO=' +
      usuario +
      quebra +
      'GMAIL_SENHA_APP=' +
      senha +
      quebra;
    const temporario = new URL('../.env.' + randomUUID() + '.tmp', import.meta.url);
    try {
      await writeFile(temporario, novo, { mode: 0o600, flag: 'wx' });
      await rename(temporario, arquivo);
    } finally {
      await rm(temporario, { force: true });
    }
    console.log('Credencial verificada e salva no .env privado.');
  }
  if (process.argv.includes('--enviar')) {
    const remetente = process.env.GMAIL_USUARIO?.trim();
    if (!remetente) throw new Error('O teste de entrega usa o próprio remetente Gmail.');
    const { accepted } = await smtp.sendMail({
      to: { address: remetente },
      subject: 'Confirmação de envio da Biblioteca Acervo',
      text: 'Esta mensagem confirma o teste de envio realizado pela biblioteca.'
    });
    if (!accepted?.length) throw new Error('O servidor não aceitou a mensagem.');
    console.log('O Gmail aceitou a mensagem de teste para a conta remetente.');
  }
} catch (erro) {
  const mensagem =
    erro.code === 'EAUTH'
      ? 'O provedor recusou a autenticação. Confira a conta e a senha de app.'
      : erro.code
        ? 'Não foi possível concluir a comunicação SMTP (' + erro.code + ').'
        : erro.message;
  console.error(mensagem);
  process.exitCode = 1;
} finally {
  smtp?.close();
}
