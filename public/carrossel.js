const intervaloEntreLivros = 5000;

export function configurarCarrossel(faixa, dialogo) {
  const controles = document.getElementById('carrossel-controles');
  const posicao = document.getElementById('destaques-posicao');
  const movimentoReduzido = matchMedia('(prefers-reduced-motion: reduce)');
  let visivel = false;
  let ponteiroSobreLivros = false;
  let tocando = false;
  let temporizador;

  function podeAvancar() {
    return !movimentoReduzido.matches && visivel && !controles.hidden && !document.hidden && !dialogo.open
      && !tocando && !ponteiroSobreLivros && !faixa.matches(':focus-visible, :has(:focus-visible)');
  }

  function agendar() {
    clearTimeout(temporizador);
    if (podeAvancar()) {
      temporizador = setTimeout(() => {
        if (podeAvancar()) mover(1);
      }, intervaloEntreLivros);
    }
  }

  function mover(sentido) {
    const [primeiro, segundo] = faixa.children;
    if (!segundo) return;
    const passo = segundo.offsetLeft - primeiro.offsetLeft;
    const limite = faixa.scrollWidth - faixa.clientWidth;
    const voltarAoInicio = sentido > 0 && faixa.scrollLeft >= limite - 1;
    const irAoFinal = sentido < 0 && faixa.scrollLeft <= 1;
    let destino = faixa.scrollLeft + sentido * passo;
    if (voltarAoInicio) destino = 0;
    if (irAoFinal) destino = limite;
    const animar = !movimentoReduzido.matches && !voltarAoInicio && !irAoFinal;
    faixa.scrollTo({ left: destino, behavior: animar ? 'smooth' : 'instant' });
    agendar();
  }

  function atualizar() {
    const total = faixa.children.length;
    controles.hidden = total < 2 || faixa.scrollWidth <= faixa.clientWidth + 1;
    faixa.tabIndex = controles.hidden ? -1 : 0;
    if (!controles.hidden) {
      const caixa = faixa.getBoundingClientRect();
      const visiveis = [...faixa.children].filter(cartao => {
        const livro = cartao.getBoundingClientRect();
        const centro = livro.left + livro.width / 2;
        return centro >= caixa.left && centro <= caixa.right;
      });
      const primeiro = [...faixa.children].indexOf(visiveis[0]) + 1;
      const ultimo = primeiro + visiveis.length - 1;
      posicao.textContent = (primeiro === ultimo ? primeiro : primeiro + '–' + ultimo) + ' de ' + total;
      controles.style.setProperty('--inicio-trilho', (100 * faixa.scrollLeft / faixa.scrollWidth) + '%');
      controles.style.setProperty('--parte-visivel', (100 * faixa.clientWidth / faixa.scrollWidth) + '%');
    }
    agendar();
  }

  document.getElementById('destaque-anterior').addEventListener('click', () => mover(-1));
  document.getElementById('destaque-proximo').addEventListener('click', () => mover(1));
  faixa.addEventListener('scroll', atualizar, { passive: true });
  faixa.addEventListener('pointerenter', evento => {
    ponteiroSobreLivros = evento.pointerType === 'mouse' || evento.pointerType === 'pen';
    agendar();
  });
  faixa.addEventListener('pointerleave', () => {
    ponteiroSobreLivros = false;
    agendar();
  });
  faixa.addEventListener('pointerdown', () => {
    tocando = true;
    agendar();
  });
  function soltar() {
    if (!tocando) return;
    tocando = false;
    agendar();
  }
  window.addEventListener('pointerup', soltar);
  window.addEventListener('pointercancel', soltar);
  faixa.addEventListener('focusin', agendar);
  faixa.addEventListener('focusout', () => queueMicrotask(agendar));
  dialogo.addEventListener('close', agendar);
  document.addEventListener('visibilitychange', agendar);
  movimentoReduzido.addEventListener('change', agendar);
  new ResizeObserver(atualizar).observe(faixa);
  new IntersectionObserver(([entrada]) => {
    visivel = entrada.intersectionRatio >= 0.1;
    agendar();
  }, { threshold: [0, 0.1] }).observe(faixa);
  return atualizar;
}
