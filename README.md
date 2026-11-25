# Acervo · Seminário Fullstack U2A1

**Tassiana Oliveira e Tullio Oliveira**

Tema 01 — Autenticação e autorização com JWT e bcrypt.

## Abrir a demonstração

[Abrir o Acervo online](https://acervo-novaroma.vercel.app). O site e a API estão publicados na Vercel da Nova Roma e usam o PostgreSQL do Neon. Para apresentar, basta abrir o link e escolher uma das contas de exemplo.

### Executar o servidor a partir do código

Com Node.js 22 ou superior, abra o terminal nesta pasta. Na primeira execução, instale as dependências com `npm ci`. O servidor lê a conexão PostgreSQL de `DATABASE_URL` no ambiente ou do arquivo privado `.env` desta pasta. Em outro computador, configure essa variável no servidor com a conexão TLS do banco do Acervo. Execute `npm start` e abra [o Acervo no navegador](http://127.0.0.1:4176). No PowerShell, use `npm.cmd` se o Windows bloquear o script `npm.ps1`.

O site e a API são servidos pelo Express. As contas, os hashes de senha e os empréstimos ficam no PostgreSQL do Neon, na região de São Paulo. A demonstração precisa de internet. A primeira execução cria duas contas fictícias e três empréstimos. Nas execuções seguintes, os dados existentes são preservados.

## Roteiro de apresentação de 12 minutos

O roteiro da dupla reserva 6min45s para os slides e 5min15s para a prática. A sequência abaixo permite reproduzir a demonstração pelo site público.

| Quem apresenta | Ação na tela | O que a turma deve observar |
| --- | --- | --- |
| Tullio | Consultar **Relatório de circulação** antes de entrar. | A API retorna 401 porque a requisição chegou sem token. |
| Tullio | Entrar com a conta de **Leitor** e consultar **Meus empréstimos**. | O login emite um JWT. A consulta retorna 200 com dois livros do leitor. |
| Tassiana | Consultar **Relatório de circulação** com o leitor. | O token continua válido. A API retorna 403 porque o leitor não tem a permissão exigida. |
| Tassiana | Sair, selecionar **Bibliotecária**, entrar e repetir o relatório. Abrir **Ver resposta JSON**. | A mesma rota retorna 200 com três empréstimos ativos e dois leitores. Em **Resultados do relatório**, a turma vê as respostas reais obtidas pelos três perfis durante o ensaio. |
| Dupla | Abrir `servidor.js` e localizar `bcrypt.compare`, `jwt.sign`, `autenticar` e a verificação de papel. | Cada resultado observado corresponde a uma decisão do servidor. |

## Como funciona

O login compara a senha com o hash bcrypt e emite um JWT HS256 válido por cinco minutos. A página mantém o token em memória e o envia no cabeçalho Authorization. O middleware verifica assinatura, prazo, emissor e destinatário. O servidor busca a conta identificada pelo token e verifica o papel quando a rota exige. Sair remove o token da página. A chave de assinatura é privada e compartilhada pelas instâncias da API por meio do banco. O JWT continua válido até expirar, mesmo quando a Vercel inicia outra instância.

Execute `npm test` para verificar as rotas e a persistência de uma nova conta e de um novo empréstimo após reiniciar a aplicação. Os testes usam um esquema exclusivo no PostgreSQL configurado e o removem ao terminar. A interface está em `public/`, as consultas e a inicialização do banco em `banco.js` e os testes em `test/`.

## Referências

- [bcrypt para Node.js](https://github.com/kelektiv/node.bcrypt.js)
- [Emissão e verificação de JWT com jsonwebtoken](https://github.com/auth0/node-jsonwebtoken)
- [Uso de JWT para autenticar um GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
