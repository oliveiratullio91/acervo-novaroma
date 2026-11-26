export async function solicitarApi(caminho, { metodo = 'GET', corpo } = {}) {
  let resposta;
  try {
    resposta = await fetch('/api' + caminho, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json' } : {},
      body: JSON.stringify(corpo)
    });
  } catch {
    throw new Error('Não foi possível conectar à biblioteca. Tente novamente.');
  }
  if (resposta.status === 204) return null;
  const dados = await resposta.json().catch(() => null);
  if (resposta.ok && dados) return dados;
  const erro = new Error(dados?.mensagem ?? 'A biblioteca está temporariamente indisponível. Tente novamente.');
  erro.status = resposta.status;
  throw erro;
}
