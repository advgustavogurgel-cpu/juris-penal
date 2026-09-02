# Juris Penal

Executor de coleta e atualização do acervo de jurisprudência penal do STJ.

## Escopo atual

- acórdãos da Quinta Turma, Sexta Turma e Terceira Seção;
- registros publicados desde 1º de janeiro de 2020;
- origem: Portal de Dados Abertos do Superior Tribunal de Justiça;
- deduplicação pelo identificador oficial do STJ;
- carga no sistema Juris Penal em lotes auditáveis.

O repositório contém apenas código e configuração. Credenciais de ingestão são lidas por GitHub Actions Secrets e não devem ser gravadas em arquivos ou commits.

## Atualização

O fluxo `Sincronizar acervo STJ` pode ser executado manualmente e também roda mensalmente. Ele baixa a carga histórica e os incrementos publicados pelo STJ, normaliza os registros, elimina duplicidades e envia os lotes ao sistema de busca.
