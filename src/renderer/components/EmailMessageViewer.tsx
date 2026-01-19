import ReactMarkdown from 'react-markdown';
import type {
    EmailAccountSummary,
    EmailMessageContent,
    EmailMessageSummary
} from '../types';

export interface EmailSyncState {
    status: 'idle' | 'syncing' | 'ok' | 'error';
    message?: string | null;
    lastSyncedAt?: string | null;
}

interface EmailMessageViewerProps {
    accounts: EmailAccountSummary[];
    syncStates: Record<string, EmailSyncState>;
    selectedAccountId: string | null;
    onSelectAccount: (accountId: string) => void;
    onRefreshMessages: (accountId: string) => void;
    messagesByAccount: Record<string, EmailMessageSummary[]>;
    selectedMessageId: string | null;
    onSelectMessage: (accountId: string, messageId: string) => void;
    messageContent: EmailMessageContent | null;
    loadingAccountId: string | null;
    loadingMessage: boolean;
}

function formatRecipientList(recipients: string[]): string {
    if (!recipients.length) return 'Unknown recipients';
    if (recipients.length === 1) return recipients[0];
    return `${recipients[0]} +${recipients.length - 1}`;
}

export function EmailMessageViewer({
    accounts,
    syncStates,
    selectedAccountId,
    onSelectAccount,
    onRefreshMessages,
    messagesByAccount,
    selectedMessageId,
    onSelectMessage,
    messageContent,
    loadingAccountId,
    loadingMessage
}: EmailMessageViewerProps) {
    const EMAIL_LIST_LIMIT = 30;
    const activeMessages = selectedAccountId ? messagesByAccount[selectedAccountId] ?? [] : [];
    const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null;
    const hasAccounts = accounts.length > 0;
    const selectedMessage = selectedMessageId ? activeMessages.find((message) => message.id === selectedMessageId) ?? null : null;
    let visibleMessages = activeMessages.slice(0, EMAIL_LIST_LIMIT);
    if (selectedMessage && !visibleMessages.some((message) => message.id === selectedMessage.id)) {
        visibleMessages = [...visibleMessages.slice(0, Math.max(0, EMAIL_LIST_LIMIT - 1)), selectedMessage];
    }
    const hiddenCount = activeMessages.length > EMAIL_LIST_LIMIT ? activeMessages.length - EMAIL_LIST_LIMIT : 0;

    return (
        <div className="grid gap-4 lg:grid-cols-[260px,minmax(0,1fr),minmax(0,1.3fr)]">
            <div className="flex h-[740px] flex-col rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-white">Email sources</p>
                    {selectedAccountId ? (
                        <button
                            type="button"
                            onClick={() => onRefreshMessages(selectedAccountId)}
                            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100"
                        >
                            Refresh
                        </button>
                    ) : null}
                </div>
                <p className="mt-1 text-xs text-slate-300/80">
                    {hasAccounts ? 'Pick a connector to inspect its captured messages.' : 'No connectors yet — add one above to start ingestion.'}
                </p>
                <div className="mt-4 flex-1 space-y-2 overflow-y-auto pr-1">
                    {accounts.map((account) => {
                        const sync = syncStates[account.id];
                        const syncing = sync?.status === 'syncing' || loadingAccountId === account.id;
                        const badge = syncing
                            ? 'Syncing…'
                            : sync?.status === 'error'
                                ? 'Sync failed'
                                : sync?.status === 'ok'
                                    ? 'Up to date'
                                    : account.lastSyncStatus ?? 'Idle';
                        return (
                            <button
                                key={account.id}
                                type="button"
                                onClick={() => onSelectAccount(account.id)}
                                className={`w-full rounded-xl border px-3 py-3 text-left transition ${selectedAccountId === account.id
                                    ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-100'
                                    : 'border-white/10 bg-white/5 text-slate-200 hover:border-cyan-400/30 hover:text-cyan-100'
                                    }`}
                            >
                                <p className="text-sm font-semibold">{account.label}</p>
                                <p className="text-[11px] text-slate-300/70">
                                    {account.username} · {account.protocol.toUpperCase()} · {account.folderPath}
                                </p>
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide">
                                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-slate-200/90">
                                        {account.totalMessages} messages
                                    </span>
                                    <span
                                        className={`rounded-full px-2 py-0.5 font-semibold ${syncing
                                            ? 'border border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                                            : sync?.status === 'error'
                                                ? 'border border-rose-400/50 bg-rose-500/15 text-rose-100'
                                                : 'border border-white/15 bg-white/5 text-slate-200/80'
                                            }`}
                                    >
                                        {badge}
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex h-[740px] flex-col rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-white">Captured messages</p>
                    {selectedAccount ? (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-wide text-slate-300/80">
                            {selectedAccount.totalMessages} total · {selectedAccount.recentNewMessages} new
                        </span>
                    ) : null}
                </div>
                {selectedAccountId ? (
                    <>
                        <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
                            {loadingAccountId === selectedAccountId ? (
                                <p className="rounded-xl border border-dashed border-white/15 bg-slate-950/40 p-4 text-xs text-slate-300/80">
                                    Loading messages…
                                </p>
                            ) : visibleMessages.length ? (
                                visibleMessages.map((message) => {
                                    const sentLabel = message.sentAt
                                        ? new Date(message.sentAt).toLocaleString()
                                        : 'Unknown date';
                                    const preview = message.preview ?? 'No preview available.';
                                    return (
                                        <button
                                            key={message.id}
                                            type="button"
                                            onClick={() => onSelectMessage(message.accountId, message.id)}
                                            className={`w-full rounded-xl border px-3 py-3 text-left transition ${selectedMessageId === message.id
                                                ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-100'
                                                : 'border-white/10 bg-white/5 text-slate-200 hover:border-cyan-400/30 hover:text-cyan-100'
                                                }`}
                                        >
                                            <p className="text-sm font-semibold">
                                                {message.subject?.trim() || 'Untitled email'}
                                            </p>
                                            <p className="text-[11px] text-slate-300/70">
                                                {message.sender ?? 'Unknown sender'} · {formatRecipientList(message.recipients)}
                                            </p>
                                            <p className="text-[11px] text-slate-400/70">{sentLabel}</p>
                                            <p className="mt-2 line-clamp-2 text-xs text-slate-200/80">{preview}</p>
                                        </button>
                                    );
                                })
                            ) : (
                                <p className="rounded-xl border border-dashed border-white/15 bg-slate-950/40 p-4 text-xs text-slate-300/80">
                                    No messages indexed for this connector yet.
                                </p>
                            )}
                        </div>
                        {hiddenCount > 0 ? (
                            <p className="mt-3 rounded-xl border border-white/10 bg-slate-950/50 p-3 text-[11px] uppercase tracking-wide text-slate-400/80">
                                Showing first {EMAIL_LIST_LIMIT} messages · {hiddenCount} more not displayed.
                            </p>
                        ) : null}
                    </>
                ) : (
                    <p className="mt-3 rounded-xl border border-dashed border-white/15 bg-slate-950/40 p-4 text-xs text-slate-300/80">
                        Select a connector to load its messages.
                    </p>
                )}
            </div>

            <div className="flex h-[740px] flex-col rounded-2xl border border-white/10 bg-slate-950/70 p-4">
                <p className="text-sm font-semibold text-white">Message preview</p>
                {selectedMessageId ? (
                    loadingMessage ? (
                        <p className="mt-3 rounded-xl border border-dashed border-white/15 bg-slate-950/40 p-4 text-xs text-slate-300/80">
                            Loading message content…
                        </p>
                    ) : messageContent ? (
                        <div className="mt-3 flex-1 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/40 p-4 text-sm text-slate-100">
                            <p className="text-base font-semibold text-cyan-100">
                                {messageContent.subject?.trim() || 'Untitled email'}
                            </p>
                            <p className="mt-1 text-[11px] text-slate-300/80">
                                From {messageContent.sender ?? 'Unknown sender'} · To {formatRecipientList(messageContent.recipients)}
                            </p>
                            <p className="text-[11px] text-slate-400/80">
                                {messageContent.sentAt ? new Date(messageContent.sentAt).toLocaleString() : 'Unknown date'}
                            </p>
                            <div className="mt-4 prose prose-invert max-w-none text-sm leading-relaxed">
                                <ReactMarkdown>{messageContent.markdown || '*No content available.*'}</ReactMarkdown>
                            </div>
                        </div>
                    ) : (
                        <p className="mt-3 rounded-xl border border-dashed border-white/15 bg-slate-950/40 p-4 text-xs text-rose-200/80">
                            Unable to load message content.
                        </p>
                    )
                ) : (
                    <p className="mt-3 rounded-xl border border-dashed border-white/15 bg-slate-950/40 p-4 text-xs text-slate-300/80">
                        Choose a message to render its markdown preview.
                    </p>
                )}
            </div>
        </div>
    );
}
