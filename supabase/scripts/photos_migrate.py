#!/usr/bin/env python3
"""
Migracao de fotos do imgBB para o Supabase Storage (bucket kids-photos).

Comandos:
  backup    Baixa metadados (Backup A) e as imagens (Backup B) para .backups/
  backfill  Baixa, comprime, sobe para o Storage e atualiza o banco (idempotente)
  revert    Volta as URLs do banco para as originais (imgBB), usando o mapeamento
  verify    Mostra a contagem de fotos por origem

Requer o arquivo .secrets.env na raiz do repositorio (gitignored) com:
  SUPABASE_URL, PROJECT_REF, SUPABASE_ACCESS_TOKEN, SUPABASE_SERVICE_ROLE_KEY

Uso:
  python3 supabase/scripts/photos_migrate.py backup
  python3 supabase/scripts/photos_migrate.py backfill
  python3 supabase/scripts/photos_migrate.py revert
  python3 supabase/scripts/photos_migrate.py verify
"""

import argparse
import io
import json
import mimetypes
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SECRETS = ROOT / ".secrets.env"
BACKUP_DIR = ROOT / ".backups"

BUCKET = "kids-photos"
MAX_SIDE = 720
QUALITY = 0.8

ROWS_QUERY = """
select 'familia' as tipo, f.id::text as row_id, f.id::text as family_id,
       null::text as child_id, coalesce(f.family_name, '') as nome,
       'father_photo_url' as campo, f.father_photo_url as url
  from public.kids_families f
 where f.father_photo_url is not null
union all
select 'familia', f.id::text, f.id::text, null, coalesce(f.family_name, ''),
       'mother_photo_url', f.mother_photo_url
  from public.kids_families f
 where f.mother_photo_url is not null
union all
select 'crianca', c.id::text, c.family_id::text, c.id::text, coalesce(c.name, ''),
       'photo_url', c.photo_url
  from public.kids_children c
 where c.photo_url is not null
"""


def load_secrets():
    if not SECRETS.exists():
        sys.exit(f"Arquivo de segredos nao encontrado: {SECRETS}")
    env = {}
    for line in SECRETS.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    for req in ("SUPABASE_URL", "PROJECT_REF", "SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(req):
            sys.exit(f"Variavel ausente em .secrets.env: {req}")
    return env


ENV = load_secrets()
SUPABASE_URL = ENV["SUPABASE_URL"].rstrip("/")
PROJECT_REF = ENV["PROJECT_REF"]
ACCESS_TOKEN = ENV["SUPABASE_ACCESS_TOKEN"]
SERVICE_KEY = ENV["SUPABASE_SERVICE_ROLE_KEY"]

STORAGE_PUBLIC_PREFIX = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/"


def sql(query):
    """Executa SQL via Management API e retorna as linhas (lista de dicts)."""
    body = json.dumps({"query": query}).encode()
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {ACCESS_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as e:
        sys.exit(f"Erro SQL ({e.code}): {e.read().decode()[:500]}")
    return json.loads(raw) if raw.strip() else []


def q(value):
    """Escapa um valor para uso em SQL como literal."""
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def fetch_rows():
    return sql(ROWS_QUERY)


def is_storage_url(url):
    return bool(url) and url.startswith(STORAGE_PUBLIC_PREFIX)


def download(url):
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "domingokids-migration/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read(), resp.headers.get("Content-Type", "")
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < 3:
                time.sleep(2 * (attempt + 1))
    raise last


def compress_image(raw):
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(raw))
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    else:
        img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="WEBP", quality=int(QUALITY * 100), method=6)
    return out.getvalue(), "webp"


def storage_upload(path, data, content_type):
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{urllib.parse.quote(path)}"
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {SERVICE_KEY}",
            "apikey": SERVICE_KEY,
            "Content-Type": content_type,
            "x-upsert": "true",
            "cache-control": "31536000",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status in (200, 201)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"upload falhou ({e.code}): {e.read().decode()[:300]}")


def public_url(path):
    return STORAGE_PUBLIC_PREFIX + urllib.parse.quote(path)


def kind_for(row):
    if row["tipo"] == "familia":
        return "pai" if row["campo"] == "father_photo_url" else "mae"
    return f"crianca-{row['row_id']}"


def timestamp():
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


# ---------------------------------------------------------------------------
# backup
# ---------------------------------------------------------------------------
def cmd_backup(_args):
    BACKUP_DIR.mkdir(exist_ok=True)
    imgs_dir = BACKUP_DIR / "imagens"
    imgs_dir.mkdir(exist_ok=True)

    rows = fetch_rows()
    ts = timestamp()
    meta_path = BACKUP_DIR / f"photo_metadata_{ts}.json"

    manifest = {"generated_at": ts, "supabase_url": SUPABASE_URL, "bucket": BUCKET, "rows": rows}
    meta_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[backup] metadados ({len(rows)} linhas) -> {meta_path.relative_to(ROOT)}")

    zip_path = BACKUP_DIR / f"imagens_{ts}.zip"
    ok = fail = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "photo_metadata.json",
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )
        for row in rows:
            name = f"{row['tipo']}_{row['row_id']}_{row['campo']}"
            try:
                raw, ctype = download(row["url"])
                ext = mimetypes.guess_extension((ctype or "").split(";")[0]) or ".img"
                arcname = f"imagens/{name}{ext}"
                zf.writestr(arcname, raw)
                ok += 1
                print(f"[backup] imagem OK  {name} ({len(raw) // 1024} KB)")
            except Exception as e:  # noqa: BLE001
                fail += 1
                print(f"[backup] imagem FALHOU {name}: {e}")
    print(f"[backup] imagens: {ok} OK, {fail} falharam -> {zip_path.relative_to(ROOT)}")


# ---------------------------------------------------------------------------
# backfill
# ---------------------------------------------------------------------------
def cmd_backfill(_args):
    rows = fetch_rows()
    pend = [r for r in rows if not is_storage_url(r["url"])]
    if not pend:
        print("[backfill] nada a migrar (todas as fotos ja estao no Storage).")
        return

    print(f"[backfill] {len(pend)} foto(s) para migrar.")
    migrados = falhas = 0
    for row in pend:
        ident = f"{row['tipo']}/{row['row_id']}/{row['campo']}"
        folder = row["family_id"] or "sem-familia"
        path = f"{folder}/{kind_for(row)}-v{int(time.time())}-{row['row_id'][:8]}.webp"
        try:
            raw, _ = download(row["url"])
            data, ext = compress_image(raw)
            content_type = "image/webp" if ext == "webp" else "image/jpeg"
            storage_upload(path, data, content_type)
            new_url = public_url(path)
            legacy_col = {
                "father_photo_url": "father_photo_url_legacy",
                "mother_photo_url": "mother_photo_url_legacy",
                "photo_url": "photo_url_legacy",
            }[row["campo"]]
            table = "kids_families" if row["tipo"] == "familia" else "kids_children"
            sql(f"""
                update public.{table}
                   set {row['campo']} = {q(new_url)},
                       {legacy_col} = coalesce({legacy_col}, {q(row['url'])})
                 where id = {q(row['row_id'])}
                   and {row['campo']} = {q(row['url'])};
            """)
            sql(f"""
                insert into public.kids_photo_migration
                    (table_name, row_id, field, old_url, new_url, status, updated_at)
                values ({q(table)}, {q(row['row_id'])}, {q(row['campo'])},
                        {q(row['url'])}, {q(new_url)}, 'migrated', now())
                on conflict (table_name, row_id, field)
                do update set old_url = excluded.old_url,
                              new_url = excluded.new_url,
                              status = 'migrated',
                              updated_at = now();
            """)
            migrados += 1
            print(f"[backfill] OK {ident} ({len(data) // 1024} KB): {new_url}")
        except Exception as e:  # noqa: BLE001
            falhas += 1
            print(f"[backfill] FALHOU {ident}: {e}")
    print(f"[backfill] concluido: {migrados} migradas, {falhas} falharam.")


# ---------------------------------------------------------------------------
# revert
# ---------------------------------------------------------------------------
def cmd_revert(_args):
    print("[revert] restaurando URLs originais do imgBB a partir do mapeamento...")
    for table, field in (
        ("kids_families", "father_photo_url"),
        ("kids_families", "mother_photo_url"),
        ("kids_children", "photo_url"),
    ):
        sql(f"""
            update public.{table} t
               set {field} = m.old_url
              from public.kids_photo_migration m
             where m.table_name = {q(table)}
               and m.field = {q(field)}
               and m.row_id = t.id
               and m.status = 'migrated'
               and t.{field} = m.new_url;
        """)
        sql(f"""
            update public.kids_photo_migration
               set status = 'reverted', updated_at = now()
             where table_name = {q(table)} and field = {q(field)} and status = 'migrated';
        """)
    print("[revert] pronto. As URLs do banco voltaram para o imgBB.")
    print("[revert] Lembre-se de trocar PHOTO_BACKEND para 'imgbb' em config.js.")


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------
def cmd_verify(_args):
    rows = fetch_rows()
    storage = [r for r in rows if is_storage_url(r["url"])]
    imgbb = [r for r in rows if "ibb.co" in (r["url"] or "")]
    other = [r for r in rows if r not in storage and r not in imgbb]
    print(f"[verify] total: {len(rows)}")
    print(f"[verify] no Supabase Storage: {len(storage)}")
    print(f"[verify] no imgBB: {len(imgbb)}")
    print(f"[verify] outros: {len(other)}")
    for r in other:
        print(f"[verify]   outro: {r['tipo']}/{r['campo']} -> {r['url']}")


def main():
    parser = argparse.ArgumentParser(description="Migracao de fotos imgBB -> Supabase Storage")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("backup").set_defaults(func=cmd_backup)
    sub.add_parser("backfill").set_defaults(func=cmd_backfill)
    sub.add_parser("revert").set_defaults(func=cmd_revert)
    sub.add_parser("verify").set_defaults(func=cmd_verify)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
