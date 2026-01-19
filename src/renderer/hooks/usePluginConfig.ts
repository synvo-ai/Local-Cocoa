/**
 * usePluginConfig Hook
 * Manages plugin configuration state including enabled/disabled status and ordering
 */

import { useState, useEffect, useCallback } from 'react';

export interface PluginTabInfo {
    id: string;
    pluginId: string;
    label: string;
    icon: string;
    component?: string;
}

export interface PluginManifestWithConfig {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    category?: string;
    icon?: string;
    frontend?: {
        tab?: {
            id: string;
            label: string;
            icon: string;
            component?: string;
        };
    };
    backend?: {
        entrypoint?: string;
        requiresDatabase?: boolean;
    };
    enabled: boolean;
    order: number;
}

export interface PluginsConfig {
    plugins: Record<string, {
        pluginId: string;
        enabled: boolean;
        order: number;
    }>;
    order: string[];
    version: number;
}

interface UsePluginConfigReturn {
    /** All plugin manifests with their config */
    plugins: PluginManifestWithConfig[];
    /** Enabled plugin tabs for Extensions view, in order */
    enabledTabs: PluginTabInfo[];
    /** Full plugins config */
    config: PluginsConfig | null;
    /** Loading state */
    loading: boolean;
    /** Error state */
    error: string | null;
    /** Toggle a plugin's enabled state */
    setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<boolean>;
    /** Reorder plugins */
    reorderPlugins: (newOrder: string[]) => Promise<boolean>;
    /** Reset to default config */
    resetConfig: () => Promise<boolean>;
    /** Refresh data */
    refresh: () => Promise<void>;
}

export function usePluginConfig(): UsePluginConfigReturn {
    const [plugins, setPlugins] = useState<PluginManifestWithConfig[]>([]);
    const [enabledTabs, setEnabledTabs] = useState<PluginTabInfo[]>([]);
    const [config, setConfig] = useState<PluginsConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            const api = window.api;
            if (!api?.getPluginManifests || !api?.getEnabledPluginTabs || !api?.getPluginsConfig) {
                throw new Error('Plugin API not available');
            }

            const [manifestsResult, tabsResult, configResult] = await Promise.all([
                api.getPluginManifests(),
                api.getEnabledPluginTabs(),
                api.getPluginsConfig(),
            ]);

            setPlugins(manifestsResult || []);
            setEnabledTabs(tabsResult || []);
            setConfig(configResult);
        } catch (err) {
            console.error('[usePluginConfig] Failed to load data:', err);
            setError(err instanceof Error ? err.message : 'Failed to load plugin config');
        } finally {
            setLoading(false);
        }
    }, []);

    // Load data on mount
    useEffect(() => {
        loadData();
    }, [loadData]);

    // Listen for config updates
    useEffect(() => {
        const api = window.api;
        if (!api?.onPluginsConfigUpdated) return;

        const unsubscribe = api.onPluginsConfigUpdated((newConfig: PluginsConfig) => {
            setConfig(newConfig);
            // Reload full data when config changes
            loadData();
        });

        return () => {
            unsubscribe?.();
        };
    }, [loadData]);

    // Listen for plugin updates
    useEffect(() => {
        const api = window.api;
        if (!api?.onPluginsUpdated) return;

        const unsubscribe = api.onPluginsUpdated(() => {
            loadData();
        });

        return () => {
            unsubscribe?.();
        };
    }, [loadData]);

    const setPluginEnabledFn = useCallback(async (pluginId: string, enabled: boolean): Promise<boolean> => {
        const api = window.api;
        if (!api?.setPluginEnabled) {
            console.error('[usePluginConfig] setPluginEnabled API not available');
            return false;
        }

        try {
            const result = await api.setPluginEnabled(pluginId, enabled);
            if (result.success && result.config) {
                setConfig(result.config);
                // Reload to get updated tabs
                await loadData();
            }
            return result.success;
        } catch (err) {
            console.error('[usePluginConfig] Failed to set plugin enabled:', err);
            return false;
        }
    }, [loadData]);

    const reorderPluginsFn = useCallback(async (newOrder: string[]): Promise<boolean> => {
        const api = window.api;
        if (!api?.reorderPlugins) {
            console.error('[usePluginConfig] reorderPlugins API not available');
            return false;
        }

        try {
            const result = await api.reorderPlugins(newOrder);
            if (result.success && result.config) {
                setConfig(result.config);
                // Reload to get updated order
                await loadData();
            }
            return result.success;
        } catch (err) {
            console.error('[usePluginConfig] Failed to reorder plugins:', err);
            return false;
        }
    }, [loadData]);

    const resetConfigFn = useCallback(async (): Promise<boolean> => {
        const api = window.api;
        if (!api?.resetPluginsConfig) {
            console.error('[usePluginConfig] resetPluginsConfig API not available');
            return false;
        }

        try {
            const result = await api.resetPluginsConfig();
            if (result.success && result.config) {
                setConfig(result.config);
                await loadData();
            }
            return result.success;
        } catch (err) {
            console.error('[usePluginConfig] Failed to reset config:', err);
            return false;
        }
    }, [loadData]);

    return {
        plugins,
        enabledTabs,
        config,
        loading,
        error,
        setPluginEnabled: setPluginEnabledFn,
        reorderPlugins: reorderPluginsFn,
        resetConfig: resetConfigFn,
        refresh: loadData,
    };
}

/**
 * Map of plugin IDs to their component names
 * Used by ExtensionsView to render the correct component
 */
export const PLUGIN_COMPONENT_MAP: Record<string, string> = {
    'mail': 'EmailConnectorsPanel',
    'notes': 'NotesWorkspace',
    'mcp': 'MCPConnectionPanel',
};

/**
 * Get the component name for a plugin
 */
export function getPluginComponent(pluginId: string): string | undefined {
    return PLUGIN_COMPONENT_MAP[pluginId];
}

