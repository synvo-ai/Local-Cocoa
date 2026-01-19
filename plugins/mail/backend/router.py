from __future__ import annotations

import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel

from services.core.context import get_email_service
from .service import EmailAccountNotFound, EmailAuthError, EmailService, EmailServiceError, EmailSyncError
from services.core.models import (
    EmailAccountCreate,
    EmailAccountSummary,
    EmailMessageContent,
    EmailMessageSummary,
    EmailSyncRequest,
    EmailSyncResult,
)

router = APIRouter(tags=["plugin-mail"])


class OutlookAuthRequest(BaseModel):
    client_id: str
    tenant_id: str


class OutlookCompleteRequest(BaseModel):
    flow_id: str
    label: str


@router.post("/outlook/auth", response_model=dict)
async def start_outlook_auth(
    payload: OutlookAuthRequest,
    service: EmailService = Depends(get_email_service)
) -> dict:
    try:
        flow_id = await service.start_outlook_auth(payload.client_id, payload.tenant_id)
        return {"flow_id": flow_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/outlook/auth/{flow_id}", response_model=dict)
async def get_outlook_auth_status(
    flow_id: str,
    service: EmailService = Depends(get_email_service)
) -> dict:
    try:
        return await service.get_outlook_auth_status(flow_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/outlook/complete", response_model=EmailAccountSummary)
async def complete_outlook_setup(
    payload: OutlookCompleteRequest,
    service: EmailService = Depends(get_email_service)
) -> EmailAccountSummary:
    try:
        return await service.complete_outlook_setup(payload.flow_id, payload.label)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/accounts", response_model=list[EmailAccountSummary])
async def list_accounts(service: EmailService = Depends(get_email_service)) -> list[EmailAccountSummary]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, service.list_accounts)


@router.post("/accounts", response_model=EmailAccountSummary, status_code=status.HTTP_201_CREATED)
async def add_account(
    payload: EmailAccountCreate,
    service: EmailService = Depends(get_email_service),
) -> EmailAccountSummary:
    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: service.add_account(payload))
    except EmailServiceError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def remove_account(account_id: str, service: EmailService = Depends(get_email_service)) -> Response:
    try:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: service.remove_account(account_id))
    except EmailAccountNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/accounts/{account_id}/sync", response_model=EmailSyncResult)
async def sync_account(
    account_id: str,
    request: EmailSyncRequest,
    service: EmailService = Depends(get_email_service),
) -> EmailSyncResult:
    try:
        return await service.sync_account(account_id, request)
    except EmailAccountNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except EmailAuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except EmailSyncError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    except EmailServiceError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/accounts/{account_id}/messages", response_model=list[EmailMessageSummary])
def list_messages(
    account_id: str,
    limit: int = Query(default=50, ge=1, le=EmailService.MAX_SYNC_BATCH),
    service: EmailService = Depends(get_email_service),
) -> list[EmailMessageSummary]:
    try:
        return service.list_messages(account_id, limit)
    except EmailAccountNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get("/messages/{message_id}", response_model=EmailMessageContent)
def get_message(message_id: str, service: EmailService = Depends(get_email_service)) -> EmailMessageContent:
    try:
        return service.get_message(message_id)
    except EmailServiceError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

