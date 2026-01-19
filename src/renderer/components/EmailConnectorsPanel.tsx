import { useState, useEffect, useRef, useCallback } from 'react';
import { Mail, Trash2, RefreshCw, AlertCircle, CheckCircle2, Copy, ExternalLink, Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import type { EmailAccountPayload, EmailAccountSummary, IndexingItem } from '../types';

interface EmailSyncState {
    status: 'idle' | 'syncing' | 'ok' | 'error';
    message?: string | null;
    lastSyncedAt?: string | null;
}

interface EmailConnectorsPanelProps {
    accounts: EmailAccountSummary[];
    syncStates: Record<string, EmailSyncState>;
    pendingByAccount?: Record<string, IndexingItem[]>;
    onAdd: (payload: EmailAccountPayload) => Promise<void>;
    onRemove: (accountId: string) => Promise<void>;
    onSync: (accountId: string) => Promise<void>;
    onRescanIndex?: (folderId: string) => Promise<void>;
    onReindexIndex?: (folderId: string) => Promise<void>;
    onOutlookConnected?: (accountId: string) => Promise<void>;
    onSelectAccount?: (accountId: string) => void;
    isIndexing?: boolean;
    className?: string;
}

interface FormState {
    label: string;
    protocol: EmailAccountPayload['protocol'];
    host: string;
    port: number;
    username: string;
    password: string;
    useSsl: boolean;
    folder: string;
}

const DEFAULT_FORM: FormState = {
    label: '',
    protocol: 'imap',
    host: '',
    port: 993,
    username: '',
    password: '',
    useSsl: true,
    folder: 'INBOX'
};

export function EmailConnectorsPanel({
    accounts,
    syncStates,
    pendingByAccount = {},
    onAdd,
    onRemove,
    onSync,
    onOutlookConnected,
    onSelectAccount,
    className
}: EmailConnectorsPanelProps) {
    const [isAdding, setIsAdding] = useState(false);
    const [activeTab, setActiveTab] = useState<'standard' | 'outlook'>('standard');
    const [form, setForm] = useState<FormState>({ ...DEFAULT_FORM });
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Outlook State
    const [outlookClientId] = useState('f0f434e5-80fb-4db9-823c-36707ec98470');
    const [outlookTenantId] = useState('common');
    const [outlookLabel, setOutlookLabel] = useState('My Outlook');
    const [outlookFlowId, setOutlookFlowId] = useState<string | null>(null);
    const [outlookCode, setOutlookCode] = useState<string | null>(null);
    const [outlookUrl, setOutlookUrl] = useState<string | null>(null);
    const [outlookStatus, setOutlookStatus] = useState<'idle' | 'waiting_for_code' | 'code_ready' | 'authenticated' | 'error'>('idle');
    const isCompletingRef = useRef(false);

    const handleOutlookComplete = useCallback(async (flowId: string) => {
        if (isCompletingRef.current) return;
        isCompletingRef.current = true;
        try {
            const api = (window as any).api;
            const account = await api.completeOutlookSetup(flowId, outlookLabel);
            if (onOutlookConnected) {
                await onOutlookConnected(account.id);
            }
            setOutlookFlowId(null);
            setOutlookStatus('idle');
            setOutlookCode(null);
            setOutlookUrl(null);
            setIsAdding(false);
        } catch (e: any) {
            setError(e.message);
        } finally {
            isCompletingRef.current = false;
        }
    }, [outlookLabel, onOutlookConnected]);

    // Poll for Outlook status
    useEffect(() => {
        if (!outlookFlowId || outlookStatus === 'authenticated' || outlookStatus === 'error') return;

        const timer = setInterval(async () => {
            try {
                const api = (window as any).api;
                if (!api) return;
                
                const status = await api.getOutlookAuthStatus(outlookFlowId);
                if (status.status === 'code_ready') {
                    setOutlookCode(status.info.user_code);
                    setOutlookUrl(status.info.verification_uri);
                    setOutlookStatus('code_ready');
                } else if (status.status === 'authenticated') {
                    setOutlookStatus('authenticated');
                    // Auto-complete
                    await handleOutlookComplete(outlookFlowId);
                } else if (status.status === 'error') {
                    setOutlookStatus('error');
                    setError(status.message);
                }
            } catch (e) {
                console.error("Polling error", e);
            }
        }, 2000);

        return () => clearInterval(timer);
    }, [outlookFlowId, outlookStatus, handleOutlookComplete]);

    const handleOutlookStart = async () => {
        setError(null);
        setOutlookStatus('waiting_for_code');
        try {
            const api = (window as any).api;
            const res = await api.startOutlookAuth(outlookClientId, outlookTenantId);
            setOutlookFlowId(res.flow_id);
        } catch (e: any) {
            setError(e.message);
            setOutlookStatus('error');
        }
    };

    const handleChange = (field: keyof FormState, value: string | boolean | number) => {
        setForm((prev) => ({
            ...prev,
            [field]: value
        }));
    };

    const handleProtocolChange = (protocol: FormState['protocol']) => {
        const nextPort = protocol === 'imap' ? (form.useSsl ? 993 : 143) : form.useSsl ? 995 : 110;
        setForm((prev) => ({
            ...prev,
            protocol,
            port: prev.port === DEFAULT_FORM.port || prev.port === 993 || prev.port === 995 || prev.port === 143 || prev.port === 110 ? nextPort : prev.port,
            folder: protocol === 'imap' ? prev.folder || 'INBOX' : ''
        }));
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);

        if (!form.label.trim() || !form.host.trim() || !form.username.trim() || !form.password) {
            setError('Please complete the required fields.');
            return;
        }

        setIsSubmitting(true);
        try {
            await onAdd({
                label: form.label.trim(),
                protocol: form.protocol,
                host: form.host.trim(),
                port: Number(form.port),
                username: form.username.trim(),
                password: form.password,
                useSsl: form.useSsl,
                folder: form.protocol === 'imap' ? form.folder.trim() || 'INBOX' : undefined
            });
            setForm({ ...DEFAULT_FORM });
            setIsAdding(false);
        } catch (submitError) {
            const message = submitError instanceof Error ? submitError.message : 'Unable to save connector.';
            setError(message);
        } finally {
            setIsSubmitting(false);
        }
    };

    // When no accounts, show full-page empty state
    if (accounts.length === 0 && !isAdding) {
        return (
            <div className={cn("flex h-full flex-col items-center justify-center p-8", className)}>
                <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl bg-gradient-to-br from-[hsl(var(--card))] via-[hsl(var(--background))] to-[hsl(var(--muted))] p-12 text-center shadow-xl">
                    {/* Decorative background elements */}
                    <div className="absolute inset-0 overflow-hidden pointer-events-none">
                        {/* Floating mail icons */}
                        <div className="absolute top-6 left-8 opacity-[0.06] transform -rotate-12">
                            <Mail className="h-20 w-20" />
                        </div>
                        <div className="absolute top-12 right-16 opacity-[0.04] transform rotate-6">
                            <Mail className="h-14 w-14" />
                        </div>
                        <div className="absolute bottom-8 left-1/4 opacity-[0.03] transform rotate-12">
                            <Mail className="h-16 w-16" />
                        </div>
                        <div className="absolute bottom-16 right-8 opacity-[0.05] transform -rotate-6">
                            <Mail className="h-12 w-12" />
                        </div>
                        {/* Subtle gradient orbs */}
                        <div className="absolute -top-20 -right-20 w-56 h-56 bg-primary/10 rounded-full blur-3xl" />
                        <div className="absolute -bottom-24 -left-24 w-64 h-64 bg-primary/5 rounded-full blur-3xl" />
                    </div>
                    
                    <div className="relative z-10 flex flex-col items-center">
                        {/* Animated mail icon with glow */}
                        <div className="relative mb-8 group">
                            <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl scale-150 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                            <div className="relative p-5 bg-gradient-to-br from-primary/90 to-primary rounded-2xl shadow-lg transform transition-all duration-300 hover:scale-105 hover:shadow-xl hover:-rotate-3">
                                <Mail className="h-9 w-9 text-primary-foreground" />
                            </div>
                            {/* Decorative rings */}
                            <div className="absolute -inset-2.5 border-2 border-primary/20 rounded-[1.25rem] animate-pulse" style={{ animationDuration: '3s' }} />
                            <div className="absolute -inset-5 border border-primary/10 rounded-[1.5rem]" />
                        </div>
                        
                        {/* Content */}
                        <h2 className="text-2xl font-bold text-foreground tracking-tight mb-2">
                            Connect Your Email
                        </h2>
                        <p className="text-muted-foreground max-w-md mb-8 leading-relaxed">
                            Link your email accounts to unlock powerful search and organization features across all your messages.
                        </p>
                        
                        {/* CTA Button with enhanced styling */}
                        <button
                            onClick={() => setIsAdding(true)}
                            className="group relative inline-flex items-center justify-center overflow-hidden rounded-xl text-sm font-semibold transition-all duration-300 bg-primary text-primary-foreground shadow-lg hover:shadow-xl hover:scale-105 h-12 px-8"
                        >
                            <span className="absolute inset-0 bg-gradient-to-r from-primary via-primary/80 to-primary opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                            <span className="relative flex items-center gap-2">
                                <Plus className="h-5 w-5 transition-transform duration-300 group-hover:rotate-90" />
                                Add Your First Connector
                            </span>
                        </button>
                        
                        {/* Feature hints */}
                        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 mt-10 text-sm text-muted-foreground">
                            <div className="flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-primary/70" />
                                <span>IMAP & POP3</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-primary/70" />
                                <span>Microsoft Outlook</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-primary/70" />
                                <span>Secure & Private</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={cn("flex h-full flex-col gap-6 max-w-5xl mx-auto overflow-y-auto pb-8", className)}>
            <div className="flex items-center justify-between pb-2">
                <div className="space-y-1">
                    <h2 className="text-2xl font-bold tracking-tight">
                        Email Connectors
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        Manage your email integrations for indexing.
                    </p>
                </div>
                <button
                    onClick={() => setIsAdding(true)}
                    className="group inline-flex items-center justify-center rounded-xl text-sm font-medium transition-all duration-200 bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-105 hover:shadow-lg h-10 px-5 shadow-md"
                >
                    <Plus className="mr-2 h-4 w-4 transition-transform duration-200 group-hover:rotate-90" />
                    Add Connector
                </button>
            </div>

            {isAdding && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="relative w-full max-w-2xl rounded-lg border bg-background shadow-2xl max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200">
                        <div className="flex items-center justify-between p-4 border-b">
                            <h3 className="text-lg font-semibold">Add Email Connector</h3>
                            <button
                                onClick={() => setIsAdding(false)}
                                className="p-2 hover:bg-muted rounded-full transition-colors"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        
                        <div className="flex border-b bg-muted/40 shrink-0">
                            <button
                                onClick={() => setActiveTab('standard')}
                                className={cn(
                                    "flex-1 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px text-center",
                                    activeTab === 'standard' 
                                        ? "border-primary text-foreground bg-background" 
                                        : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60"
                                )}
                            >
                                Standard (IMAP/POP3)
                            </button>
                            <button
                                onClick={() => setActiveTab('outlook')}
                                className={cn(
                                    "flex-1 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px text-center",
                                    activeTab === 'outlook' 
                                        ? "border-primary text-foreground bg-background" 
                                        : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60"
                                )}
                            >
                                Microsoft Outlook
                            </button>
                        </div>

                        <div className="p-6 overflow-y-auto">
                            {activeTab === 'standard' ? (
                                <form onSubmit={handleSubmit} className="space-y-6">
                                    <div>
                                        <h3 className="text-base font-medium">Connection Details</h3>
                                        <p className="text-sm text-muted-foreground">Enter your mail server details manually.</p>
                                    </div>
                                    <div className="grid gap-6 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium leading-none">Label</label>
                                            <input
                                                type="text"
                                                required
                                                value={form.label}
                                                onChange={(event) => handleChange('label', event.target.value)}
                                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                                placeholder="Work mailbox"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium leading-none">Protocol</label>
                                            <select
                                                value={form.protocol}
                                                onChange={(event) => handleProtocolChange(event.target.value as FormState['protocol'])}
                                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                <option value="imap">IMAP</option>
                                                <option value="pop3">POP3</option>
                                            </select>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium leading-none">Hostname</label>
                                            <input
                                                type="text"
                                                required
                                                value={form.host}
                                                onChange={(event) => handleChange('host', event.target.value)}
                                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                                placeholder="imap.mailserver.com"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium leading-none">Port</label>
                                            <input
                                                type="number"
                                                required
                                                min={1}
                                                max={65535}
                                                value={form.port}
                                                onChange={(event) => handleChange('port', Number(event.target.value))}
                                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium leading-none">Username</label>
                                            <input
                                                type="text"
                                                required
                                                value={form.username}
                                                onChange={(event) => handleChange('username', event.target.value)}
                                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                                placeholder="name@example.com"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium leading-none">Password</label>
                                            <input
                                                type="password"
                                                required
                                                value={form.password}
                                                onChange={(event) => handleChange('password', event.target.value)}
                                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                            />
                                        </div>
                                        <div className="flex items-center space-x-2 pt-8">
                                            <input
                                                type="checkbox"
                                                id="useSsl"
                                                checked={form.useSsl}
                                                onChange={(event) => {
                                                    const nextUseSsl = event.target.checked;
                                                    const nextPort = form.protocol === 'imap' ? (nextUseSsl ? 993 : 143) : nextUseSsl ? 995 : 110;
                                                    setForm((prev) => ({
                                                        ...prev,
                                                        useSsl: nextUseSsl,
                                                        port: prev.port === 993 || prev.port === 143 || prev.port === 995 || prev.port === 110 ? nextPort : prev.port
                                                    }));
                                                }}
                                                className="h-4 w-4 rounded border-primary text-primary focus:ring-primary"
                                            />
                                            <label htmlFor="useSsl" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                                                Use SSL/TLS
                                            </label>
                                        </div>
                                        {form.protocol === 'imap' && (
                                            <div className="space-y-2">
                                                <label className="text-sm font-medium leading-none">Folder</label>
                                                <input
                                                    type="text"
                                                    value={form.folder}
                                                    onChange={(event) => handleChange('folder', event.target.value)}
                                                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                                    placeholder="INBOX"
                                                />
                                            </div>
                                        )}
                                    </div>
                                    {error && (
                                        <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive flex items-center gap-2">
                                            <AlertCircle className="h-4 w-4" />
                                            {error}
                                        </div>
                                    )}
                                    <div className="flex justify-end gap-2 pt-4 border-t">
                                        <button
                                            type="button"
                                            onClick={() => setIsAdding(false)}
                                            disabled={isSubmitting}
                                            className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={isSubmitting}
                                            className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
                                        >
                                            {isSubmitting ? 'Saving...' : 'Save Connector'}
                                        </button>
                                    </div>
                                </form>
                            ) : (
                                <div className="space-y-6 max-w-xl mx-auto py-4">
                                    <div className="text-center space-y-2">
                                        <h3 className="text-lg font-medium">Connect Outlook</h3>
                                        <p className="text-sm text-muted-foreground">Securely connect your Microsoft account using OAuth.</p>
                                    </div>

                                    {outlookStatus === 'idle' || outlookStatus === 'error' ? (
                                        <div className="space-y-4">
                                            <div className="space-y-2">
                                                <label className="text-sm font-medium leading-none">Account Label</label>
                                                <input
                                                    type="text"
                                                    value={outlookLabel}
                                                    onChange={(e) => setOutlookLabel(e.target.value)}
                                                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                                    placeholder="My Outlook"
                                                />
                                            </div>
                                            {outlookStatus === 'error' && error && (
                                                <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive flex items-center gap-2">
                                                    <AlertCircle className="h-4 w-4" />
                                                    {error}
                                                </div>
                                            )}
                                            <button
                                                onClick={handleOutlookStart}
                                                className="w-full inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-[#0078D4] text-white shadow hover:bg-[#0078D4]/90 h-10 px-4 py-2"
                                            >
                                                <ExternalLink className="mr-2 h-4 w-4" />
                                                Sign in with Microsoft
                                            </button>
                                        </div>
                                    ) : outlookStatus === 'waiting_for_code' ? (
                                        <div className="flex flex-col items-center justify-center py-8 space-y-4">
                                            <RefreshCw className="h-8 w-8 animate-spin text-primary" />
                                            <p className="text-sm text-muted-foreground">Initializing authentication...</p>
                                        </div>
                                    ) : outlookStatus === 'code_ready' && outlookCode && outlookUrl ? (
                                        <div className="rounded-lg border bg-card p-6 space-y-6 shadow-sm">
                                            <div className="flex items-start gap-4">
                                                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-full">
                                                    <ExternalLink className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-medium">Action Required</h4>
                                                    <p className="text-sm text-muted-foreground">
                                                        Visit the Microsoft verification page and enter the code below to authorize the application.
                                                    </p>
                                                </div>
                                            </div>
                                            
                                            <div className="flex flex-col gap-4 bg-muted/50 p-4 rounded-md border">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Verification URL</span>
                                                    <a 
                                                        href={outlookUrl} 
                                                        target="_blank" 
                                                        rel="noreferrer"
                                                        className="text-sm font-medium text-blue-600 hover:underline flex items-center gap-1"
                                                    >
                                                        {outlookUrl}
                                                        <ExternalLink className="h-3 w-3" />
                                                    </a>
                                                </div>
                                                <div className="flex items-center justify-between pt-4 border-t border-dashed">
                                                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Code</span>
                                                    <div className="flex items-center gap-2">
                                                        <code className="text-xl font-mono font-bold tracking-wider bg-background px-3 py-1 rounded border">
                                                            {outlookCode}
                                                        </code>
                                                        <button 
                                                            onClick={() => navigator.clipboard.writeText(outlookCode)}
                                                            className="p-2 hover:bg-background rounded-md transition-colors"
                                                            title="Copy code"
                                                        >
                                                            <Copy className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground animate-pulse">
                                                <RefreshCw className="h-4 w-4 animate-spin" />
                                                Waiting for completion...
                                            </div>
                                        </div>
                                    ) : outlookStatus === 'authenticated' ? (
                                        <div className="flex flex-col items-center justify-center py-8 space-y-4 text-green-600 dark:text-green-400">
                                            <CheckCircle2 className="h-16 w-16" />
                                            <div className="text-center">
                                                <h3 className="text-lg font-medium">Successfully Connected!</h3>
                                                <p className="text-sm text-muted-foreground">Your Outlook account has been added.</p>
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {accounts.map((account) => {
                    const syncState = syncStates[account.id] ?? { status: 'idle' as const };
                    const syncing = syncState.status === 'syncing';
                    const accountPending = pendingByAccount[account.id] ?? [];
                    const processingCount = accountPending.filter((item) => item.status === 'processing').length;
                    const pendingCount = accountPending.filter((item) => item.status === 'pending').length;
                    
                    return (
                        <div
                            key={account.id}
                            className="group relative rounded-lg border bg-card p-5 shadow-sm transition-all hover:shadow-md cursor-pointer hover:border-primary/50"
                            onClick={() => onSelectAccount?.(account.id)}
                        >
                            <div className="flex items-start justify-between mb-4 gap-2">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className={cn(
                                        "p-2.5 rounded-full shrink-0",
                                        account.protocol === 'outlook'
                                            ? "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                                            : "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400"
                                    )}>
                                        <Mail className="h-5 w-5" />
                                    </div>
                                    <div className="min-w-0">
                                        <h3 className="font-semibold leading-none truncate" title={account.label}>{account.label}</h3>
                                        <p className="text-xs text-muted-foreground mt-1 truncate" title={account.username}>{account.username}</p>
                                    </div>
                                </div>
                                <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onSync(account.id);
                                        }}
                                        disabled={syncing}
                                        className="p-2 hover:bg-accent rounded-md text-muted-foreground hover:text-foreground transition-colors"
                                        title="Sync now"
                                    >
                                        <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
                                    </button>
                                    <button
                                        onClick={async (e) => {
                                            e.stopPropagation();
                                            if (window.confirm(`Remove connector “${account.label}”?`)) {
                                                // Optimistic update handled by parent or we can force a state update here if needed
                                                // But usually onRemove is async and we await it.
                                                // To improve UX, we can show a deleting state on the button itself.
                                                const btn = document.activeElement as HTMLButtonElement;
                                                if (btn) {
                                                    btn.disabled = true;
                                                    btn.innerHTML = '<svg class="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
                                                }
                                                try {
                                                    await onRemove(account.id);
                                                } catch (e) {
                                                    console.error("Failed to remove account", e);
                                                    if (btn) {
                                                        btn.disabled = false;
                                                        // Restore icon (Trash2)
                                                        btn.innerHTML = '<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
                                                    }
                                                }
                                            }
                                        }}
                                        className="p-2 hover:bg-destructive/10 rounded-md text-muted-foreground hover:text-destructive transition-colors"
                                        title="Remove"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-muted-foreground">Messages</span>
                                    <span className="font-medium">{account.totalMessages.toLocaleString()}</span>
                                </div>
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-muted-foreground">Last Sync</span>
                                    <span className="font-medium">
                                        {account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleDateString() : 'Never'}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-muted-foreground">Status</span>
                                    <span className={cn(
                                        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
                                        syncState.status === 'error' 
                                            ? "bg-destructive/10 text-destructive"
                                            : syncState.status === 'ok'
                                                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                                : "bg-secondary text-secondary-foreground"
                                    )}>
                                        {syncing ? (
                                            <>
                                                <RefreshCw className="h-3 w-3 animate-spin" />
                                                <span>
                                                    Syncing
                                                    {(processingCount > 0 || pendingCount > 0) && ` (${processingCount + pendingCount})`}
                                                </span>
                                            </>
                                        ) : syncState.status === 'error' ? (
                                            <>
                                                <AlertCircle className="h-3 w-3" />
                                                Error
                                            </>
                                        ) : (
                                            <>
                                                <CheckCircle2 className="h-3 w-3" />
                                                {syncState.status === 'ok' ? 'Healthy' : 'Idle'}
                                            </>
                                        )}
                                    </span>
                                </div>
                            </div>

                            {(processingCount > 0 || pendingCount > 0) && (
                                <div className="mt-4 pt-4 border-t">
                                    <div className="flex flex-col gap-1">
                                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                                            <span className="flex items-center gap-1.5">
                                                <RefreshCw className="h-3 w-3 animate-spin" />
                                                Indexing in progress...
                                            </span>
                                            <span>{Math.round((processingCount / (processingCount + pendingCount || 1)) * 100)}%</span>
                                        </div>
                                        <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                                            <div 
                                                className="h-full bg-primary transition-all duration-500 ease-out"
                                                style={{ width: `${Math.round((processingCount / (processingCount + pendingCount || 1)) * 100)}%` }}
                                            />
                                        </div>
                                        <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                                            <span>{processingCount} processing</span>
                                            <span>{pendingCount} pending</span>
                                        </div>
                                    </div>
                                </div>
                            )}
                            
                            {syncState.status === 'error' && syncState.message && (
                                <div className="mt-4 pt-4 border-t">
                                    <p className="text-xs text-destructive truncate" title={syncState.message}>
                                        {syncState.message}
                                    </p>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
