import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATA_DIR = Path(os.environ.get("CLIPCRAFT_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))


def _database_url() -> str:
    """DATABASE_URL이 있으면 그 DB(PostgreSQL 등)를, 없으면 data/clipcraft.db(SQLite)를 쓴다."""
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{DATA_DIR / 'clipcraft.db'}"

    # postgres://, postgresql:// 로 써도 psycopg(v3) 드라이버로 연결한다.
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


DATABASE_URL = _database_url()
_IS_SQLITE = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if _IS_SQLITE else {},
    pool_pre_ping=not _IS_SQLITE,  # 끊어진 연결은 다시 열어서 쓴다
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401 registers models on Base before create_all

    Base.metadata.create_all(bind=engine)
