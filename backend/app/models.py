import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base

 
def new_id() -> str:
    return uuid.uuid4().hex
  

def utcnow() -> datetime:
    return datetime.utcnow()


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(50))
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String)
    marketing_consent: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    projects: Mapped[list["Project"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String, unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    user: Mapped["User"] = relationship(back_populates="refresh_tokens")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(100))
    format: Mapped[str] = mapped_column(String(10), default="9:16")
    status: Mapped[str] = mapped_column(String(20), default="draft")
    starred: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    source_duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scene_count: Mapped[int] = mapped_column(Integer, default=0)
    exported_duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    preview_url: Mapped[str | None] = mapped_column(String, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    user: Mapped["User"] = relationship(back_populates="projects")


class ProjectData(Base):
    """프로젝트에 딸린 영상 파일 위치, 분석 결과, 편집 상태. 목록용 Project 행과 분리해 둔다."""

    __tablename__ = "project_data"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    video_filename: Mapped[str | None] = mapped_column(String, nullable=True)
    video_content_type: Mapped[str | None] = mapped_column(String, nullable=True)
    # DATA_DIR 기준 상대 경로. 나중에 S3 등으로 바꿀 때 이 값과 projects_storage.py만 손보면 된다.
    video_storage_path: Mapped[str | None] = mapped_column(String, nullable=True)
    # GPU 서버 임시 폴더에 있는 분석용 사본의 경로. 서버가 비웠으면 저장해 둔 영상으로 다시 올린다.
    gpu_video_path: Mapped[str | None] = mapped_column(String, nullable=True)
    job_id: Mapped[str | None] = mapped_column(String, nullable=True)
    analysis: Mapped[str | None] = mapped_column(Text, nullable=True)
    editor_state: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
