/**
 * Plugin Configuration Manager
 * Handles reading/writing user plugin preferences (enable/disable, ordering)
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { PluginsUserConfig, PluginUserConfig, PluginManifestInfo } from '../../types/plugins';
import { createDefaultPluginsConfig, PLUGINS_CONFIG_VERSION } from '../../types/plugins';

const PLUGINS_CONFIG_FILE = 'plugins-config.json';

/**
 * Get the path to the plugins config file
 */
function getConfigPath(): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, PLUGINS_CONFIG_FILE);
}

/**
 * Load plugins configuration from disk
 */
export function loadPluginsConfig(): PluginsUserConfig | null {
    try {
        const configPath = getConfigPath();
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(content) as PluginsUserConfig;
            
            // Migrate if needed
            if (!config.version || config.version < PLUGINS_CONFIG_VERSION) {
                console.log('[PluginConfig] Migrating config to version', PLUGINS_CONFIG_VERSION);
                config.version = PLUGINS_CONFIG_VERSION;
                savePluginsConfig(config);
            }
            
            return config;
        }
    } catch (error) {
        console.error('[PluginConfig] Failed to load config:', error);
    }
    return null;
}

/**
 * Save plugins configuration to disk
 */
export function savePluginsConfig(config: PluginsUserConfig): boolean {
    try {
        const configPath = getConfigPath();
        const dir = path.dirname(configPath);
        
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log('[PluginConfig] Saved config');
        return true;
    } catch (error) {
        console.error('[PluginConfig] Failed to save config:', error);
        return false;
    }
}

/**
 * Get or create plugins configuration
 * Syncs with discovered plugins to ensure config is up to date
 */
export function getPluginsConfig(discoveredPluginIds: string[]): PluginsUserConfig {
    let config = loadPluginsConfig();
    
    if (!config) {
        // Create default config
        config = createDefaultPluginsConfig(discoveredPluginIds);
        savePluginsConfig(config);
        return config;
    }
    
    // Sync with discovered plugins
    let needsSave = false;
    
    // Add new plugins that aren't in config
    for (const pluginId of discoveredPluginIds) {
        if (!config.plugins[pluginId]) {
            const order = config.order.length;
            config.plugins[pluginId] = {
                pluginId,
                enabled: true,
                order,
            };
            config.order.push(pluginId);
            needsSave = true;
            console.log(`[PluginConfig] Added new plugin: ${pluginId}`);
        }
    }
    
    // Remove plugins that no longer exist
    const existingPlugins = new Set(discoveredPluginIds);
    const pluginsToRemove: string[] = [];
    
    for (const pluginId of Object.keys(config.plugins)) {
        if (!existingPlugins.has(pluginId)) {
            pluginsToRemove.push(pluginId);
        }
    }
    
    for (const pluginId of pluginsToRemove) {
        delete config.plugins[pluginId];
        config.order = config.order.filter(id => id !== pluginId);
        needsSave = true;
        console.log(`[PluginConfig] Removed missing plugin: ${pluginId}`);
    }
    
    // Re-normalize order values
    if (needsSave) {
        config.order.forEach((id, idx) => {
            if (config.plugins[id]) {
                config.plugins[id].order = idx;
            }
        });
        savePluginsConfig(config);
    }
    
    return config;
}

/**
 * Update a single plugin's configuration
 */
export function updatePluginConfig(pluginId: string, updates: Partial<PluginUserConfig>): PluginsUserConfig | null {
    const config = loadPluginsConfig();
    if (!config) {
        return null;
    }
    
    if (!config.plugins[pluginId]) {
        console.error(`[PluginConfig] Plugin not found: ${pluginId}`);
        return null;
    }
    
    // Apply updates
    config.plugins[pluginId] = {
        ...config.plugins[pluginId],
        ...updates,
    };
    
    savePluginsConfig(config);
    return config;
}

/**
 * Set plugin enabled state
 */
export function setPluginEnabled(pluginId: string, enabled: boolean): PluginsUserConfig | null {
    return updatePluginConfig(pluginId, { enabled });
}

/**
 * Reorder plugins
 * @param newOrder Array of plugin IDs in the new order
 */
export function reorderPlugins(newOrder: string[]): PluginsUserConfig | null {
    const config = loadPluginsConfig();
    if (!config) {
        return null;
    }
    
    // Validate that all plugins in newOrder exist
    const existingPlugins = new Set(Object.keys(config.plugins));
    for (const pluginId of newOrder) {
        if (!existingPlugins.has(pluginId)) {
            console.error(`[PluginConfig] Cannot reorder: plugin ${pluginId} not found`);
            return null;
        }
    }
    
    // Ensure all existing plugins are in newOrder
    for (const pluginId of existingPlugins) {
        if (!newOrder.includes(pluginId)) {
            newOrder.push(pluginId);
        }
    }
    
    // Update order
    config.order = newOrder;
    newOrder.forEach((id, idx) => {
        if (config.plugins[id]) {
            config.plugins[id].order = idx;
        }
    });
    
    savePluginsConfig(config);
    return config;
}

/**
 * Get ordered list of enabled plugins
 */
export function getEnabledPlugins(config: PluginsUserConfig): string[] {
    return config.order.filter(id => config.plugins[id]?.enabled);
}

/**
 * Reset plugins config to defaults
 */
export function resetPluginsConfig(discoveredPluginIds: string[]): PluginsUserConfig {
    const config = createDefaultPluginsConfig(discoveredPluginIds);
    savePluginsConfig(config);
    return config;
}

