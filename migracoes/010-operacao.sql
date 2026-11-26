ALTER TABLE __acervo__.catalogo ADD COLUMN edicao text NOT NULL DEFAULT '', ADD COLUMN arquivado boolean NOT NULL DEFAULT false;
ALTER TABLE __acervo__.catalogo DROP CONSTRAINT catalogo_titulo_autor_key, ADD UNIQUE (titulo, autor, edicao);
ALTER TABLE __acervo__.catalogo DROP CONSTRAINT catalogo_exemplares_check, ADD CHECK (exemplares >= 0);
CREATE SEQUENCE __acervo__.tombo_seq;
CREATE TABLE __acervo__.copias (
  tombo text PRIMARY KEY DEFAULT ('AC-' || nextval('__acervo__.tombo_seq')::text),
  livro_id text NOT NULL REFERENCES __acervo__.catalogo(id),
  localizacao text NOT NULL DEFAULT 'A conferir',
  estado text NOT NULL DEFAULT 'regular' CHECK (estado IN ('regular','manutencao','extraviado')),
  conferido_em timestamptz, conferido_por text REFERENCES __acervo__.contas(id)
);
CREATE INDEX copias_livro ON __acervo__.copias(livro_id);
INSERT INTO __acervo__.copias (livro_id)
  SELECT l.id FROM __acervo__.catalogo l, generate_series(1,l.exemplares) n ORDER BY l.ordem,n;
ALTER TABLE __acervo__.emprestimos ADD COLUMN tombo text REFERENCES __acervo__.copias(tombo);
WITH ativos AS (
  SELECT id,livro_id,row_number() OVER (PARTITION BY livro_id ORDER BY id) n FROM __acervo__.emprestimos WHERE devolvido_em IS NULL
), copias AS (
  SELECT tombo,livro_id,row_number() OVER (PARTITION BY livro_id ORDER BY tombo) n FROM __acervo__.copias
) UPDATE __acervo__.emprestimos e SET tombo=c.tombo FROM ativos a JOIN copias c USING (livro_id,n) WHERE a.id=e.id;
CREATE UNIQUE INDEX copia_em_uso ON __acervo__.emprestimos(tombo) WHERE devolvido_em IS NULL;
CREATE TABLE __acervo__.fila (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, conta_id text NOT NULL REFERENCES __acervo__.contas(id),
  livro_id text NOT NULL REFERENCES __acervo__.catalogo(id), entrada timestamptz NOT NULL DEFAULT now(),
  saida timestamptz, reserva_id bigint REFERENCES __acervo__.reservas(id)
);
CREATE UNIQUE INDEX espera_ativa ON __acervo__.fila(conta_id,livro_id) WHERE saida IS NULL;
CREATE TABLE __acervo__.regras (id integer PRIMARY KEY CHECK(id=1), dias integer NOT NULL CHECK(dias BETWEEN 1 AND 365),
  limite integer NOT NULL CHECK(limite BETWEEN 1 AND 100), renovacoes integer NOT NULL CHECK(renovacoes BETWEEN 0 AND 100),
  respeitar_fila boolean NOT NULL);
INSERT INTO __acervo__.regras VALUES(1,14,10,10,true);
CREATE TABLE __acervo__.correcoes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, emprestimo_id bigint NOT NULL REFERENCES __acervo__.emprestimos(id),
  em timestamptz NOT NULL DEFAULT clock_timestamp(), responsavel text NOT NULL, equipe_id text NOT NULL REFERENCES __acervo__.contas(id),
  motivo text NOT NULL, devolucao_anterior timestamptz NOT NULL, recebedor_anterior text);
CREATE TABLE __acervo__.estante (conta_id text REFERENCES __acervo__.contas(id),livro_id text REFERENCES __acervo__.catalogo(id), PRIMARY KEY(conta_id,livro_id));
ALTER TABLE __acervo__.contas ADD COLUMN foto text, ADD COLUMN avisos_email boolean NOT NULL DEFAULT false;
CREATE TABLE __acervo__.recuperacao (conta_id text PRIMARY KEY REFERENCES __acervo__.contas(id), resumo text UNIQUE NOT NULL, expira timestamptz NOT NULL);
CREATE TABLE __acervo__.emails_enviados (chave text PRIMARY KEY, enviado_em timestamptz NOT NULL DEFAULT now());
INSERT INTO __acervo__.migracoes VALUES (10);
