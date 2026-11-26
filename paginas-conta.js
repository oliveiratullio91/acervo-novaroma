import { readFileSync } from 'node:fs';

const telas = {
  circulacao: { titulo: 'Relatório de circulação', icone: 'icone-circulacao', equipe: true },
  leitores: { titulo: 'Leitores', icone: 'icone-pessoa', equipe: true },
  acervo: {titulo:'Gestão do acervo',icone:'icone-livro',equipe:true},
  retiradas: {titulo:'Reservas para retirada',icone:'icone-livro',equipe:true},
  balcao: {titulo:'Balcão de atendimento',icone:'icone-livro',equipe:true},
  inventario: {titulo:'Inventário físico',icone:'icone-livro',equipe:true},
  indicadores: {titulo:'Indicadores de circulação',icone:'icone-livro',equipe:true},
  reservas: { titulo: 'Reservas', icone: 'icone-reserva', contagem: true },
  emprestimos: { titulo: 'Empréstimos', icone: 'icone-livro', contagem: true },
  historico: { titulo: 'Histórico', icone: 'icone-historico' },
  estante: {titulo:'Minha estante',icone:'icone-pessoa'},
  carteira: {titulo:'Carteirinha digital',icone:'icone-pessoa'},
  perfil: { titulo: 'Perfil e segurança', icone: 'icone-seguranca' },
  leitor: { titulo: 'Ficha do leitor', equipe: true, ficha: true }
};

function lerModelo(nome) {
  return readFileSync(new URL(`./telas/conta/${nome}.html`, import.meta.url), 'utf8');
}

const base = lerModelo('base');
const dialogoPrazo = lerModelo('dialogo-prazo');
const conteudos = new Map(Object.keys(telas).map(nome => [nome, lerModelo(nome)]));
const itensDoMenu = Object.entries(telas).filter(([, item]) => !item.ficha);

export const telaDaEquipe = tela => Boolean(telas[tela]?.equipe);

export function paginaDaConta(tela, equipe, secaoFicha) {
  const links = itensDoMenu.filter(([nome]) => equipe || !telaDaEquipe(nome));
  const menu = links.map(([nome, { titulo, icone, contagem }]) => {
    let atual = nome === tela ? ' aria-current="page"' : '';
    if (tela === 'leitor' && nome === secaoFicha) atual = ' aria-current="location"';
    const contador = contagem ? `<span class="conta-contagem" id="total-${nome}" hidden></span>` : '';
    let grupo = '';
    if (equipe && nome === 'circulacao') grupo = '<p class="conta-menu-grupo">Biblioteca</p>';
    if (equipe && nome === 'reservas') grupo = '<p class="conta-menu-grupo">Minha conta</p>';
    return `${grupo}<a href="/conta/${nome}/"${atual}><i class="${icone}" aria-hidden="true"></i><span>${titulo}</span>${contador}</a>`;
  }).join('\n');
  const valores = { tela, titulo: telas[tela].titulo, menu, conteudo: conteudos.get(tela),
    dialogoPrazo: ['leitor', 'circulacao'].includes(tela) ? dialogoPrazo : '',
    area: telaDaEquipe(tela) ? 'Área da equipe' : 'Minha conta' };
  return base.replace(/\{\{(\w+)\}\}/g, (_, chave) => valores[chave]);
}

export const rotasDaConta = itensDoMenu.map(([nome]) => '/conta/' + nome + '/');
