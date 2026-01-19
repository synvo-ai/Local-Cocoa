/**
 * Plugin Configuration Types
 * Defines user-configurable plugin settings including enable/disable and ordering
 */

/**
 * Plugin tab configuration from plugin.json
 */
export interface PluginTabConfig {
    id: string;
    label: string;
    icon: string;
    /** Optional component name mapping for builtin plugins */
    component?: string;
}

/**
 * Plugin manifest structure (from plugin.json)
 */
export interface PluginManifestInfo {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    category?: 'core' | 'productivity' | 'integration' | 'custom';
    icon?: string;
    frontend?: {
        tab?: PluginTabConfig;
        entrypoint?: string;
        uiEntries?: Array<{
            id: string;
            label: string;
            icon?: string;
        }>;
    };
    backend?: {
        entrypoint?: string;
        requiresDatabase?: boolean;
    };
}

/**
 * User's configuration for a single plugin
 */
export interface PluginUserConfig {
    /** Plugin ID */
    pluginId: string;
    /** Whether the plugin is enabled */
    enabled: boolean;
    /** Order in the extensions tab (lower = first) */
    order: number;
}

/**
 * Complete plugin configuration stored in user settings
 */
export interface PluginsUserConfig {
    /** Plugin configurations keyed by plugin ID */
    plugins: Record<string, PluginUserConfig>;
    /** Ordered list of plugin IDs for display */
    order: string[];
    /** Version of the config schema */
    version: number;
}

/**
 * Full plugin info combining manifest and user config
 */
export interface PluginFullInfo {
    manifest: PluginManifestInfo;
    userConfig: PluginUserConfig;
    status: 'active' | 'disabled' | 'installed' | 'error';
    error?: string;
}

/**
 * Default plugins configuration
 * These are the built-in plugins with their default order
 */
export const DEFAULT_PLUGINS_ORDER: string[] = [
    'mail',
    'notes',
    'mcp',
];

/**
 * Default plugin config schema version
 */
export const PLUGINS_CONFIG_VERSION = 1;

/**
 * Create default user config for a plugin
 */
export function createDefaultPluginConfig(pluginId: string, order: number): PluginUserConfig {
    return {
        pluginId,
        enabled: true,
        order,
    };
}

/**
 * Create default plugins user config
 */
export function createDefaultPluginsConfig(pluginIds: string[]): PluginsUserConfig {
    const plugins: Record<string, PluginUserConfig> = {};
    const order: string[] = [];
    
    // First add default plugins in order
    DEFAULT_PLUGINS_ORDER.forEach((id, idx) => {
        if (pluginIds.includes(id)) {
            plugins[id] = createDefaultPluginConfig(id, idx);
            order.push(id);
        }
    });
    
    // Then add any remaining plugins
    pluginIds.forEach((id, idx) => {
        if (!plugins[id]) {
            plugins[id] = createDefaultPluginConfig(id, DEFAULT_PLUGINS_ORDER.length + idx);
            order.push(id);
        }
    });
    
    return {
        plugins,
        order,
        version: PLUGINS_CONFIG_VERSION,
    };
}

