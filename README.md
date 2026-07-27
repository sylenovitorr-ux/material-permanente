# Material Permanente

Portal público com dois aplicativos:

- `app-atual/`: aplicativo operacional completo, com 27 processos internos e 561 etapas;
- `caderno-2025/`: versão didática baseada no Caderno de Gestão Patrimonial de outubro de 2025.

## Publicação

A publicação integral da base operacional foi autorizada pelo proprietário. Marcações, execuções, imagens e edições posteriores continuam salvas localmente no navegador até serem exportadas.

O site usa `noindex` para reduzir a indexação por buscadores. Isso não torna o repositório ou o site privados.

## Sincronização com Supabase

O app operacional mantém IndexedDB como cópia offline e usa Supabase opcionalmente para sincronizar processos, versões, checklists e andamento entre aparelhos. Screenshots permanecem locais nesta primeira fase.

1. Execute `supabase-setup.sql` no SQL Editor do projeto.
2. Abra `app-atual/` e use o botão **Conectar**.
3. Crie a conta ou entre com e-mail e senha.

A tabela usa Row Level Security (RLS): cada usuário autenticado acessa apenas o próprio registro.
