import { useState, useEffect, useCallback } from 'react';
import { Package, Download, Trash2, Power, PowerOff, Upload, CheckCircle2, AlertCircle, ExternalLink, Puzzle, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';

interface PluginInfo {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    status: 'installed' | 'loading' | 'active' | 'error' | 'disabled';
    error?: string;
    category?: string;
}

interface PluginUIEntry {
    id: string;
    label: string;
    icon?: string;
    type?: 'primary' | 'secondary' | 'settings';
    parentId?: string;
    pluginId: string;
}

export function PluginsPanel() {
    const [plugins, setPlugins] = useState<PluginInfo[]>([]);
    const [uiEntries, setUIEntries] = useState<PluginUIEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [installing, setInstalling] = useState(false);
    const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
    
    const loadPlugins = useCallback(async () => {
        setLoading(true);
        try {
            const [pluginList, entries] = await Promise.all([
                window.api.listPlugins?.() ?? [],
                window.api.getPluginUIEntries?.() ?? []
            ]);
            setPlugins(pluginList);
            setUIEntries(entries);
        } catch (error) {
            console.error('Failed to load plugins:', error);
        } finally {
            setLoading(false);
        }
    }, []);
    
    useEffect(() => {
        loadPlugins();
        
        // Subscribe to plugin events
        const unsubscribe = window.api.onPluginEvent?.((event) => {
            if (event.type === 'plugin-loaded' || event.type === 'plugin-unloaded' || event.type === 'plugin-error') {
                loadPlugins();
            }
        });
        
        // Subscribe to plugin updates (hot reload notifications)
        const unsubscribeUpdates = window.api.onPluginsUpdated?.(() => {
            loadPlugins();
        });
        
        return () => {
            unsubscribe?.();
            unsubscribeUpdates?.();
        };
    }, [loadPlugins]);
    
    const showNotification = (message: string, type: 'success' | 'error') => {
        setNotification({ message, type });
        setTimeout(() => setNotification(null), 3000);
    };
    
    const handleInstallPlugin = async () => {
        try {
            setInstalling(true);
            const filePath = await window.api.pickPluginFile?.();
            if (!filePath) {
                setInstalling(false);
                return;
            }
            
            const result = await window.api.installPlugin?.(filePath);
            if (result?.success) {
                showNotification('Plugin installed successfully!', 'success');
                await loadPlugins();
            } else {
                showNotification(result?.error || 'Failed to install plugin', 'error');
            }
        } catch (error) {
            showNotification(error instanceof Error ? error.message : 'Failed to install plugin', 'error');
        } finally {
            setInstalling(false);
        }
    };
    
    const handleUninstallPlugin = async (pluginId: string) => {
        const plugin = plugins.find(p => p.id === pluginId);
        if (!plugin) return;
        
        if (!confirm(`Are you sure you want to uninstall "${plugin.name}"?`)) {
            return;
        }
        
        try {
            const result = await window.api.uninstallPlugin?.(pluginId);
            if (result?.success) {
                showNotification('Plugin uninstalled successfully!', 'success');
                await loadPlugins();
            } else {
                showNotification(result?.error || 'Failed to uninstall plugin', 'error');
            }
        } catch (error) {
            showNotification(error instanceof Error ? error.message : 'Failed to uninstall plugin', 'error');
        }
    };
    
    const handleTogglePlugin = async (pluginId: string, enable: boolean) => {
        try {
            await window.api.togglePlugin?.(pluginId, enable);
            await loadPlugins();
            showNotification(`Plugin ${enable ? 'enabled' : 'disabled'}`, 'success');
        } catch (error) {
            showNotification(error instanceof Error ? error.message : 'Failed to toggle plugin', 'error');
        }
    };
    
    const handleReloadPlugin = async (pluginId: string) => {
        try {
            await window.api.reloadPlugin?.(pluginId);
            await loadPlugins();
            showNotification('Plugin reloaded successfully!', 'success');
        } catch (error) {
            showNotification(error instanceof Error ? error.message : 'Failed to reload plugin', 'error');
        }
    };
    
    const getStatusColor = (status: PluginInfo['status']) => {
        switch (status) {
            case 'active': return 'bg-emerald-500';
            case 'error': return 'bg-red-500';
            case 'disabled': return 'bg-gray-400';
            case 'loading': return 'bg-amber-500 animate-pulse';
            default: return 'bg-blue-500';
        }
    };
    
    const getStatusLabel = (status: PluginInfo['status']) => {
        switch (status) {
            case 'active': return 'Active';
            case 'error': return 'Error';
            case 'disabled': return 'Disabled';
            case 'loading': return 'Loading...';
            default: return 'Installed';
        }
    };
    
    const getCategoryLabel = (category?: string) => {
        switch (category) {
            case 'core': return 'Core';
            case 'productivity': return 'Productivity';
            case 'integration': return 'Integration';
            default: return 'Custom';
        }
    };
    
    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-medium">Installed Plugins</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                        Extend functionality with plugins
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={loadPlugins}
                        disabled={loading}
                        className="inline-flex items-center justify-center rounded-md border bg-background px-3 py-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
                        Refresh
                    </button>
                    <button
                        onClick={handleInstallPlugin}
                        disabled={installing}
                        className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 py-2 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                        {installing ? (
                            <>
                                <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                Installing...
                            </>
                        ) : (
                            <>
                                <Upload className="h-3.5 w-3.5 mr-1.5" />
                                Install Plugin
                            </>
                        )}
                    </button>
                </div>
            </div>
            
            {/* Notification */}
            {notification && (
                <div className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm",
                    notification.type === 'success'
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-red-500/10 text-red-600 dark:text-red-400"
                )}>
                    {notification.type === 'success' ? (
                        <CheckCircle2 className="h-4 w-4" />
                    ) : (
                        <AlertCircle className="h-4 w-4" />
                    )}
                    {notification.message}
                </div>
            )}
            
            {/* Plugin List */}
            <div className="rounded-lg border bg-card">
                {loading ? (
                    <div className="flex items-center justify-center p-8">
                        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : plugins.length === 0 ? (
                    <div className="flex flex-col items-center justify-center p-8 text-center">
                        <Puzzle className="h-12 w-12 text-muted-foreground/30 mb-4" />
                        <p className="text-sm text-muted-foreground">No plugins installed</p>
                        <p className="text-xs text-muted-foreground mt-1">
                            Click "Install Plugin" to add a plugin
                        </p>
                    </div>
                ) : (
                    <div className="divide-y">
                        {plugins.map((plugin) => (
                            <div key={plugin.id} className="p-4 hover:bg-muted/30 transition-colors">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-start gap-3">
                                        <div className="mt-0.5 p-2 rounded-lg bg-muted">
                                            <Package className="h-5 w-5 text-muted-foreground" />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <h4 className="text-sm font-medium">{plugin.name}</h4>
                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                                    v{plugin.version}
                                                </span>
                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                                    {getCategoryLabel(plugin.category)}
                                                </span>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                                {plugin.description || 'No description'}
                                            </p>
                                            {plugin.author && (
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    by {plugin.author}
                                                </p>
                                            )}
                                            <div className="flex items-center gap-2 mt-2">
                                                <span className={cn("h-2 w-2 rounded-full", getStatusColor(plugin.status))} />
                                                <span className="text-xs text-muted-foreground">
                                                    {getStatusLabel(plugin.status)}
                                                </span>
                                                {plugin.error && (
                                                    <span className="text-xs text-red-500 truncate max-w-[200px]" title={plugin.error}>
                                                        - {plugin.error}
                                                    </span>
                                                )}
                                            </div>
                                            
                                            {/* UI Entries provided by this plugin */}
                                            {uiEntries.filter(e => e.pluginId === plugin.id).length > 0 && (
                                                <div className="mt-2 flex flex-wrap gap-1">
                                                    {uiEntries.filter(e => e.pluginId === plugin.id).map(entry => (
                                                        <span 
                                                            key={entry.id}
                                                            className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground"
                                                        >
                                                            {entry.label}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            onClick={() => handleReloadPlugin(plugin.id)}
                                            className="p-2 rounded-md text-muted-foreground hover:bg-muted transition-colors"
                                            title="Hot Reload"
                                        >
                                            <RefreshCw className="h-4 w-4" />
                                        </button>
                                        <button
                                            onClick={() => handleTogglePlugin(plugin.id, plugin.status !== 'active')}
                                            className={cn(
                                                "p-2 rounded-md transition-colors",
                                                plugin.status === 'active'
                                                    ? "text-emerald-600 hover:bg-emerald-500/10"
                                                    : "text-muted-foreground hover:bg-muted"
                                            )}
                                            title={plugin.status === 'active' ? 'Disable' : 'Enable'}
                                        >
                                            {plugin.status === 'active' ? (
                                                <Power className="h-4 w-4" />
                                            ) : (
                                                <PowerOff className="h-4 w-4" />
                                            )}
                                        </button>
                                        <button
                                            onClick={() => handleUninstallPlugin(plugin.id)}
                                            className="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                            title="Uninstall"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            
            {/* Plugin Development Info */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
                <h4 className="text-sm font-medium">Create Your Own Plugin</h4>
                <p className="text-xs text-muted-foreground">
                    Plugins can add new views, integrate with external services, and extend the app's functionality.
                    Check out the plugin development documentation to get started.
                </p>
                <button
                    onClick={() => window.api?.openExternal?.('https://docs.synvo.ai/plugins')}
                    className="inline-flex items-center text-xs text-primary hover:underline"
                >
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Plugin Development Guide
                </button>
            </div>
        </div>
    );
}

