import { solicitarApi as api } from '/api.js';
import { abrirDetalheEmprestimo } from './conta.js';
import { diaDaBiblioteca } from './calendario.js';
import { preencherIdentidade } from '/identidade-visual.js';

const el = (id) => document.getElementById(id);
const cod = encodeURIComponent;
const dataHora = (valor) =>
  valor ? new Date(valor).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) : 'Data não registrada';
const hojeMais = (dias) => diaDaBiblioteca(new Date(Date.now() + dias * 86400000));
const mudar = (url, metodo, corpo) => api(url, { metodo, corpo });
const tela = document.body.dataset.tela;

function aviso(texto, erro = false) {
  const alvo = el('estado-operacoes');
  alvo.hidden = !texto;
  alvo.classList.toggle('aviso-erro', erro);
  alvo.textContent = texto;
}
async function executar(acao, controle) {
  if (controle?.disabled) return;
  if (controle) controle.disabled = true;
  try {
    await acao();
  } catch (erro) {
    if (erro.status === 401) location.assign('/entrar/?tela=' + cod(tela));
    else aviso(erro.message, true);
  } finally {
    if (controle) controle.disabled = false;
  }
}
function formulario(id, acao) {
  const form = el(id);
  form.addEventListener('submit', (evento) => {
    evento.preventDefault();
    executar(() => acao(Object.fromEntries(new FormData(form)), form), evento.submitter);
  });
}
function botao(rotulo, acao) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'botao botao-secundario';
  b.textContent = rotulo;
  b.addEventListener('click', () => executar(acao, b));
  return b;
}
function link(rotulo, href) {
  const a = document.createElement('a');
  a.className = 'botao botao-secundario';
  a.href = href;
  a.textContent = rotulo;
  return a;
}
function linha(titulo, detalhe, ...acoes) {
  const item = document.createElement('div'),
    info = document.createElement('div');
  const nome = document.createElement('strong'),
    sub = document.createElement('small');
  nome.textContent = titulo;
  sub.textContent = detalhe;
  info.append(nome, sub);
  item.className = 'op-linha';
  item.append(info);
  if (acoes.length) {
    const grupo = document.createElement('div');
    grupo.className = 'op-acoes';
    grupo.append(...acoes);
    item.append(grupo);
  }
  return item;
}
function listar(id, itens, vazio = 'Nenhum registro encontrado.') {
  const alvo = el(id);
  alvo.replaceChildren(...itens);
  if (!itens.length) alvo.textContent = vazio;
}
function normalizar(v) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR');
}
function corresponde(...valores) {
  const termo = normalizar(el('op-busca').value.trim());
  return valores.some((v) => normalizar(v).includes(termo));
}
function preencher(form, registro) {
  for (const [k, v] of Object.entries(registro)) {
    const campo = form.elements.namedItem(k);
    if (campo?.type === 'checkbox') campo.checked = Boolean(v);
    else if (campo) campo.value = v ?? '';
  }
}
function editar(editor, form, registro, campo) {
  el(editor).open = true;
  preencher(el(form), registro);
  el(form).elements.namedItem(campo).focus();
}
function barras(svg, valor) {
  window.JsBarcode(svg, valor, { format: 'CODE128', width: 2, height: 44, displayValue: false, margin: 10 });
  svg.setAttribute(
    'viewBox',
    '0 0 ' + parseInt(svg.getAttribute('width')) + ' ' + parseInt(svg.getAttribute('height'))
  );
}
function etiqueta(tombo) {
  const dialog = document.createElement('dialog'),
    titulo = document.createElement('h2');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'etiqueta-tombo';
  titulo.textContent = tombo;
  dialog.setAttribute('aria-label', 'Etiqueta ' + tombo);
  dialog.append(
    titulo,
    svg,
    botao('Imprimir etiqueta', () => window.print()),
    botao('Fechar', () => dialog.close())
  );
  document.body.append(dialog);
  barras(svg, tombo);
  dialog.onclose = () => dialog.remove();
  dialog.showModal();
}
async function gestao() {
  const url = '/equipe/livros';
  let livros = [];
  function exibir() {
    listar(
      'op-lista',
      livros
        .filter((l) => corresponde(l.titulo, l.edicao, l.autor))
        .map((l) =>
          linha(
            l.titulo,
            [l.autor, l.edicao, l.arquivado ? 'Arquivado' : 'No catálogo'].filter(Boolean).join(' · '),
            botao('Editar', () =>
              editar(
                'editor-livro',
                'form-livro',
                { ...l, capa: /^https:/i.test(l.capa) ? l.capa : '' },
                'titulo'
              )
            ),
            botao(l.arquivado ? 'Reativar' : 'Arquivar', async () => {
              await mudar(url + '/' + cod(l.id) + '/arquivo', 'PATCH', { arquivado: !l.arquivado });
              await carregar();
              aviso(l.arquivado ? 'Edição reativada.' : 'Edição arquivada.');
            })
          )
        )
    );
  }
  async function carregar() {
    livros = await api(url);
    exibir();
  }
  el('op-busca').addEventListener('input', exibir);
  formulario('form-livro', async ({ id, ...dados }, f) => {
    await mudar(url + (id ? '/' + cod(id) : ''), id ? 'PUT' : 'POST', dados);
    f.reset();
    await carregar();
    aviso('Edição salva. Cadastre as cópias em Inventário físico.');
  });
  await carregar();
}
async function inventario() {
  const url = '/equipe/exemplares';
  let copias = [];
  const edicoes = await api('/equipe/livros');
  const form = el('form-copia');
  form.elements.livroId.replaceChildren(
    ...edicoes
      .filter((l) => !l.arquivado)
      .map((l) => new Option([l.titulo, l.edicao].filter(Boolean).join(' · '), l.id))
  );
  const estados = {
    regular: 'Regular',
    extraviado: 'Extraviado',
    manutencao: 'Em manutenção',
    arquivado: 'Arquivado',
    emprestado: 'Emprestado'
  };
  function exibir() {
    const filtradas = copias.filter((c) => corresponde(c.titulo, c.tombo, c.localizacao, c.leitor));
    listar(
      'op-lista',
      filtradas.map((c) => {
        const acoes = [
          botao('Etiqueta', () => etiqueta(c.tombo)),
          botao('Conferir', () => conferir(c.tombo))
        ];
        if (c.situacao !== 'arquivado')
          acoes.push(botao('Editar', () => editar('editor-copia', 'form-copia', c, 'localizacao')));
        if (c.leitorId) acoes.push(link(c.leitor, '/conta/leitores/' + cod(c.leitorId) + '/'));
        return linha(
          c.tombo + ' · ' + c.titulo,
          [
            c.edicao,
            c.localizacao,
            estados[c.situacao],
            c.conferidoEm ? 'Conferido em ' + dataHora(c.conferidoEm) : 'Conferência pendente'
          ]
            .filter(Boolean)
            .join(' · '),
          ...acoes
        );
      })
    );
  }
  async function carregar() {
    copias = await api(url);
    exibir();
  }
  async function conferir(valor) {
    const tombo = valor.trim().toUpperCase();
    await mudar(url + '/' + cod(tombo) + '/conferencia', 'POST');
    await carregar();
    aviso('Conferência registrada para ' + tombo + '.');
  }
  el('op-busca').oninput = exibir;
  formulario('form-conferir', async (d, f) => {
    await conferir(d.tombo);
    f.reset();
    f.elements.tombo.focus();
  });
  formulario('form-copia', async ({ tombo, ...dados }, f) => {
    const registro = await mudar(url + (tombo ? '/' + cod(tombo) : ''), tombo ? 'PUT' : 'POST', dados);
    f.reset();
    await carregar();
    aviso('Exemplar ' + registro.tombo + ' salvo.');
  });
  await carregar();
}
async function prazoPadrao() {
  const regras = await api('/conta/regras'),
    campo = el('prazo-balcao') ?? el('prazo-devolucao');
  campo.min = hojeMais(0);
  if (!campo.value) campo.value = hojeMais(regras.dias);
  return regras;
}
const emprestimos = (leitor) => '/conta/leitores/' + cod(leitor.trim()) + '/emprestimos';
async function retiradas() {
  let reservas = [];
  await prazoPadrao();
  async function carregar() {
    reservas = await api('/equipe/reservas');
    exibir();
  }
  function exibir() {
    const hoje = hojeMais(0);
    listar(
      'op-lista',
      reservas
        .filter(
          (r) =>
            corresponde(r.titulo, r.leitor, r.id) &&
            (!el('filtro-retiradas').value || diaDaBiblioteca(new Date(r.retirarAte)) === hoje)
        )
        .map((r) =>
          linha(
            r.titulo,
            r.leitor + ' · Reserva nº ' + r.id + ' · Retirar até ' + dataHora(r.retirarAte),
            link('Ficha', '/conta/leitores/' + cod(r.leitorId) + '/'),
            botao('Registrar retirada', async () => {
              const data = el('prazo-balcao');
              if (!data.reportValidity()) return;
              const { emprestimo } = await mudar(emprestimos(r.leitorId), 'POST', {
                livroId: r.livroId,
                reservaId: r.id,
                prazoDevolucao: data.value
              });
              await carregar();
              aviso('Retirada registrada no empréstimo nº ' + emprestimo.id + '.');
              await abrirDetalheEmprestimo(r, emprestimo.id, cod(r.leitorId));
            })
          )
        ),
      'Nenhuma reserva pendente para esta consulta.'
    );
  }
  el('op-busca').oninput = exibir;
  el('filtro-retiradas').onchange = exibir;
  await carregar();
}
async function balcao() {
  preencher(el('form-regras'), await prazoPadrao());
  async function localizar(tombo) {
    const copias = await api('/equipe/exemplares');
    const copia = copias.find((c) => c.tombo === tombo.trim().toUpperCase());
    if (!copia) throw Error('Tombo não encontrado no inventário.');
    return copia;
  }
  function recibo(c, id, leitor) {
    el('op-recibo').replaceChildren(
      linha(
        c.titulo,
        c.tombo + ' · Empréstimo nº ' + id,
        botao('Ver comprovante', () => abrirDetalheEmprestimo(c, id, cod(leitor)))
      )
    );
  }
  formulario('form-retirada', async (d, f) => {
    const c = await localizar(d.tombo);
    const { emprestimo } = await mudar(emprestimos(d.leitor), 'POST', {
      tombo: c.tombo,
      livroId: c.livroId,
      prazoDevolucao: d.prazoDevolucao
    });
    recibo(c, emprestimo.id, d.leitor.trim());
    f.elements.tombo.value = '';
    aviso('Empréstimo nº ' + emprestimo.id + ' registrado.');
  });
  formulario('form-entrega', async (d, f) => {
    const c = await localizar(d.tombo);
    if (!c.emprestimoId) throw Error('Este exemplar não tem empréstimo ativo.');
    await mudar(emprestimos(c.leitorId) + '/' + cod(c.emprestimoId) + '/devolucao', 'PUT');
    f.reset();
    recibo(c, c.emprestimoId, c.leitorId);
    aviso('Devolução registrada para ' + c.tombo + '.');
  });
  formulario('form-correcao', async (d, f) => {
    await mudar(
      '/equipe/leitores/' + cod(d.leitor.trim()) + '/emprestimos/' + cod(d.id) + '/correcao',
      'POST',
      { motivo: d.motivo }
    );
    f.reset();
    aviso('Empréstimo reaberto. A justificativa consta na linha do tempo.');
  });
  formulario('form-regras', async (d) => {
    await mudar('/equipe/regras', 'PUT', {
      dias: Number(d.dias),
      limite: Number(d.limite),
      renovacoes: Number(d.renovacoes),
      respeitar_fila: Boolean(d.respeitar_fila)
    });
    el('prazo-balcao').value = hojeMais(Number(d.dias));
    aviso('Regras de empréstimo atualizadas.');
  });
}
async function indicadores() {
  const f = el('form-indicadores');
  preencher(f, { de: hojeMais(-29), ate: hojeMais(0) });
  f.elements.de.required = f.elements.ate.required = true;
  async function carregar(d) {
    const dados = await api('/equipe/indicadores?' + new URLSearchParams(d));
    el('op-emprestimos').textContent = dados.reduce((s, l) => s + l.retiradas, 0);
    el('op-esperas').textContent = dados.reduce((s, l) => s + l.pedidos, 0);
    listar(
      'op-lista',
      dados.map((l) =>
        linha(
          [l.titulo, l.edicao].filter(Boolean).join(' · '),
          l.retiradas +
            ' empréstimo(s) · ' +
            l.pedidos +
            ' entrada(s) na fila · Espera média: ' +
            (l.esperaDias == null ? 'sem retirada no período' : l.esperaDias + ' dia(s)') +
            ' · Hoje: ' +
            l.aguardando +
            ' na fila, ' +
            l.indisponiveis +
            ' em manutenção ou extraviado(s).'
        )
      )
    );
  }
  formulario('form-indicadores', carregar);
  await carregar(Object.fromEntries(new FormData(f)));
}
async function estante() {
  const [favoritos, fila] = await Promise.all([api('/conta/estante'), api('/conta/fila')]);
  const remover = (tipo, id, msg) => async () => {
    await mudar('/conta/' + tipo + '/' + cod(id), 'DELETE');
    await estante();
    aviso(msg);
  };
  listar(
    'op-lista',
    favoritos.map((l) =>
      linha(
        l.titulo,
        l.arquivado ? 'Edição arquivada' : l.disponiveis + ' disponível(is)',
        ...(l.arquivado ? [] : [link('Ver livro', '/catalogo/?livro=' + cod(l.id))]),
        botao('Remover', remover('estante', l.id, 'Livro removido.'))
      )
    ),
    'Guarde livros com o botão Quero ler no catálogo.'
  );
  listar(
    'op-fila',
    fila.map((f) =>
      linha(
        f.titulo,
        'Posição ' + f.posicao,
        botao('Sair da fila', remover('fila', f.livroId, 'Você saiu da fila.'))
      )
    ),
    'Você não está em nenhuma fila.'
  );
}
async function carteira() {
  const c = await api('/conta/carteira');
  el('nome-carteira').textContent = c.nome;
  el('id-carteira').textContent = c.id;
  barras(el('barras-carteira'), c.id);
  el('form-avisos').elements.ativar.checked = c.avisos_email;
  if (['B-208', 'L-104'].includes(c.id)) {
    el('form-avisos').closest('section').hidden = true;
    return;
  }
  formulario('form-avisos', async (d) => {
    await mudar('/conta/avisos-email', 'PATCH', { ativar: Boolean(d.ativar) });
    aviso('Preferência de e-mail salva.');
  });
  async function salvarFoto(foto) {
    await mudar('/conta/foto', 'PUT', { foto });
    preencherIdentidade(el('identidade-conta'), c.nome, foto);
    aviso('Foto de perfil atualizada.');
  }
  el('remover-foto').onclick = () => executar(() => salvarFoto(null), el('remover-foto'));
  formulario('form-foto', async (_, f) => {
    const arquivo = f.elements.arquivo.files[0];
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(arquivo.type) || arquivo.size > 12 * 1024 * 1024)
      throw Error('Escolha uma foto JPEG, PNG ou WebP de até 12 MB.');
    const imagem = await createImageBitmap(arquivo);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 180;
      const lado = Math.min(imagem.width, imagem.height),
        ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 180, 180);
      ctx.drawImage(
        imagem,
        (imagem.width - lado) / 2,
        (imagem.height - lado) / 2,
        lado,
        lado,
        0,
        0,
        180,
        180
      );
      await salvarFoto(canvas.toDataURL('image/jpeg', 0.8));
      f.reset();
    } finally {
      imagem.close();
    }
  });
}
async function arquivo() {
  let pagina = 1,
    consulta = 0,
    filtros = {};
  const rotulos = {
    devolucao: 'Devolução',
    renovacao: 'Renovação',
    retirada: 'Reserva retirada',
    cancelada: 'Reserva cancelada',
    expirada: 'Reserva expirada',
    emprestimo: 'Empréstimo',
    correcao: 'Correção'
  };
  async function carregar() {
    const atual = ++consulta;
    const dados = await api('/conta/arquivo?' + new URLSearchParams({ ...filtros, pagina }));
    if (atual !== consulta) return;
    listar(
      'op-arquivo',
      dados.itens.map((i) =>
        linha(
          i.titulo,
          rotulos[i.tipo] + ' · ' + dataHora(i.data),
          ...(i.emprestimoId
            ? [botao('Linha do tempo', () => abrirDetalheEmprestimo(i, i.emprestimoId))]
            : [])
        )
      )
    );
    el('op-anterior').disabled = pagina === 1;
    el('op-proxima').disabled = !dados.mais;
    el('op-pagina').textContent = 'Página ' + pagina;
  }
  formulario('form-arquivo', async (d) => {
    filtros = d;
    pagina = 1;
    await carregar();
  });
  el('op-anterior').onclick = () =>
    executar(async () => {
      pagina--;
      await carregar();
    });
  el('op-proxima').onclick = () =>
    executar(async () => {
      pagina++;
      await carregar();
    });
  await carregar();
}
const iniciar = {
  acervo: gestao,
  inventario,
  retiradas,
  balcao,
  indicadores,
  estante,
  carteira,
  historico: arquivo,
  leitor: prazoPadrao
}[tela];
if (iniciar) executar(iniciar);
