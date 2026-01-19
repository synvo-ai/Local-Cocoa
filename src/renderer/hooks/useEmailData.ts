import { useState, useCallback, useEffect } from 'react';
import type { EmailAccountSummary, EmailMessageSummary, EmailMessageContent, EmailAccountPayload } from '../types';

interface EmailSyncState {
    status: 'idle' | 'syncing' | 'ok' | 'error';
    message?: string | null;
    lastSyncedAt?: string | null;
}

export function useEmailData(emailAccounts: EmailAccountSummary[], refreshData: () => Promise<any>) {
    const [emailSyncStates, setEmailSyncStates] = useState<Record<string, EmailSyncState>>({});
    const [emailMessages, setEmailMessages] = useState<Record<string, EmailMessageSummary[]>>({});
    const [selectedEmailAccountId, setSelectedEmailAccountId] = useState<string | null>(null);
    const [selectedEmailMessageId, setSelectedEmailMessageId] = useState<string | null>(null);
    const [emailMessageCache, setEmailMessageCache] = useState<Record<string, EmailMessageContent>>({});
    const [loadingMessagesForAccount, setLoadingMessagesForAccount] = useState<string | null>(null);
    const [isEmailMessageLoading, setIsEmailMessageLoading] = useState(false);

    useEffect(() => {
        setEmailSyncStates((prev) => {
            const next: Record<string, EmailSyncState> = {};
            emailAccounts.forEach((account) => {
                const existing = prev[account.id];
                if (existing) {
                    next[account.id] = {
                        ...existing,
                        lastSyncedAt: account.lastSyncedAt ?? existing.lastSyncedAt ?? null
                    };
                } else {
                    next[account.id] = {
                        status: 'idle',
                        message: account.lastSyncStatus ?? null,
                        lastSyncedAt: account.lastSyncedAt ?? null
                    };
                }
            });
            return next;
        });
    }, [emailAccounts]);

    const handleAddEmailAccount = useCallback(
        async (payload: EmailAccountPayload) => {
            const api = window.api;
            if (!api?.addEmailAccount) {
                throw new Error('Email bridge unavailable.');
            }
            try {
                await api.addEmailAccount(payload);
                await refreshData();
            } catch (error) {
                throw error instanceof Error ? error : new Error('Unable to save email connector.');
            }
        },
        [refreshData]
    );

    const handleRemoveEmailAccount = useCallback(
        async (accountId: string) => {
            const api = window.api;
            if (!api?.removeEmailAccount) {
                throw new Error('Email bridge unavailable.');
            }
            try {
                await api.removeEmailAccount(accountId);
                setEmailSyncStates((prev) => {
                    const { [accountId]: _removed, ...rest } = prev;
                    return rest;
                });
                setEmailMessages((prev) => {
                    const { [accountId]: _removedMessages, ...rest } = prev;
                    return rest;
                });
                setEmailMessageCache((prev) => {
                    const next: Record<string, EmailMessageContent> = {};
                    for (const [messageId, content] of Object.entries(prev)) {
                        if (content.accountId !== accountId) {
                            next[messageId] = content;
                        }
                    }
                    return next;
                });
                setSelectedEmailAccountId((prev) => (prev === accountId ? null : prev));
                setSelectedEmailMessageId((prev) => (prev && emailMessageCache[prev]?.accountId === accountId ? null : prev));
                setIsEmailMessageLoading(false);
                setLoadingMessagesForAccount((prev) => (prev === accountId ? null : prev));
                await refreshData();
            } catch (error) {
                console.error('Failed to remove email connector', error);
                throw error instanceof Error ? error : new Error('Unable to remove email connector.');
            }
        },
        [emailMessageCache, refreshData]
    );

    const handleSyncEmailAccount = useCallback(
        async (accountId: string) => {
            const api = window.api;
            if (!api?.syncEmailAccount) {
                console.warn('Email sync bridge unavailable.');
                return;
            }
            setEmailSyncStates((prev) => ({
                ...prev,
                [accountId]: {
                    status: 'syncing',
                    message: null,
                    lastSyncedAt: prev[accountId]?.lastSyncedAt ?? null
                }
            }));
            try {
                const result = await api.syncEmailAccount(accountId);
                setEmailSyncStates((prev) => ({
                    ...prev,
                    [accountId]: {
                        status: 'ok',
                        message: result.message ?? 'Sync completed.',
                        lastSyncedAt: result.lastSyncedAt
                    }
                }));
                await refreshData();
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Sync failed.';
                setEmailSyncStates((prev) => ({
                    ...prev,
                    [accountId]: {
                        status: 'error',
                        message,
                        lastSyncedAt: prev[accountId]?.lastSyncedAt ?? null
                    }
                }));
            }
        },
        [refreshData]
    );

    const loadEmailMessages = useCallback(
        async (accountId: string, options?: { force?: boolean }) => {
            const api = window.api;
            if (!api?.listEmailMessages) return;
            if (!options?.force && emailMessages[accountId]) {
                return;
            }
            setLoadingMessagesForAccount(accountId);
            try {
                const items = await api.listEmailMessages(accountId, 50);
                setEmailMessages((prev) => ({ ...prev, [accountId]: items }));
            } catch (error) {
                console.error('Failed to load email messages', error);
            } finally {
                setLoadingMessagesForAccount((prev) => (prev === accountId ? null : prev));
            }
        },
        [emailMessages]
    );

    const handleSelectEmailAccountView = useCallback(
        async (accountId: string) => {
            setSelectedEmailAccountId(accountId);
            setSelectedEmailMessageId(null);
            setIsEmailMessageLoading(false);
            await loadEmailMessages(accountId);
        },
        [loadEmailMessages]
    );

    const handleRefreshEmailMessages = useCallback(
        async (accountId: string) => {
            await loadEmailMessages(accountId, { force: true });
        },
        [loadEmailMessages]
    );

    const handleSelectEmailMessage = useCallback(
        async (accountId: string, messageId: string) => {
            const api = window.api;
            setSelectedEmailAccountId(accountId);
            setSelectedEmailMessageId(messageId);
            if (emailMessageCache[messageId]) {
                return;
            }
            if (!api?.getEmailMessage) {
                return;
            }
            setIsEmailMessageLoading(true);
            try {
                const detail = await api.getEmailMessage(messageId);
                setEmailMessageCache((prev) => ({ ...prev, [messageId]: detail }));
            } catch (error) {
                console.error('Failed to load email message content', error);
            } finally {
                setIsEmailMessageLoading(false);
            }
        },
        [emailMessageCache]
    );

    const handleCloseEmailMessage = useCallback(() => {
        setSelectedEmailMessageId(null);
    }, []);

    useEffect(() => {
        // Removed auto-selection of first account to allow viewing the account list
    }, []);

    const handleOutlookConnected = useCallback(async (accountId: string) => {
        await refreshData();
        // Trigger initial sync
        await handleSyncEmailAccount(accountId);
    }, [refreshData, handleSyncEmailAccount]);

    return {
        emailAccounts,
        emailSyncStates,
        emailMessages,
        selectedEmailAccountId,
        selectedEmailMessageId,
        emailMessageCache,
        loadingMessagesForAccount,
        isEmailMessageLoading,
        handleAddEmailAccount,
        handleRemoveEmailAccount,
        handleSyncEmailAccount,
        handleSelectEmailAccountView,
        handleRefreshEmailMessages,
        handleSelectEmailMessage,
        handleCloseEmailMessage,
        handleOutlookConnected
    };
}
