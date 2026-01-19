/**
 * Plugin Registry
 * 
 * Manages registration of builtin plugin components.
 * Builtin plugins are rendered directly in the main app (not via webview)
 * for better performance and seamless integration.
 */

import { ComponentType } from 'react';

export interface PluginViewConfig {
    id: string;
    label: string;
    icon: string;
    component: ComponentType<any>;
    props?: Record<string, any>;
}

export interface PluginSettingsConfig {
    id: string;
    label: string;
    icon: string;
    component: ComponentType<any>;
}

export interface PluginRegistration {
    id: string;
    name: string;
    version: string;
    isBuiltin: boolean;
    mainView?: PluginViewConfig;
    settingsTab?: PluginSettingsConfig;
}

class PluginRegistry {
    private plugins: Map<string, PluginRegistration> = new Map();

    register(plugin: PluginRegistration): void {
        this.plugins.set(plugin.id, plugin);
        console.log(`[PluginRegistry] Registered plugin: ${plugin.name} (${plugin.id})`);
    }

    unregister(pluginId: string): void {
        this.plugins.delete(pluginId);
    }

    getPlugin(pluginId: string): PluginRegistration | undefined {
        return this.plugins.get(pluginId);
    }

    getAllPlugins(): PluginRegistration[] {
        return Array.from(this.plugins.values());
    }

    getMainViewPlugins(): PluginRegistration[] {
        return Array.from(this.plugins.values()).filter(p => p.mainView);
    }

    getSettingsPlugins(): PluginRegistration[] {
        return Array.from(this.plugins.values()).filter(p => p.settingsTab);
    }

    getMainViewComponent(pluginId: string): ComponentType<any> | undefined {
        return this.plugins.get(pluginId)?.mainView?.component;
    }

    getSettingsComponent(pluginId: string): ComponentType<any> | undefined {
        return this.plugins.get(pluginId)?.settingsTab?.component;
    }
}

// Global singleton
export const pluginRegistry = new PluginRegistry();

