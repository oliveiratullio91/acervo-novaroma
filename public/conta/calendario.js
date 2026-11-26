// Ano-mês-dia no calendário da biblioteca, independentemente do fuso do dispositivo.
const calendario = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' });

export function diaDaBiblioteca(instante = new Date()) {
  return calendario.format(instante);
}
