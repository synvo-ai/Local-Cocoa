from __future__ import annotations

import asyncio
from pathlib import Path
import logging
import threading
import time
import uuid
from services.core.config import settings
from typing import Any

import msal
from azure.core.credentials import AccessToken
from msal_extensions import (
    PersistedTokenCache,
    build_encrypted_persistence,
)
from msgraph import GraphServiceClient
from msgraph.generated.users.item.mail_folders.item.messages.messages_request_builder import (
    MessagesRequestBuilder,
)

logger = logging.getLogger(__name__)

# Standard scopes for reading mail
GRAPH_SCOPES = ["User.Read", "Mail.Read"]

OUTLOOK_DEFAULT_CLIENT_ID = "f0f434e5-80fb-4db9-823c-36707ec98470"
OUTLOOK_DEFAULT_TENANT_ID = "common"

# Cache location
CACHE_FILE = Path.home() / ".synvo_outlook_token_cache.bin"


class OutlookServiceError(Exception):
    """Base error for Outlook service issues."""


class OutlookAuthError(OutlookServiceError):
    """Raised when authentication fails or requires interaction."""


class MsalCredential:
    """
    Adapts MSAL PublicClientApplication to the Azure Core TokenCredential protocol
    expected by GraphServiceClient.
    """

    def __init__(self, app: msal.PublicClientApplication, account: dict[str, Any]):
        self._app = app
        self._account = account

    async def get_token(self, *scopes, **kwargs):
        # GraphServiceClient requests scopes, we need to ensure they match what we have
        # or are a subset. MSAL expects a list.
        scope_list = list(scopes)

        # Acquire token silent
        result = self._app.acquire_token_silent(
            scope_list, account=self._account
        )

        if not result:
            # If silent fails, we can't prompt here (headless/background).
            # The user must re-authenticate via the UI flow.
            raise OutlookAuthError("Silent token acquisition failed. Re-authentication required.")

        if "error" in result:
            raise OutlookAuthError(f"Token error: {result.get('error_description')}")

        # Return an object with a 'token' attribute as expected by Azure Core
        # expires_in is in seconds, we need absolute timestamp
        expires_in = int(result.get("expires_in", 3600))
        expires_on = int(time.time()) + expires_in
        return AccessToken(result["access_token"], expires_on)

    async def close(self):
        """
        Closes the credential. Required by Azure Core/Kiota.
        """
        pass


class OutlookService:
    """
    Handles Outlook authentication and synchronization using raw MSAL and Microsoft Graph API.
    Manages a persistent token cache file manually.
    """

    def __init__(self):
        self._active_flows: dict[str, dict[str, Any]] = {}
        self._cache = self._load_cache()

    def _load_cache(self) -> PersistedTokenCache:
        """
        Initializes the persistent token cache.
        """
        # Using build_encrypted_persistence is safer and cross-platform compatible
        # It uses DPAPI on Windows, LibSecret on Linux, Keychain on Mac
        persistence = build_encrypted_persistence(str(CACHE_FILE))
        cache = PersistedTokenCache(persistence)
        return cache

    def _get_app(self, client_id: str, tenant_id: str) -> msal.PublicClientApplication:
        """
        Creates the MSAL PublicClientApplication with the persistent cache.
        """
        authority = f"https://login.microsoftonline.com/{tenant_id}"
        return msal.PublicClientApplication(
            client_id=client_id,
            authority=authority,
            token_cache=self._cache,
        )

    async def start_auth(self, client_id: str, tenant_id: str) -> str:
        """
        Starts the device code authentication flow.
        Returns a flow_id to track the status.
        """
        app = self._get_app(client_id, tenant_id)

        # Initiate device flow
        flow = app.initiate_device_flow(scopes=GRAPH_SCOPES)

        if "error" in flow:
            raise OutlookServiceError(f"Failed to initiate device flow: {flow.get('error_description')}")

        flow_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()

        # Create a future to hold the result
        auth_result_future = loop.create_future()

        def run_auth():
            try:
                # This blocks until user authenticates or timeout
                result = app.acquire_token_by_device_flow(flow)
                if "error" in result:
                    loop.call_soon_threadsafe(auth_result_future.set_exception,
                                              OutlookAuthError(result.get("error_description")))
                else:
                    loop.call_soon_threadsafe(auth_result_future.set_result, result)
            except Exception as e:
                loop.call_soon_threadsafe(auth_result_future.set_exception, e)

        # Run in a separate thread to avoid blocking the async loop
        thread = threading.Thread(target=run_auth, daemon=True)
        thread.start()

        self._active_flows[flow_id] = {
            "flow": flow,
            "future": auth_result_future,
            "client_id": client_id,
            "tenant_id": tenant_id,
            "app": app
        }

        logger.info(f"Outlook Auth Started. Code: {flow['user_code']}")
        return flow_id

    async def get_auth_status(self, flow_id: str) -> dict[str, Any]:
        """
        Checks the status of an ongoing auth flow.
        """
        if flow_id not in self._active_flows:
            raise OutlookServiceError("Invalid flow ID")

        flow_data = self._active_flows[flow_id]
        future = flow_data["future"]

        if future.done():
            try:
                result = future.result()
                # Extract user info
                user_claims = result.get("id_token_claims", {})
                return {
                    "status": "authenticated",
                    "user": {
                        "email": user_claims.get("preferred_username") or user_claims.get("email"),
                        "id": user_claims.get("oid")
                    }
                }
            except Exception as e:
                return {"status": "error", "message": str(e)}

        # Not done, return code info
        msal_flow = flow_data["flow"]
        return {
            "status": "code_ready",
            "info": {
                "verification_uri": msal_flow["verification_uri"],
                "user_code": msal_flow["user_code"],
                "expires_on": msal_flow.get("expires_on"),
                "message": msal_flow.get("message")
            }
        }

    async def complete_auth(self, flow_id: str) -> dict[str, str]:
        """
        Finalizes auth, cleans up flow, returns account details.
        """
        status = await self.get_auth_status(flow_id)
        if status["status"] != "authenticated":
            raise OutlookServiceError("Authentication not complete")

        flow_data = self._active_flows[flow_id]
        user_data = status["user"]

        result = {
            "client_id": flow_data["client_id"],
            "tenant_id": flow_data["tenant_id"],
            "username": user_data["email"],
        }

        del self._active_flows[flow_id]
        return result

    async def fetch_messages(
        self, client_id: str, tenant_id: str, limit: int = 50, username: str | None = None
    ) -> list[Any]:
        """
        Fetches messages using a silent token acquisition.
        """
        app = self._get_app(client_id, tenant_id)
        accounts = app.get_accounts()

        if not accounts:
            raise OutlookAuthError("No accounts found in cache. Please sign in again.")

        account = None
        if username:
            # Try to find the specific account
            for acc in accounts:
                if acc.get("username", "").lower() == username.lower():
                    account = acc
                    break

        # Fallback to first account if not found or no username provided
        if not account:
            account = accounts[0]

        credential = MsalCredential(app, account)
        client = GraphServiceClient(credential, GRAPH_SCOPES)

        try:
            query_params = MessagesRequestBuilder.MessagesRequestBuilderGetQueryParameters(
                select=[
                    "id",
                    "from",
                    "isRead",
                    "receivedDateTime",
                    "subject",
                    "bodyPreview",
                    "body",
                ],
                top=limit,
                orderby=["receivedDateTime DESC"],
            )
            request_config = (
                MessagesRequestBuilder.MessagesRequestBuilderGetRequestConfiguration(
                    query_parameters=query_params
                )
            )

            response = (
                await client.me.mail_folders.by_mail_folder_id("inbox")
                .messages.get(request_configuration=request_config)
            )

            return response.value if response else []

        except Exception as e:
            if isinstance(e, OutlookAuthError):
                raise
            logger.exception("Outlook sync failed")
            raise OutlookServiceError(f"Sync failed: {e}") from e
