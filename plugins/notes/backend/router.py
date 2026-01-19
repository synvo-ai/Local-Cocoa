from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status

from services.core.context import get_notes_service
from services.core.models import NoteContent, NoteCreate, NoteSummary
from .service import NoteNotFound, NotesService, NotesServiceError

router = APIRouter(tags=["plugin-notes"])


@router.get("", response_model=list[NoteSummary])
def list_notes(service: NotesService = Depends(get_notes_service)) -> list[NoteSummary]:
    return service.list_notes()


@router.post("", response_model=NoteSummary, status_code=status.HTTP_201_CREATED)
def create_note(payload: NoteCreate, service: NotesService = Depends(get_notes_service)) -> NoteSummary:
    try:
        return service.create_note(payload)
    except NotesServiceError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/{note_id}", response_model=NoteContent)
def get_note(note_id: str, service: NotesService = Depends(get_notes_service)) -> NoteContent:
    try:
        return service.get_note(note_id)
    except NoteNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.put("/{note_id}", response_model=NoteContent)
def update_note(note_id: str, payload: NoteCreate, service: NotesService = Depends(get_notes_service)) -> NoteContent:
    try:
        return service.update_note(note_id, payload)
    except NoteNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except NotesServiceError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def delete_note(note_id: str, service: NotesService = Depends(get_notes_service)) -> Response:
    try:
        service.delete_note(note_id)
    except NoteNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)

