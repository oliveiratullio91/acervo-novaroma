import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { abrirAmbiente } from '../suporte-testes/biblioteca.js';
import { diaDaBiblioteca } from '../public/conta/calendario.js';

test('leitor no celular e equipe no desktop completam reserva, retirada, renovação e devolução', async (t) => {
  const { base, cartas, pool, esquema } = await abrirAmbiente(t);
  await pool.query(
    `UPDATE ${esquema}.emprestimos SET prazo_devolucao=$1::date - CASE WHEN livro_id='dom-casmurro' THEN 1 ELSE 0 END WHERE livro_id IN ('dom-casmurro','o-quinze')`,
    [diaDaBiblioteca()]
  );
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' && !existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {})
  });
  t.after(() => browser.close());
  const mobil = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'pt-BR',
    reducedMotion: 'reduce'
  });
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const leitor = await mobil.newPage(),
    equipe = await desktop.newPage();
  const erros = [];
  for (const p of [leitor, equipe]) {
    p.on('pageerror', (erro) => erros.push(erro.message));
    p.setDefaultTimeout(12000);
  }
  const abrir = (page, path) => page.goto(base + path);
  const entrar = async (page, email, senha) => {
    await abrir(page, '/entrar/');
    await page.locator('#email').fill(email);
    await page.locator('#senha').fill(senha);
    await page.locator('#senha').press('Enter');
    await page.waitForURL('**/conta/**');
  };
  const acessibilidade = async (page) => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    assert.deepEqual(
      violations.map((v) => [v.id, v.nodes.map((n) => n.target)]),
      []
    );
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'sem rolagem horizontal'
    );
  };
  await abrir(leitor, '/cadastro/');
  await leitor.locator('#nome').fill('Ana da Regressão');
  await leitor.locator('#email').fill('ana-navegador@acervo.test');
  await leitor.locator('#senha').fill('Leituras123');
  await leitor.locator('#confirmar-senha').fill('Leituras123');
  await leitor.locator('#confirmar-senha').press('Enter');
  await leitor.waitForURL('**/entrar/**');
  await entrar(leitor, 'ana-navegador@acervo.test', 'Leituras123');
  await abrir(leitor, '/catalogo/?livro=mensagem');
  await leitor.getByRole('button', { name: 'Quero ler', exact: true }).click();
  await leitor.getByText('Livro salvo em Quero ler.').waitFor();
  await leitor.locator('#reservar').press('Enter');
  await leitor.locator('#ver-reservas').waitFor();
  await leitor.locator('#ver-reservas').click();
  await leitor
    .locator('#avisos-leitor')
    .getByText(/Mensagem/)
    .waitFor();
  await entrar(equipe, 'equipe@acervo.test', 'Equipe!208');
  for (const [filtro, titulo] of [
    ['atrasado', 'Dom Casmurro'],
    ['hoje', 'O Quinze'],
    ['sem', 'Clara dos Anjos']
  ]) {
    await equipe.locator('#op-filtro').selectOption(filtro);
    await equipe.locator('#lista-circulacao li').getByText(titulo, { exact: true }).waitFor();
    assert.equal(await equipe.locator('#lista-circulacao li').count(), 1);
  }
  await equipe.getByRole('link', { name: 'Reservas para retirada' }).click();
  const reserva = equipe.locator('.op-linha').filter({ hasText: 'Ana da Regressão' });
  await reserva.getByRole('button', { name: 'Registrar retirada' }).click();
  await equipe.locator('#eventos-emprestimo li').first().waitFor();
  await equipe.keyboard.press('Escape');
  await equipe.getByRole('link', { name: 'Relatório de circulação' }).click();
  await equipe.locator('#op-busca').fill('Ana da Regressão');
  await equipe.getByRole('button', { name: /Renovar empréstimo de Mensagem/ }).click();
  await equipe.locator('#novo-prazo').fill(diaDaBiblioteca(new Date(Date.now() + 35 * 86400000)));
  await equipe.getByRole('button', { name: 'Salvar prazo' }).click();
  await equipe.locator('#estado-emprestimo').filter({ hasText: /até/ }).waitFor();
  await equipe.getByRole('button', { name: /Registrar devolução de Mensagem/ }).click();
  await equipe.locator('#vazio-circulacao').waitFor();
  await abrir(leitor, '/conta/historico/');
  await leitor.locator('#form-arquivo input[name=q]').fill('Mensagem');
  await leitor.getByRole('button', { name: 'Pesquisar histórico' }).press('Enter');
  await leitor.locator('#op-arquivo').getByRole('button', { name: 'Linha do tempo' }).first().click();
  await leitor.locator('#eventos-emprestimo li').nth(2).waitFor();
  assert.deepEqual(await leitor.locator('#eventos-emprestimo li>strong').allTextContents(), [
    'Retirada',
    'Renovação',
    'Devolução'
  ]);
  await leitor.keyboard.press('Escape');
  await abrir(leitor, '/conta/carteira/');
  await leitor.locator('#barras-carteira rect').first().waitFor({ state: 'attached' });
  await leitor.locator('#dados-conta').waitFor();
  await acessibilidade(leitor);
  const foto = await leitor.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 12;
    return c.toDataURL('image/png').split(',')[1];
  });
  await leitor
    .locator('#form-foto input')
    .setInputFiles({ name: 'perfil.png', mimeType: 'image/png', buffer: Buffer.from(foto, 'base64') });
  await leitor.getByRole('button', { name: 'Salvar foto' }).click();
  await leitor.locator('#identidade-conta [data-avatar] img').waitFor();
  await abrir(leitor, '/catalogo/');
  await leitor.locator('#atalho-conta [data-avatar] img').waitFor();
  await abrir(equipe, '/conta/balcao/');
  await equipe.locator('#dados-conta').waitFor();
  await acessibilidade(equipe);
  await abrir(leitor, '/conta/estante/');
  await leitor.locator('#op-lista').getByText('Mensagem', { exact: true }).waitFor();
  await abrir(leitor, '/conta/carteira/');
  await leitor.locator('#id-carteira').filter({ hasText: /\S/ }).waitFor();
  const codigo = await leitor.locator('#id-carteira').textContent();

  await abrir(equipe, '/conta/acervo/');
  await equipe.locator('#editor-livro summary').click();
  const form = equipe.locator('#form-livro');
  await form.getByLabel('Título', { exact: true }).fill('Atlas do Campus');
  await form.getByLabel('Autor', { exact: true }).fill('Rita Mendes');
  await form.getByLabel('Categoria', { exact: true }).fill('Geografia');
  await form.getByRole('button', { name: 'Salvar edição' }).click();
  await equipe.locator('#estado-operacoes').filter({ hasText: 'Edição salva' }).waitFor();
  await abrir(equipe, '/conta/inventario/');
  await equipe.locator('#editor-copia summary').click();
  await equipe.locator('#form-copia select[name=livroId]').selectOption({ label: 'Atlas do Campus' });
  await equipe.locator('#form-copia input[name=localizacao]').fill('Campus · Estante 1');
  await equipe.getByRole('button', { name: 'Salvar exemplar' }).click();
  await equipe
    .locator('#estado-operacoes')
    .filter({ hasText: /Exemplar AC-\d+ salvo/ })
    .waitFor();
  const tombo = (await equipe.locator('#estado-operacoes').textContent()).match(/AC-\d+/)[0];
  await equipe.locator('#op-busca').fill(tombo);
  await equipe.getByRole('button', { name: 'Etiqueta', exact: true }).click();
  await equipe.getByRole('dialog').getByRole('button', { name: 'Fechar' }).press('Enter');
  await equipe.locator('#form-conferir input').fill(tombo);
  await equipe.getByRole('button', { name: 'Confirmar conferência' }).click();
  await equipe.locator('#estado-operacoes').filter({ hasText: 'Conferência registrada' }).waitFor();
  await abrir(equipe, '/conta/balcao/');
  await equipe.locator('#form-retirada input[name=leitor]').fill(codigo);
  await equipe.locator('#form-retirada input[name=tombo]').fill(tombo);
  await equipe.getByRole('button', { name: 'Registrar empréstimo', exact: true }).click();
  await equipe.locator('#op-recibo').getByText('Atlas do Campus').waitFor();
  await equipe.locator('#form-entrega input').fill(tombo);
  await equipe.getByRole('button', { name: 'Receber exemplar' }).press('Enter');
  await equipe.locator('#estado-operacoes').filter({ hasText: 'Devolução registrada' }).waitFor();
  await abrir(equipe, '/conta/indicadores/');
  await equipe
    .locator('#op-lista .op-linha')
    .filter({ hasText: 'Atlas do Campus' })
    .getByText(/1 empréstimo/)
    .waitFor();

  await abrir(leitor, '/recuperar/');
  await leitor.locator('#email').fill('ana-navegador@acervo.test');
  await leitor.getByRole('button', { name: 'Solicitar link' }).press('Enter');
  await leitor.locator('#estado').filter({ hasText: 'receberá o link' }).waitFor();
  const token = cartas.at(-1).text.split('#').at(-1);
  await abrir(leitor, '/recuperar/#' + token);
  await leitor.locator('#senha').fill('NovaLeitura123');
  await leitor.getByRole('button', { name: 'Salvar nova senha' }).click();
  await leitor.waitForURL('**/entrar/**');
  await entrar(leitor, 'ana-navegador@acervo.test', 'NovaLeitura123');
  assert.deepEqual(erros, []);
});
