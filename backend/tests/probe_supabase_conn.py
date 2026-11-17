import sys
import os
import urllib.parse
from sqlalchemy import create_engine, text

raw = "postgresql://postgres.frkivglhkrrzombmbjgh:Itsmeprathik8951@pk5321@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres"

scheme, rest = raw.split("://", 1)
last_at_idx = rest.rfind("@")
userinfo = rest[:last_at_idx]
host_part = rest[last_at_idx + 1:]
user, pwd = userinfo.split(":", 1)
encoded_pwd = urllib.parse.quote_plus(pwd)

# Verify with sslmode=require
url = f"postgresql+psycopg2://{user}:{encoded_pwd}@{host_part}?sslmode=require"

print("Attempting connection to Supabase PostgreSQL...")
try:
    engine = create_engine(url, pool_pre_ping=True)
    with engine.connect() as conn:
        res = conn.execute(text("SELECT version();"))
        row = res.fetchone()
        print("✓ Connection SUCCESSFUL!")
        print("✓ Detected database dialect:", engine.dialect.name)
        print("✓ PostgreSQL driver:", engine.dialect.driver)
        print("✓ PostgreSQL version snippet:", row[0][:40])

        tables_res = conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"))
        tables = [t[0] for t in tables_res.fetchall()]
        print("✓ Existing public tables in Supabase:", tables)
except Exception as e:
    print("✗ Connection FAILED:", type(e).__name__, str(e))
