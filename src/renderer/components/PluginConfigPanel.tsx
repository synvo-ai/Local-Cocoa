/**
 * PluginConfigPanel
 * 
 * Settings panel for configuring plugin enable/disable status and ordering.
 * Supports drag-and-drop reordering of plugins.
 */

import { useState, useCallback } from 'react';
import { 
    GripVertical, 
    Puzzle, 
    Activity, 
    Mail, 
    StickyNote, 
    Brain, 
    Link2, 
    Mic, 
    RotateCcw,
    Loader2,
    CheckCircle2,
    AlertCircle
} from 'lucide-react';
import { cn } from '../lib/utils';
import { usePluginConfig, PluginManifestWithConfig } from '../hooks/usePluginConfig';

// Icon map for plugin icons
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
    'Activity': Activity,
    'Mail': Mail,
    'StickyNote': StickyNote,
    'Brain': Brain,
    'Link2': Link2,
    'Mic': Mic,
    'Ear': Mic,
    'Puzzle': Puzzle,
};

interface PluginItemProps {
    plugin: PluginManifestWithConfig;
    onToggleEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
    onDragStart: (e: React.DragEvent, pluginId: string) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent, pluginId: string) => void;
    isDragging: boolean;
    isUpdating: boolean;
}

function PluginItem({
    plugin,
    onToggleEnabled,
    onDragStart,
    onDragOver,
    onDrop,
    isDragging,
    isUpdating,
}: PluginItemProps) {
    const Icon = ICON_MAP[plugin.icon || 'Puzzle'] || Puzzle;
    
    return (
        <div
            draggable
            onDragStart={(e) => onDragStart(e, plugin.id)}
            onDragOver={onDragOver}
            onDrop={(e) => onDrop(e, plugin.id)}
            className={cn(
                "flex items-center gap-4 p-4 rounded-lg border bg-card transition-all duration-200",
                isDragging ? "opacity-50 border-dashed" : "hover:border-primary/30",
                !plugin.enabled && "opacity-60"
            )}
        >
            {/* Drag Handle */}
            <div className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground">
                <GripVertical className="h-5 w-5" />
            </div>
            
            {/* Plugin Icon */}
            <div className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                plugin.enabled 
                    ? "bg-gradient-to-br from-primary/20 to-primary/5" 
                    : "bg-muted/50"
            )}>
                <Icon className={cn(
                    "h-5 w-5",
                    plugin.enabled ? "text-primary" : "text-muted-foreground"
                )} />
            </div>
            
            {/* Plugin Info */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <h4 className="font-medium text-sm truncate">{plugin.name}</h4>
                    <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        v{plugin.version}
                    </span>
                    {plugin.category && (
                        <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded capitalize">
                            {plugin.category}
                        </span>
                    )}
                </div>
                {plugin.description && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {plugin.description}
                    </p>
                )}
            </div>
            
            {/* Enable/Disable Toggle */}
            <div className="flex items-center gap-3">
                {isUpdating ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
                <button
                    onClick={() => onToggleEnabled(plugin.id, !plugin.enabled)}
                    disabled={isUpdating}
                    className={cn(
                        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                        "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        plugin.enabled ? "bg-primary" : "bg-muted"
                    )}
                >
                    <span
                        className={cn(
                            "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                            plugin.enabled ? "translate-x-6" : "translate-x-1"
                        )}
                    />
                </button>
            </div>
        </div>
    );
}

export function PluginConfigPanel() {
    const {
        plugins,
        loading,
        error,
        setPluginEnabled,
        reorderPlugins,
        resetConfig,
    } = usePluginConfig();
    
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [updatingPlugins, setUpdatingPlugins] = useState<Set<string>>(new Set());
    const [isResetting, setIsResetting] = useState(false);
    const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    const showNotification = useCallback((message: string, type: 'success' | 'error') => {
        setNotification({ message, type });
        setTimeout(() => setNotification(null), 3000);
    }, []);

    const handleToggleEnabled = useCallback(async (pluginId: string, enabled: boolean) => {
        setUpdatingPlugins(prev => new Set(prev).add(pluginId));
        try {
            const success = await setPluginEnabled(pluginId, enabled);
            if (success) {
                showNotification(
                    enabled ? `${pluginId} enabled` : `${pluginId} disabled`,
                    'success'
                );
            } else {
                showNotification('Failed to update plugin', 'error');
            }
        } catch (err) {
            showNotification('Failed to update plugin', 'error');
        } finally {
            setUpdatingPlugins(prev => {
                const next = new Set(prev);
                next.delete(pluginId);
                return next;
            });
        }
    }, [setPluginEnabled, showNotification]);

    const handleDragStart = useCallback((e: React.DragEvent, pluginId: string) => {
        setDraggingId(pluginId);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', pluginId);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }, []);

    const handleDrop = useCallback(async (e: React.DragEvent, targetPluginId: string) => {
        e.preventDefault();
        const sourcePluginId = e.dataTransfer.getData('text/plain');
        
        if (!sourcePluginId || sourcePluginId === targetPluginId) {
            setDraggingId(null);
            return;
        }
        
        // Calculate new order
        const currentOrder = plugins.map(p => p.id);
        const sourceIndex = currentOrder.indexOf(sourcePluginId);
        const targetIndex = currentOrder.indexOf(targetPluginId);
        
        if (sourceIndex === -1 || targetIndex === -1) {
            setDraggingId(null);
            return;
        }
        
        // Remove source and insert at target position
        const newOrder = [...currentOrder];
        newOrder.splice(sourceIndex, 1);
        newOrder.splice(targetIndex, 0, sourcePluginId);
        
        setDraggingId(null);
        
        // Save new order
        const success = await reorderPlugins(newOrder);
        if (success) {
            showNotification('Plugin order updated', 'success');
        } else {
            showNotification('Failed to reorder plugins', 'error');
        }
    }, [plugins, reorderPlugins, showNotification]);

    const handleDragEnd = useCallback(() => {
        setDraggingId(null);
    }, []);

    const handleReset = useCallback(async () => {
        setIsResetting(true);
        try {
            const success = await resetConfig();
            if (success) {
                showNotification('Plugin settings reset to defaults', 'success');
            } else {
                showNotification('Failed to reset settings', 'error');
            }
        } catch (err) {
            showNotification('Failed to reset settings', 'error');
        } finally {
            setIsResetting(false);
        }
    }, [resetConfig, showNotification]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="text-center">
                    <AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
                    <p className="text-sm text-destructive">{error}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Notification */}
            {notification && (
                <div className={cn(
                    "flex items-center gap-2 px-4 py-3 rounded-lg text-sm",
                    notification.type === 'success' 
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-destructive/10 text-destructive"
                )}>
                    {notification.type === 'success' ? (
                        <CheckCircle2 className="h-4 w-4" />
                    ) : (
                        <AlertCircle className="h-4 w-4" />
                    )}
                    {notification.message}
                </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-medium">Extension Order & Visibility</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                        Drag to reorder, toggle to enable/disable extensions in the Extensions tab.
                    </p>
                </div>
                <button
                    onClick={handleReset}
                    disabled={isResetting}
                    className={cn(
                        "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium",
                        "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "transition-colors"
                    )}
                >
                    {isResetting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    Reset to Defaults
                </button>
            </div>

            {/* Plugin List */}
            <div 
                className="space-y-2"
                onDragEnd={handleDragEnd}
            >
                {plugins.map(plugin => (
                    <PluginItem
                        key={plugin.id}
                        plugin={plugin}
                        onToggleEnabled={handleToggleEnabled}
                        onDragStart={handleDragStart}
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                        isDragging={draggingId === plugin.id}
                        isUpdating={updatingPlugins.has(plugin.id)}
                    />
                ))}
            </div>

            {plugins.length === 0 && (
                <div className="text-center py-12">
                    <Puzzle className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">No plugins installed</p>
                </div>
            )}

            {/* Info */}
            <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">
                    <strong>Tip:</strong> Changes take effect immediately. Disabled plugins won't appear 
                    in the Extensions tab but remain installed. Drag plugins to change their display order.
                </p>
            </div>
        </div>
    );
}

