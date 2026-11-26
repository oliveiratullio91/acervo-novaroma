# Acervo · Seminário Fullstack U2A1

**Tassiana Oliveira e Tullio Oliveira**

Tema 01 — Autenticação e autorização com JWT e bcrypt.

## Abrir a demonstração

[Abrir o Acervo online](https://acervo-novaroma.vercel.app). A publicação usa a Vercel da Nova Roma e o PostgreSQL do Neon.

### Executar o servidor a partir do código

Com Node.js 22 ou superior, abra o terminal nesta pasta. Na primeira execução, instale as dependências com `npm ci`. O servidor lê a conexão PostgreSQL de `DATABASE_URL` no ambiente ou do arquivo privado `.env` desta pasta. Em outro computador, configure essa variável no servidor com a conexão TLS do banco do Acervo. Execute `npm start` e abra [o Acervo no navegador](http://127.0.0.1:4176). No PowerShell, use `npm.cmd` se o Windows bloquear o script `npm.ps1`.

O front-end usa HTML, CSS e JavaScript. O Express serve o site e a API. A página inicial mostra um carrossel de destaques e encaminha as buscas para **Catálogo** em `/catalogo/`. Lá, o leitor encontra todos os livros, busca por título ou autor, filtra por categoria ou disponibilidade e reserva exemplares por 48 horas. A página **Criar conta** em `/cadastro/` cadastra leitores e encaminha para **Entrar** em `/entrar/`. Em **Minha conta**, o leitor acompanha empréstimos, consulta o histórico, cancela reservas e edita o nome ou a senha. O PostgreSQL do Neon armazena as contas, os hashes de senha, o catálogo, os empréstimos e as reservas. No modo de demonstração, a primeira execução inclui contas fictícias, três empréstimos e 16 títulos.

### Swagger e autenticação da API

Após o login, o leitor entra em **Reservas** e a bibliotecária em **Relatório de circulação**. Cada seção da conta tem endereço próprio. Em `/conta/circulacao/`, a equipe vê os totais e a lista de empréstimos ativos, com número do empréstimo, título, autor, nome e identificação do leitor. O botão **Atualizar relatório** consulta novamente o banco.

No relatório, cada empréstimo mostra o prazo e as ações **Renovar empréstimo** e **Registrar devolução**. Para os exemplares antigos sem vencimento, use **Definir prazo**. A devolução retira o empréstimo da lista e atualiza os totais. Clique no empréstimo para abrir sua linha do tempo ou no nome do leitor para abrir a ficha. A rota da ficha é `GET /api/conta/leitores/{id}`, na seção **Equipe** do Swagger.

Na tela **Leitores** (`/conta/leitores/`), a equipe pesquisa por nome ou sobrenome em todos os cadastros de leitor, incluindo quem nunca fez um empréstimo. Ao voltar da ficha, a lista conserva a busca e a página. A API oferece a mesma consulta em `GET /api/conta/leitores`, com os parâmetros opcionais `nome` e `pagina`.

Na ficha, abra **Empréstimos ativos**, selecione o título, informe a data em **Devolver até** e clique em **Registrar empréstimo**. Se o leitor já reservou o livro, a retirada utiliza o exemplar reservado. O prazo inclui o dia escolhido, pelo horário de Fortaleza. A partir do dia seguinte, a ficha e a conta do leitor indicam quantos dias o livro está atrasado.

Cada empréstimo ativo tem uma ação de prazo. **Renovar empréstimo** prorroga a devolução para uma data posterior à atual, inclusive quando o livro está atrasado. **Definir prazo** permite escolher a primeira data para empréstimos antigos. A equipe pode escolher hoje ou uma data futura. A conta do leitor exibe o novo vencimento. Ao receber o exemplar, clique em **Registrar devolução**. A devolução encerra o aviso de atraso, atualiza a disponibilidade e fica registrada em **Livros devolvidos**.

Em **Empréstimos ativos** na ficha e **Empréstimos** na conta do leitor, cada livro mostra quem registrou a retirada. Após a devolução, **Livros devolvidos** identifica também quem recebeu o exemplar. Para movimentos antigos, a biblioteca usa o nome cadastrado da pessoa identificada no registro, quando disponível.

Clique no empréstimo ou em **Ver linha do tempo** para consultar a retirada, cada renovação e a devolução, com data, hora e responsável. A ficha e a conta do leitor permitem abrir o detalhe pelos empréstimos ativos, pelos livros devolvidos e pelo histórico de renovações. Cada retirada do mesmo título tem um número próprio.

Em **Histórico de renovações**, a equipe e o leitor podem consultar o livro, a data e a hora da renovação, quem a registrou, o prazo anterior e o novo prazo. A seção fica na ficha do leitor e em **Minha conta → Histórico**. Cada registro preserva o nome usado pela pessoa da equipe naquele momento. Renovações antigas sem autoria aparecem com a indicação **Responsável não registrado**. As renovações continuam disponíveis após a devolução. A contagem começa na primeira prorrogação de um prazo já definido.

Abra [Swagger UI](http://127.0.0.1:4176/api-docs/) para consultar e testar as rotas ou acesse a [especificação OpenAPI em JSON](http://127.0.0.1:4176/api-docs/openapi.json). Para testar rotas protegidas, chame `POST /api/login`, copie o JWT retornado e informe o valor em **Authorize**. A rota `GET /api/circulacao` exige o perfil de bibliotecária.

Para usar um esquema de desenvolvimento separado com a conexão já configurada, defina `ACERVO_ESQUEMA` antes de iniciar o servidor local. No PowerShell, use `$env:ACERVO_ESQUEMA = 'acervo_biblioteca_local'` e execute `npm.cmd start` ou `node servidor.js`.

## Operação da biblioteca

| Tela | O que fazer |
| --- | --- |
| Relatório de circulação | Pesquisar por título, leitor, tombo ou número de empréstimo. Filtrar atrasados, vencimentos de hoje e itens sem prazo. Ordenar por vencimento, renovar ou receber a devolução. |
| Reservas para retirada | Filtrar as retiradas que encerram hoje, escolher o prazo e entregar o exemplar. O comprovante identifica o leitor, o tombo, o prazo e as movimentações. |
| Gestão do acervo e inventário físico | Cadastrar uma edição e sua capa HTTPS. Registrar cada cópia e localização, imprimir sua etiqueta, conferir o tombo ou indicar manutenção e extravio. Edições com circulação pendente precisam ser encerradas antes do arquivamento. |
| Balcão de atendimento | Ler os códigos da carteirinha e do exemplar com leitor USB em modo teclado, ou digitá-los. Configurar o prazo sugerido, o limite por leitor, o número de renovações e a prioridade da fila. Corrigir uma devolução com justificativa e identificação do responsável. |
| Reservas e Minha estante | Conferir retiradas, devoluções próximas e atrasos. Guardar títulos em **Quero ler** ou entrar na fila de um título indisponível. Uma devolução, um cancelamento, uma expiração ou uma nova cópia libera reserva de 48 horas para o próximo leitor. |
| Histórico e carteirinha digital | Buscar movimentações por título e período, avançar pelas páginas e imprimir o comprovante. A carteirinha tem código de barras e permite alterar a foto e as preferências de e-mail. |
| Indicadores de circulação | Selecionar o período de empréstimos e entradas na fila. A espera média considera as entradas do período que chegaram a gerar reserva. A fila atual e os exemplares extraviados ou em manutenção ajudam a decidir reposições. |

### Demonstração e dados reais

O modo de demonstração usa o esquema `acervo` por padrão. A migração atribui tombos aos exemplares existentes e inicia a localização como **A conferir**. Na primeira conferência, associe a etiqueta impressa à cópia física. Movimentos antigos preservam as datas e autorias disponíveis.

Em uma instalação real, defina `ACERVO_MODO=real`. O esquema padrão passa a ser `acervo_real` e começa vazio. `ACERVO_ESQUEMA` permite escolher outro esquema. O banco registra o modo e impede que o mesmo esquema seja aberto com outro modo. Para criar uma conta de bibliotecário, informe `ACERVO_EQUIPE_NOME`, `ACERVO_EQUIPE_EMAIL` e `ACERVO_EQUIPE_SENHA` no ambiente privado e execute `npm run biblioteca -- equipe`. O cadastro público cria leitores.

### Avisos e recuperação de senha

Para usar Gmail ou Google Workspace, habilite a verificação em duas etapas na conta remetente e gere uma senha de app para o Acervo. Algumas organizações restringem essa opção. [Instruções do Google](https://support.google.com/accounts/answer/185833?hl=pt-BR).

No Windows, abra a janela **Acervo | Conectar Gmail** com `.\scripts\configurar-gmail.ps1` no PowerShell do projeto. Ela verifica a conta e grava a configuração no arquivo privado.

Para configurar manualmente, no arquivo privado `.env` ou nas variáveis do servidor, defina `GMAIL_USUARIO` com o endereço completo e `GMAIL_SENHA_APP` com a senha de app. Espaços usados pelo Google para agrupar os caracteres são aceitos. Para outro provedor, configure `SMTP_URL` e `ACERVO_REMETENTE`. O Gmail usa SMTP autenticado com TLS na porta 465. [Transporte SMTP do Nodemailer](https://nodemailer.com/smtp).

Defina `ACERVO_ORIGEM` com a URL HTTPS da instalação para que o link recebido abra o site correto em qualquer dispositivo. Na Vercel de produção, o projeto pode usar o domínio público fornecido pela plataforma. Para testar na própria máquina, use a porta local do servidor. Reinicie o processo após alterar as variáveis. `npm run email:verificar` verifica conexão e autenticação. Para enviar também uma mensagem de confirmação ao próprio remetente Gmail, execute `npm run email:verificar -- --enviar`.

O leitor ativa os avisos em **Carteirinha digital → Preferências**. A biblioteca envia o aviso de retirada ao confirmar uma reserva ou liberar uma vaga na fila. O lembrete de empréstimo sai a partir de dois dias antes do prazo e o de atraso, a partir do dia seguinte, no calendário de Fortaleza. Cada tipo de lembrete é registrado por empréstimo e vencimento. Se o provedor recusar a mensagem, ela continua pendente enquanto a reserva ou o empréstimo for elegível. A recuperação de senha funciona mesmo com os lembretes desativados.

O servidor local verifica os prazos e repete avisos pendentes ao iniciar e a cada 15 minutos. Na Vercel, configure também `CRON_SECRET` com um segredo aleatório nas variáveis de produção. O agendamento em `vercel.json` chama a rota protegida diariamente na janela das 9h de Fortaleza. O mesmo processamento pode ser executado com `npm run biblioteca -- avisos`. [Cron da Vercel](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

A recuperação usa um link de uso único, válido por 20 minutos. Após a troca, as sessões anteriores perdem a validade. As contas compartilhadas de demonstração mantêm credenciais fixas.

### Regressão e restauração

Execute `npm ci`, `npx playwright install chromium` e `npm test`. O Node executa a regressão de API, os fluxos integrados e o ensaio no navegador em esquemas temporários separados. Para repetir apenas o navegador, use `npm run test:e2e`. O fluxo cobre teclado, viewport de celular, carteirinha, foto, reserva, retirada, renovação, devolução, inventário, recuperação e verificações automáticas de acessibilidade no balcão e na carteirinha. O workflow do GitHub Actions prepara PostgreSQL e Chromium a cada push ou pull request.

Com `ACERVO_ESQUEMA` apontando para a origem, execute `npm run biblioteca -- backup copia.json`. Proteja esse arquivo como o próprio banco de leitores. Para restaurar com a mesma versão do projeto, use `npm run biblioteca -- restaurar copia.json acervo_restaurado`. O destino precisa ser novo. A restauração recompõe vínculos e sequências, gera outra chave de sessão e descarta links temporários de recuperação. A suíte ensaia o processo com dados fictícios, compara a linha do tempo e o catálogo e cadastra mais um exemplar no banco restaurado.

### Demonstração da circulação

1. A equipe cadastra uma edição e uma cópia, imprime a etiqueta e registra a conferência.
2. Um leitor abre a edição no catálogo, guarda o título na estante e reserva. A equipe conclui a retirada e abre o comprovante.
3. Um segundo leitor entra na fila pelo catálogo. A equipe recebe a devolução e consulta **Reservas para retirada** para ver quem recebeu a vez.
4. Cada leitor consulta o próprio histórico. A equipe abre a linha do tempo pelo relatório ou pela ficha e encerra a apresentação nos indicadores do período.

## Roteiro de apresentação de 12 minutos

O roteiro da dupla reserva 6min45s para os slides e 5min15s para a prática. Abra [o laboratório local](http://127.0.0.1:4176/laboratorio/) ou use o link **Projeto acadêmico U2A1** no rodapé da biblioteca.

| Quem apresenta | Ação na tela | O que a turma deve observar |
| --- | --- | --- |
| Tullio | Consultar **Relatório de circulação** antes de entrar. | A API retorna 401 porque a requisição chegou sem token. |
| Tullio | Entrar com a conta de **Leitor** e consultar **Meus empréstimos**. | O login emite um JWT. A consulta retorna 200 com dois livros do leitor. |
| Tassiana | Consultar **Relatório de circulação** com o leitor. | O token continua válido. A API retorna 403 porque o leitor não tem a permissão exigida. |
| Tassiana | Sair, selecionar **Bibliotecária**, entrar e repetir o relatório. Abrir **Ver resposta JSON**. | A mesma rota retorna 200 com três empréstimos ativos e dois leitores. Em **Resultados do relatório**, a turma vê as respostas reais obtidas pelos três perfis durante o ensaio. |
| Dupla | Abrir `servidor.js` e localizar `bcrypt.compare`, `jwt.sign`, `autenticar` e a verificação de papel. | Cada resultado observado corresponde a uma decisão do servidor. |

## Como funciona

O login compara a senha com o hash bcrypt e emite um JWT HS256. No site da biblioteca, o navegador recebe o token em um cookie HttpOnly com validade de 30 minutos. No laboratório, o token dura cinco minutos e é enviado no cabeçalho Authorization. O middleware verifica assinatura, prazo, emissor e destinatário. O servidor busca a conta identificada pelo token e verifica o papel quando a rota exige. A chave de assinatura é privada e compartilhada pelas instâncias da API por meio do banco.

Execute `npm test` para verificar as rotas, a disponibilidade do catálogo, as reservas concorrentes e a persistência após reiniciar a aplicação. Os testes usam um esquema exclusivo no PostgreSQL configurado e o removem ao terminar. A interface está em `public/`, as consultas e a inicialização do banco em `banco.js` e os testes em `test/`.

## Capas do catálogo

As imagens em `public/capas/` mostram edições publicadas em português. Cada arquivo tem o mesmo identificador do livro no catálogo.

| Livro | Edição | Fonte da imagem |
| --- | --- | --- |
| Dom Casmurro | Penguin-Companhia, 9788582850350 | [Alexandria](https://capas.alexandria.com.br/9788582850350.jpg) |
| O Quinze | José Olympio, 9788503012928 | [Grupo Editorial Record](https://www.record.com.br/products/o-quinze/) |
| A Metamorfose | Companhia das Letras, 9788571646858 | [Biblioteca Benedito Gomes Ferreira](https://alexandria.dpu.def.br/pesquisa/titulo.jsf?codigo=729) |
| Clara dos Anjos | Penguin-Companhia, 9788563560391 | [Alexandria](https://capas.alexandria.com.br/9788563560391.jpg) |
| Alice no País das Maravilhas | Companhia das Letrinhas, 9788574067810 | [Capas de Livros Brasil](https://capasdelivrosbrasil.blogspot.com/2017/06/alice-no-pais-das-maravilhas-lewis-carroll.html) |
| O Cortiço | BestBolso, 9788577991709 | [Grupo Editorial Record](https://www.record.com.br/products/o-cortico-edicao-de-bolso) |
| Os Lusíadas | BestBolso, 9788577991990 | [Grupo Editorial Record](https://www.record.com.br/products/os-lusiadas-edicao-de-bolso) |
| O Alienista | Planeta, 9788542226898 | [Planeta de Livros](https://www.planetadelivros.com.br/livro-o-alienista/390149) |
| Memórias Póstumas de Brás Cubas | BestBolso, 9788577991761 | [Grupo Editorial Record](https://www.record.com.br/products/memorias-postumas-de-bras-cubas-edicao-de-bolso/) |
| Iracema | BestBolso, 9788577991747 | [Grupo Editorial Record](https://www.record.com.br/products/iracema-edicao-de-bolso/) |
| A Hora da Estrela | Rocco, 9786555320350 | [Editora Rocco](https://rocco.com.br/produto/a-hora-da-estrela-edicao-comemorativa/) |
| Capitães da Areia | Companhia de Bolso, 9788535914061 | [Alexandria](https://capas.alexandria.com.br/9788535914061.jpg) |
| O Pequeno Príncipe | HarperCollins Brasil, 9788595081512 | [HarperCollins Brasil](https://harpercollins.com.br/products/o-pequeno-principe-antoine-de-saint-exupery) |
| A Revolução dos Bichos | Companhia das Letras, 9788535909555 | [Alexandria](https://capas.alexandria.com.br/9788535909555.jpg) |
| Auto da Compadecida | Nova Fronteira, 9788520938393 | [Alexandria](https://capas.alexandria.com.br/9788520938393.jpg) |
| Mensagem | BestBolso, 9788577990955 | [Grupo Editorial Record](https://www.record.com.br/products/mensagem-edicao-de-bolso/) |

## Referências

- [bcrypt para Node.js](https://github.com/kelektiv/node.bcrypt.js)
- [Emissão e verificação de JWT com jsonwebtoken](https://github.com/auth0/node-jsonwebtoken)
- [Uso de JWT para autenticar um GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
