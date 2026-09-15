# Migracao de fotos: imgBB -> Supabase Storage

Este documento explica como o sistema de fotos funciona hoje e, principalmente,
**como voltar para o imgBB** (rollback) em poucos passos.

## Como funciona agora

- As fotos novas sao comprimidas no navegador (maior lado 720px, WebP q0.8) e
  enviadas para o bucket **publico** `kids-photos` do Supabase Storage.
- O bucket aceita escrita apenas na pasta da propria familia
  (`{family_id}/...`), garantido por RLS.
- As URLs antigas do imgBB ficam guardadas nas colunas `*_legacy` e na tabela
  `kids_photo_migration`, permitindo reverter com precisao.
- O backend de upload e controlado por `PHOTO_BACKEND` em `config.js`.

## Backups (na pasta `.backups/`, fora do Git)

Gerados com `python3 supabase/scripts/photos_migrate.py backup`:

- `photo_metadata_<data>.json` - todas as linhas (id + campos + URL original).
- `imagens_<data>.zip` - as imagens originais baixadas do imgBB.

Esses arquivos contem dados das familias; por isso ficam no `.gitignore` e
**nao** devem ser commitados.

## Rollback para o imgBB (passo a passo)

1. Em `config.js`, troque:
   ```js
   const PHOTO_BACKEND = 'imgbb';
   ```
2. No terminal, rode:
   ```bash
   python3 supabase/scripts/photos_migrate.py revert
   ```
   Isso restaura as URLs do imgBB apenas nos registros que foram migrados e que
   continuam com a URL nova (nao sobrescreve fotos alteradas depois).
3. Publique (commit/push). O upload volta a usar a Edge Function `imgbb-upload`,
   que foi mantida intacta.

Observacao: os arquivos que ficaram no bucket `kids-photos` **nao** sao
apagados automaticamente. Eles sao inofensivos; podem ser removidos depois, se
quiser, pelo painel do Supabase.

## Restauracao total a partir do backup (ultimo recurso)

Se precisar voltar exatamente ao estado anterior:

1. Restaure as URLs a partir do JSON de metadados (para cada linha, regravar os
   campos originais), ou
2. Reenvie as imagens do `.zip` para o imgBB e regrave as URLs.

O script `verify` ajuda a conferir quantas fotos estao em cada origem:
```bash
python3 supabase/scripts/photos_migrate.py verify
```

## Comandos do script

```bash
python3 supabase/scripts/photos_migrate.py backup    # Backup A + B
python3 supabase/scripts/photos_migrate.py backfill  # migra (idempotente)
python3 supabase/scripts/photos_migrate.py revert    # volta para o imgBB
python3 supabase/scripts/photos_migrate.py verify    # contagem por origem
```

Requer `.secrets.env` na raiz (gitignored) com `SUPABASE_URL`, `PROJECT_REF`,
`SUPABASE_ACCESS_TOKEN` e `SUPABASE_SERVICE_ROLE_KEY`.
