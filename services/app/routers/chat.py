from fastapi import APIRouter, HTTPException
from typing import List
import uuid
import datetime as dt

from services.core.context import get_storage
from services.core.models import (
    ChatSession,
    ChatMessage,
    ChatSessionCreate, # Keeping this as it's used later in the code
    ChatMessageCreate, # Keeping this as it's used later in the code
)


router = APIRouter(prefix="/chat", tags=["chat"])


@router.get("/sessions", response_model=List[ChatSession])
async def list_sessions(limit: int = 100, offset: int = 0):
    storage = get_storage()
    return storage.list_chat_sessions(limit, offset)


@router.post("/sessions", response_model=ChatSession)
async def create_session(payload: ChatSessionCreate):
    storage = get_storage()
    now = dt.datetime.now(dt.timezone.utc)
    session_id = str(uuid.uuid4())
    session = ChatSession(
        id=session_id,
        title=payload.title or "New Chat",
        created_at=now,
        updated_at=now,
        messages=[]
    )
    storage.upsert_chat_session(session)
    return session


@router.get("/sessions/{session_id}", response_model=ChatSession)
async def get_session(session_id: str):
    storage = get_storage()
    session = storage.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    storage = get_storage()
    storage.delete_chat_session(session_id)
    return {"status": "ok"}


@router.put("/sessions/{session_id}")
async def update_session(session_id: str, payload: ChatSessionCreate):
    storage = get_storage()
    session = storage.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if payload.title:
        session.title = payload.title
        session.updated_at = dt.datetime.now(dt.timezone.utc)
        storage.upsert_chat_session(session)

    return session


@router.post("/sessions/{session_id}/messages", response_model=ChatMessage)
async def add_message(session_id: str, payload: ChatMessageCreate):
    storage = get_storage()
    session = storage.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    now = dt.datetime.now(dt.timezone.utc)
    message = ChatMessage(
        id=str(uuid.uuid4()),
        session_id=session_id,
        role=payload.role,
        content=payload.content,
        timestamp=now,
        meta=payload.meta,
        references=payload.references,
        is_multi_path=payload.is_multi_path,
        thinking_steps=payload.thinking_steps
    )
    storage.add_chat_message(message)
    return message
