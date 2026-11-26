import { solicitarApi } from '/api.js';
const el = (id) => document.getElementById(id);
let token;
function lerLink() {
  if (!location.hash) return;
  token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  el('titulo').textContent = 'Escolher nova senha';
  el('email-recuperacao').hidden = true;
  el('trocar').hidden = false;
}
lerLink();
window.addEventListener('hashchange', lerLink);
for (const form of document.forms)
  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const botao = form.querySelector('button');
    if (botao.disabled) return;
    botao.disabled = true;
    const estado = el('estado');
    try {
      if (form.id === 'trocar') {
        await solicitarApi('/redefinir', { metodo: 'POST', corpo: { token, senha: el('senha').value } });
        location.replace('/entrar/?senha=alterada');
      } else {
        await solicitarApi('/recuperar', { metodo: 'POST', corpo: { email: el('email').value } });
        estado.textContent = 'Se houver uma conta com esse e-mail, você receberá o link de recuperação.';
      }
    } catch (erro) {
      estado.textContent = erro.message;
    } finally {
      botao.disabled = false;
      estado.hidden = false;
    }
  });
