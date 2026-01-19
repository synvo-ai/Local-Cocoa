/**
 * MCPConnectionPanel - Manages MCP (Model Context Protocol) connections
 * 
 * Allows users to:
 * - View MCP server status
 * - Install/uninstall MCP config to Claude Desktop
 * - See and manage connected external agents (with persistent API keys)
 * - Copy configuration for manual setup
 */

import { useState, useEffect, useCallback } from 'react';
import { 
    Link2, 
    CheckCircle2, 
    AlertCircle, 
    Copy, 
    ExternalLink, 
    RefreshCw,
    Unplug,
    Plug,
    Terminal,
    FileJson,
    Sparkles,
    Key,
    Trash2,
    Plus,
    Clock,
    Shield
} from 'lucide-react';
import { cn } from '../lib/utils';

interface MCPStatus {
    initialized: boolean;
    running: boolean;
    pythonPath: string | null;
    serverPath: string | null;
}

interface MCPConnection {
    name: string;
    key: string;
    createdAt: string;
    lastUsedAt: string | null;
    isActive: boolean;
}

interface MCPConnectionPanelProps {
    className?: string;
}

export function MCPConnectionPanel({ className }: MCPConnectionPanelProps) {
    const [status, setStatus] = useState<MCPStatus | null>(null);
    const [isInstalled, setIsInstalled] = useState<boolean>(false);
    const [configPath, setConfigPath] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [installing, setInstalling] = useState(false);
    const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
    
    // Connections management
    const [connections, setConnections] = useState<MCPConnection[]>([]);
    const [newConnectionName, setNewConnectionName] = useState<string>('');
    const [showNewConnection, setShowNewConnection] = useState<boolean>(false);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);

    const loadConnections = useCallback(async () => {
        try {
            const conns = await window.api.mcpListConnections?.();
            setConnections(conns || []);
        } catch (error) {
            console.error('Failed to load connections:', error);
        }
    }, []);

    const loadStatus = useCallback(async () => {
        setLoading(true);
        try {
            const [mcpStatus, installed, path] = await Promise.all([
                window.api.mcpGetStatus?.(),
                window.api.mcpIsInstalled?.(),
                window.api.mcpGetClaudeConfigPath?.()
            ]);
            setStatus(mcpStatus || null);
            setIsInstalled(installed || false);
            setConfigPath(path || '');
            // Also load connections
            await loadConnections();
        } catch (error) {
            console.error('Failed to load MCP status:', error);
        } finally {
            setLoading(false);
        }
    }, [loadConnections]);

    useEffect(() => {
        loadStatus();
    }, [loadStatus]);

    const showNotification = (message: string, type: 'success' | 'error' | 'info') => {
        setNotification({ message, type });
        setTimeout(() => setNotification(null), 4000);
    };

    const handleInstall = async () => {
        setInstalling(true);
        try {
            const result = await window.api.mcpInstallToClaude?.();
            if (result?.success) {
                showNotification('MCP successfully installed to Claude Desktop! Please restart Claude Desktop.', 'success');
                setIsInstalled(true);
                // Reload connections to show the new Claude Desktop key
                await loadConnections();
            } else {
                showNotification(result?.error || 'Failed to install MCP', 'error');
            }
        } catch (error) {
            showNotification(error instanceof Error ? error.message : 'Failed to install', 'error');
        } finally {
            setInstalling(false);
        }
    };

    const handleUninstall = async () => {
        if (!confirm('Are you sure you want to remove MCP from Claude Desktop? This will also revoke the API key.')) {
            return;
        }
        
        setInstalling(true);
        try {
            const result = await window.api.mcpUninstallFromClaude?.();
            if (result?.success) {
                showNotification('MCP removed from Claude Desktop. Please restart Claude Desktop.', 'success');
                setIsInstalled(false);
                // Reload connections to remove the Claude Desktop key
                await loadConnections();
            } else {
                showNotification(result?.error || 'Failed to remove MCP', 'error');
            }
        } catch (error) {
            showNotification(error instanceof Error ? error.message : 'Failed to uninstall', 'error');
        } finally {
            setInstalling(false);
        }
    };

    const handleCreateConnection = async () => {
        if (!newConnectionName.trim()) {
            showNotification('Please enter a name for the connection', 'error');
            return;
        }
        try {
            const result = await window.api.mcpCreateConnection?.(newConnectionName.trim());
            if (result?.success) {
                showNotification(`API key created for "${newConnectionName}"`, 'success');
                setNewConnectionName('');
                setShowNewConnection(false);
                await loadConnections();
            } else {
                showNotification(result?.error || 'Failed to create connection', 'error');
            }
        } catch (error) {
            showNotification(error instanceof Error ? error.message : 'Failed to create', 'error');
        }
    };

    const handleRevokeConnection = async (key: string, name: string) => {
        if (!confirm(`Are you sure you want to revoke the API key for "${name}"? This app will no longer be able to access Local Cocoa.`)) {
            return;
        }
        try {
            const result = await window.api.mcpRevokeConnection?.(key);
            if (result?.success) {
                showNotification(`API key for "${name}" has been revoked`, 'success');
                await loadConnections();
            } else {
                showNotification(result?.error || 'Failed to revoke', 'error');
            }
        } catch (error) {
            showNotification(error instanceof Error ? error.message : 'Failed to revoke', 'error');
        }
    };

    const handleCopyKey = async (key: string) => {
        await navigator.clipboard.writeText(key);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
    };

    const formatDate = (dateStr: string | null | undefined) => {
        if (!dateStr) return 'Never';
        const date = new Date(dateStr);
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const handleCopyConfig = async () => {
        try {
            const configJson = await window.api.mcpCopyConfig?.();
            if (configJson) {
                await navigator.clipboard.writeText(configJson);
                showNotification('Configuration copied to clipboard!', 'info');
            }
        } catch (error) {
            showNotification('Failed to copy configuration', 'error');
        }
    };

    const handleOpenConfig = async () => {
        try {
            await window.api.mcpOpenClaudeConfig?.();
        } catch (error) {
            showNotification('Failed to open config file', 'error');
        }
    };

    const openMCPDocs = () => {
        window.api?.openExternal?.('https://modelcontextprotocol.io/introduction');
    };

    return (
        <div className={cn("space-y-6", className)}>
            {/* Notification */}
            {notification && (
                <div className={cn(
                    "flex items-center gap-2 px-4 py-3 rounded-lg text-sm",
                    notification.type === 'success' && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20",
                    notification.type === 'error' && "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20",
                    notification.type === 'info' && "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                )}>
                    {notification.type === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                    {notification.type === 'error' && <AlertCircle className="h-4 w-4 shrink-0" />}
                    {notification.type === 'info' && <Sparkles className="h-4 w-4 shrink-0" />}
                    <span>{notification.message}</span>
                </div>
            )}

            {/* Header Card */}
            <div className="rounded-xl border bg-gradient-to-br from-card to-card/50 p-6">
                <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                        <div className="p-3 rounded-xl bg-gradient-to-br from-violet-500/20 to-purple-500/10">
                            <Link2 className="h-6 w-6 text-violet-500" />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold">MCP Server</h3>
                            <p className="text-sm text-muted-foreground mt-1 max-w-md">
                                Model Context Protocol enables external AI agents like Claude Desktop to access your Local Cocoa knowledge base securely.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={loadStatus}
                        disabled={loading}
                        className="p-2 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                    >
                        <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                    </button>
                </div>

                {/* Status Indicators */}
                <div className="mt-6 grid grid-cols-2 gap-4">
                    <div className="rounded-lg bg-muted/30 p-4">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Terminal className="h-4 w-4" />
                            <span>Server Status</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                            <span className={cn(
                                "h-2.5 w-2.5 rounded-full",
                                status?.initialized ? "bg-emerald-500" : "bg-amber-500"
                            )} />
                            <span className="text-sm font-medium">
                                {loading ? 'Checking...' : status?.initialized ? 'Ready' : 'Not Initialized'}
                            </span>
                        </div>
                    </div>

                    <div className="rounded-lg bg-muted/30 p-4">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Sparkles className="h-4 w-4" />
                            <span>Claude Desktop</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                            <span className={cn(
                                "h-2.5 w-2.5 rounded-full",
                                isInstalled ? "bg-emerald-500" : "bg-gray-400"
                            )} />
                            <span className="text-sm font-medium">
                                {loading ? 'Checking...' : isInstalled ? 'Connected' : 'Not Connected'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Claude Desktop Integration */}
            <div className="rounded-xl border bg-card p-6">
                <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-lg bg-muted">
                        <Sparkles className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                        <h4 className="font-medium">Claude Desktop Integration</h4>
                        <p className="text-xs text-muted-foreground">
                            Connect Claude Desktop to search and ask questions from your indexed files
                        </p>
                    </div>
                </div>

                <div className="space-y-4">
                    {/* Connection Status */}
                    <div className={cn(
                        "flex items-center justify-between p-4 rounded-lg border",
                        isInstalled 
                            ? "bg-emerald-500/5 border-emerald-500/20" 
                            : "bg-muted/30 border-border"
                    )}>
                        <div className="flex items-center gap-3">
                            {isInstalled ? (
                                <Plug className="h-5 w-5 text-emerald-500" />
                            ) : (
                                <Unplug className="h-5 w-5 text-muted-foreground" />
                            )}
                            <div>
                                <p className="text-sm font-medium">
                                    {isInstalled ? 'Connected to Claude Desktop' : 'Not Connected'}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {isInstalled 
                                        ? 'Claude can access your Local Cocoa knowledge base' 
                                        : 'Click to enable Claude Desktop integration'
                                    }
                                </p>
                            </div>
                        </div>

                        {isInstalled ? (
                            <button
                                onClick={handleUninstall}
                                disabled={installing}
                                className="px-4 py-2 rounded-lg text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                            >
                                {installing ? 'Removing...' : 'Disconnect'}
                            </button>
                        ) : (
                            <button
                                onClick={handleInstall}
                                disabled={installing}
                                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                            >
                                {installing ? 'Installing...' : 'Connect'}
                            </button>
                        )}
                    </div>

                    {/* Quick Actions */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleCopyConfig}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors"
                        >
                            <Copy className="h-3.5 w-3.5" />
                            Copy Config
                        </button>
                        <button
                            onClick={handleOpenConfig}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors"
                        >
                            <FileJson className="h-3.5 w-3.5" />
                            Open Config File
                        </button>
                        <button
                            onClick={openMCPDocs}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            MCP Documentation
                        </button>
                    </div>
                </div>
            </div>

            {/* Connected Apps */}
            <div className="rounded-xl border bg-card p-6">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-muted">
                            <Key className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div>
                            <h4 className="font-medium">Connected Apps</h4>
                            <p className="text-xs text-muted-foreground">
                                External applications with API access to Local Cocoa
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => setShowNewConnection(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        New Connection
                    </button>
                </div>

                {/* New Connection Form */}
                {showNewConnection && (
                    <div className="mb-4 p-4 rounded-lg bg-muted/30 border border-dashed">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={newConnectionName}
                                onChange={(e) => setNewConnectionName(e.target.value)}
                                placeholder="App name (e.g., my-custom-agent)"
                                className="flex-1 px-3 py-2 rounded-lg text-sm bg-background border focus:outline-none focus:ring-2 focus:ring-primary/50"
                                onKeyDown={(e) => e.key === 'Enter' && handleCreateConnection()}
                            />
                            <button
                                onClick={handleCreateConnection}
                                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                            >
                                Create
                            </button>
                            <button
                                onClick={() => {
                                    setShowNewConnection(false);
                                    setNewConnectionName('');
                                }}
                                className="px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                            This will create an API key that external apps can use to connect to Local Cocoa.
                        </p>
                    </div>
                )}

                {/* Connections List */}
                {connections.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground">
                        <Shield className="h-10 w-10 mx-auto mb-3 opacity-50" />
                        <p className="text-sm">No external apps connected</p>
                        <p className="text-xs mt-1">Create an API key to allow external apps to access Local Cocoa</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {connections.map((conn) => (
                            <div 
                                key={conn.key} 
                                className={cn(
                                    "flex items-center justify-between p-4 rounded-lg border",
                                    conn.isActive ? "bg-muted/20" : "bg-muted/50 opacity-60"
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "p-2 rounded-lg",
                                        conn.name === 'claude-desktop' 
                                            ? "bg-violet-500/10 text-violet-500" 
                                            : "bg-muted text-muted-foreground"
                                    )}>
                                        {conn.name === 'claude-desktop' ? (
                                            <Sparkles className="h-4 w-4" />
                                        ) : (
                                            <Link2 className="h-4 w-4" />
                                        )}
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium flex items-center gap-2">
                                            {conn.name}
                                            {!conn.isActive && (
                                                <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                                    Revoked
                                                </span>
                                            )}
                                        </p>
                                        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                                            <span className="flex items-center gap-1">
                                                <Clock className="h-3 w-3" />
                                                Created: {formatDate(conn.createdAt)}
                                            </span>
                                            {conn.lastUsedAt && (
                                                <span>Last used: {formatDate(conn.lastUsedAt)}</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => handleCopyKey(conn.key)}
                                        className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors"
                                        title="Copy API key"
                                    >
                                        {copiedKey === conn.key ? (
                                            <span className="text-emerald-500">Copied!</span>
                                        ) : (
                                            <Copy className="h-3.5 w-3.5" />
                                        )}
                                    </button>
                                    {conn.isActive && (
                                        <button
                                            onClick={() => handleRevokeConnection(conn.key, conn.name)}
                                            className="px-3 py-1.5 rounded-lg text-xs text-destructive hover:bg-destructive/10 transition-colors"
                                            title="Revoke access"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <p className="mt-4 text-xs text-muted-foreground">
                    <strong>Note:</strong> Private files are never exposed to external apps. Only normal files are accessible.
                </p>
            </div>

            {/* Capabilities */}
            <div className="rounded-xl border bg-card p-6">
                <h4 className="font-medium mb-4">Available Capabilities</h4>
                <p className="text-xs text-muted-foreground mb-4">
                    When connected, Claude Desktop can use these tools from Local Cocoa:
                </p>
                <div className="grid grid-cols-2 gap-3">
                    {[
                        { name: 'Semantic Search', desc: 'Search across all indexed files' },
                        { name: 'Ask Questions', desc: 'RAG-powered Q&A from your documents' },
                        { name: 'Browse Files', desc: 'List and read indexed file contents' },
                        { name: 'Manage Notes', desc: 'Create, read, update, delete notes' },
                        { name: 'View Folders', desc: 'List monitored folders and their files' },
                        { name: 'Index Status', desc: 'Check indexing progress and stats' },
                    ].map((cap) => (
                        <div key={cap.name} className="flex items-start gap-2 p-3 rounded-lg bg-muted/30">
                            <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-sm font-medium">{cap.name}</p>
                                <p className="text-xs text-muted-foreground">{cap.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Technical Details (Collapsible) */}
            <details className="rounded-xl border bg-card">
                <summary className="px-6 py-4 cursor-pointer text-sm font-medium hover:bg-muted/30 transition-colors">
                    Technical Details
                </summary>
                <div className="px-6 pb-6 space-y-3 text-xs text-muted-foreground">
                    <div className="flex items-center justify-between py-2 border-b border-border/50">
                        <span>Config Path</span>
                        <code className="px-2 py-1 rounded bg-muted text-[10px]">{configPath || 'N/A'}</code>
                    </div>
                    <div className="flex items-center justify-between py-2 border-b border-border/50">
                        <span>Python Path</span>
                        <code className="px-2 py-1 rounded bg-muted text-[10px] max-w-[300px] truncate">
                            {status?.pythonPath || 'N/A'}
                        </code>
                    </div>
                    <div className="flex items-center justify-between py-2">
                        <span>Server Module</span>
                        <code className="px-2 py-1 rounded bg-muted text-[10px] max-w-[300px] truncate">
                            {status?.serverPath || 'N/A'}
                        </code>
                    </div>
                </div>
            </details>
        </div>
    );
}

