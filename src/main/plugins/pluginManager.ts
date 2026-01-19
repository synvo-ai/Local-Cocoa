/**
 * Plugin Manager
 * Handles plugin discovery, loading, lifecycle management, and UI extension registration
 * 
 * Features:
 * - Sandboxed webview for each plugin (CSS/JS isolation)
 * - IPC communication via contextBridge
 * - Hot reload support (reload plugins without app restart)
 * - Scoped storage for each plugin
 */

import { app, BrowserWindow, BrowserView, ipcMain, session, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { config } from '../config';
import type {
    PluginManifest,
    PluginInstance,
    PluginRegistry,
    PluginStatus,
    PluginUIEntry,
    PluginSystemEvent
} from './types';
import type { PluginsUserConfig, PluginManifestInfo } from '../../types/plugins';
import {
    getPluginsConfig,
    setPluginEnabled,
    reorderPlugins,
    resetPluginsConfig,
    getEnabledPlugins,
} from './pluginConfig';

const PLUGIN_MANIFEST_NAME = 'plugin.json';
const PLUGINS_DIR = 'plugins';
const PLUGIN_STORAGE_FILE = 'plugin-storage.json';

export class PluginManager extends EventEmitter {
    private registry: PluginRegistry = {
        plugins: new Map(),
        uiEntries: new Map()
    };
    
    private projectRoot: string;
    private pluginsPath: string;
    private userDataPath: string;
    private pluginViews: Map<string, BrowserView> = new Map();
    private pluginStorage: Map<string, Record<string, unknown>> = new Map();
    private mainWindow: BrowserWindow | null = null;
    private pluginsConfig: PluginsUserConfig | null = null;
    
    constructor(projectRoot: string) {
        super();
        this.projectRoot = projectRoot;
        this.userDataPath = app.getPath('userData');
        
        // This aligns with the backend which also looks for plugins in <resources>/plugins
        this.pluginsPath = path.join( config.isDev ? config.projectRoot : process.resourcesPath, PLUGINS_DIR);
        
        // Ensure plugins directory exists
        if (!fs.existsSync(this.pluginsPath)) {
            console.warn(`[PluginManager] Plugins directory does not exist: ${this.pluginsPath}`);
            // Create it if missing (though it should exist in the project)
            fs.mkdirSync(this.pluginsPath, { recursive: true });
        }
        
        // Load plugin storage
        this.loadStorage();
    }
    
    /**
     * Set the main window reference for broadcasting events
     */
    setMainWindow(window: BrowserWindow): void {
        this.mainWindow = window;
    }
    
    /**
     * Load plugin storage from disk
     */
    private loadStorage(): void {
        const storagePath = path.join(this.userDataPath, PLUGIN_STORAGE_FILE);
        try {
            if (fs.existsSync(storagePath)) {
                const data = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
                for (const [pluginId, storage] of Object.entries(data)) {
                    this.pluginStorage.set(pluginId, storage as Record<string, unknown>);
                }
                console.log('[PluginManager] Loaded storage for', this.pluginStorage.size, 'plugins');
            }
        } catch (error) {
            console.error('[PluginManager] Failed to load storage:', error);
        }
    }
    
    /**
     * Save plugin storage to disk
     */
    private saveStorage(): void {
        const storagePath = path.join(this.userDataPath, PLUGIN_STORAGE_FILE);
        try {
            const data: Record<string, Record<string, unknown>> = {};
            for (const [pluginId, storage] of this.pluginStorage) {
                data[pluginId] = storage;
            }
            fs.writeFileSync(storagePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('[PluginManager] Failed to save storage:', error);
        }
    }
    
    /**
     * Get storage for a plugin
     */
    getPluginStorage(pluginId: string, key: string): unknown | null {
        const storage = this.pluginStorage.get(pluginId);
        if (!storage) return null;
        return storage[key] ?? null;
    }
    
    /**
     * Set storage for a plugin
     */
    setPluginStorage(pluginId: string, key: string, value: unknown): void {
        let storage = this.pluginStorage.get(pluginId);
        if (!storage) {
            storage = {};
            this.pluginStorage.set(pluginId, storage);
        }
        storage[key] = value;
        this.saveStorage();
    }
    
    /**
     * Delete a storage key for a plugin
     */
    deletePluginStorage(pluginId: string, key: string): void {
        const storage = this.pluginStorage.get(pluginId);
        if (storage) {
            delete storage[key];
            this.saveStorage();
        }
    }
    
    /**
     * Initialize the plugin system - discover and load all plugins
     */
    async initialize(): Promise<void> {
        console.log('[PluginManager] Initializing plugin system...');
        
        // Discover all plugins
        await this.discoverPlugins(this.pluginsPath);
        
        // Load plugins config (syncs with discovered plugins)
        const discoveredIds = Array.from(this.registry.plugins.keys());
        this.pluginsConfig = getPluginsConfig(discoveredIds);
        console.log('[PluginManager] Loaded plugins config:', this.pluginsConfig.order);
        
        // Load enabled plugins only
        const enabledPlugins = getEnabledPlugins(this.pluginsConfig);
        for (const pluginId of enabledPlugins) {
            const plugin = this.registry.plugins.get(pluginId);
            if (plugin && plugin.status === 'installed') {
                await this.loadPlugin(pluginId);
            }
        }
        
        console.log(`[PluginManager] Initialized ${this.registry.plugins.size} plugins (${enabledPlugins.length} enabled)`);
    }
    
    /**
     * Get the current plugins configuration
     */
    getPluginsConfig(): PluginsUserConfig | null {
        return this.pluginsConfig;
    }
    
    /**
     * Get all plugin manifests with their user config
     */
    getPluginManifests(): Array<PluginManifestInfo & { enabled: boolean; order: number }> {
        if (!this.pluginsConfig) {
            return [];
        }
        
        const result: Array<PluginManifestInfo & { enabled: boolean; order: number }> = [];
        
        // Return in order
        for (const pluginId of this.pluginsConfig.order) {
            const plugin = this.registry.plugins.get(pluginId);
            const userConfig = this.pluginsConfig.plugins[pluginId];
            
            if (plugin && userConfig) {
                result.push({
                    id: plugin.manifest.id,
                    name: plugin.manifest.name,
                    version: plugin.manifest.version,
                    description: plugin.manifest.description,
                    author: plugin.manifest.author,
                    category: plugin.manifest.category,
                    icon: (plugin.manifest as any).icon,
                    frontend: plugin.manifest.frontend as any,
                    backend: plugin.manifest.backend as any,
                    enabled: userConfig.enabled,
                    order: userConfig.order,
                });
            }
        }
        
        return result;
    }
    
    /**
     * Get ordered list of enabled plugin tabs for the Extensions view
     */
    getEnabledPluginTabs(): Array<{
        id: string;
        pluginId: string;
        label: string;
        icon: string;
        component?: string;
    }> {
        if (!this.pluginsConfig) {
            return [];
        }
        
        const tabs: Array<{
            id: string;
            pluginId: string;
            label: string;
            icon: string;
            component?: string;
        }> = [];
        
        for (const pluginId of this.pluginsConfig.order) {
            const userConfig = this.pluginsConfig.plugins[pluginId];
            if (!userConfig?.enabled) continue;
            
            const plugin = this.registry.plugins.get(pluginId);
            if (!plugin) continue;
            
            const frontend = plugin.manifest.frontend as any;
            if (frontend?.tab) {
                tabs.push({
                    id: frontend.tab.id,
                    pluginId: pluginId,
                    label: frontend.tab.label,
                    icon: frontend.tab.icon || 'Puzzle',
                    component: frontend.tab.component,
                });
            }
        }
        
        return tabs;
    }
    
    /**
     * Discover plugins in a directory
     */
    private async discoverPlugins(basePath: string): Promise<void> {
        if (!fs.existsSync(basePath)) {
            console.log(`[PluginManager] Plugin directory does not exist: ${basePath}`);
            return;
        }
        
        const entries = fs.readdirSync(basePath, { withFileTypes: true });
        
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            
            const pluginPath = path.join(basePath, entry.name);
            const manifestPath = path.join(pluginPath, PLUGIN_MANIFEST_NAME);
            
            if (!fs.existsSync(manifestPath)) {
                console.warn(`[PluginManager] No manifest found in ${pluginPath}`);
                continue;
            }
            
            try {
                const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
                const manifest: PluginManifest = JSON.parse(manifestContent);
                
                // Validate manifest
                if (!manifest.id || !manifest.name || !manifest.version) {
                    console.warn(`[PluginManager] Invalid manifest in ${pluginPath}: missing required fields`);
                    continue;
                }
                
                // Check for duplicate IDs
                if (this.registry.plugins.has(manifest.id)) {
                    console.warn(`[PluginManager] Duplicate plugin ID: ${manifest.id}`);
                    continue;
                }
                
                // Register the plugin
                const instance: PluginInstance = {
                    manifest,
                    status: 'installed',
                    path: pluginPath
                };
                
                this.registry.plugins.set(manifest.id, instance);
                console.log(`[PluginManager] Discovered plugin: ${manifest.name} (${manifest.id})`);
                
            } catch (error) {
                console.error(`[PluginManager] Failed to parse manifest in ${pluginPath}:`, error);
            }
        }
    }
    
    /**
     * Load a plugin by ID
     */
    async loadPlugin(pluginId: string): Promise<boolean> {
        const plugin = this.registry.plugins.get(pluginId);
        if (!plugin) {
            console.error(`[PluginManager] Plugin not found: ${pluginId}`);
            return false;
        }
        
        if (plugin.status === 'active') {
            console.log(`[PluginManager] Plugin already active: ${pluginId}`);
            return true;
        }
        
        plugin.status = 'loading';
        
        try {
            // Register UI entries
            if (plugin.manifest.frontend?.uiEntries) {
                for (const entry of plugin.manifest.frontend.uiEntries) {
                    const fullEntry = { ...entry, pluginId };
                    this.registry.uiEntries.set(entry.id, fullEntry);
                    this.emitEvent({ type: 'ui-entry-added', entry: fullEntry });
                }
            }
            
            plugin.status = 'active';
            this.emitEvent({ type: 'plugin-loaded', pluginId });
            console.log(`[PluginManager] Loaded plugin: ${pluginId}`);
            return true;
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            plugin.status = 'error';
            plugin.error = errorMessage;
            this.emitEvent({ type: 'plugin-error', pluginId, error: errorMessage });
            console.error(`[PluginManager] Failed to load plugin ${pluginId}:`, error);
            return false;
        }
    }
    
    /**
     * Unload a plugin by ID
     */
    async unloadPlugin(pluginId: string): Promise<boolean> {
        const plugin = this.registry.plugins.get(pluginId);
        if (!plugin) {
            console.error(`[PluginManager] Plugin not found: ${pluginId}`);
            return false;
        }
        
        try {
            // Remove UI entries
            const entriesToRemove: string[] = [];
            for (const [entryId, entry] of this.registry.uiEntries) {
                if (entry.pluginId === pluginId) {
                    entriesToRemove.push(entryId);
                }
            }
            for (const entryId of entriesToRemove) {
                this.registry.uiEntries.delete(entryId);
                this.emitEvent({ type: 'ui-entry-removed', entryId });
            }
            
            // Destroy any webviews
            const view = this.pluginViews.get(pluginId);
            if (view) {
                // Note: BrowserView doesn't have destroy(), we just remove reference
                this.pluginViews.delete(pluginId);
            }
            
            plugin.status = 'installed';
            plugin.webviewId = undefined;
            this.emitEvent({ type: 'plugin-unloaded', pluginId });
            console.log(`[PluginManager] Unloaded plugin: ${pluginId}`);
            return true;
            
        } catch (error) {
            console.error(`[PluginManager] Failed to unload plugin ${pluginId}:`, error);
            return false;
        }
    }
    
    /**
     * Install a plugin from a .zip file
     */
    async installPlugin(zipPath: string): Promise<{ success: boolean; pluginId?: string; error?: string }> {
        const AdmZip = require('adm-zip');
        
        try {
            const zip = new AdmZip(zipPath);
            const entries = zip.getEntries();
            
            // Find plugin.json
            const manifestEntry = entries.find((e: any) => e.entryName.endsWith(PLUGIN_MANIFEST_NAME));
            if (!manifestEntry) {
                return { success: false, error: 'No plugin.json found in archive' };
            }
            
            // Parse manifest
            const manifestContent = zip.readAsText(manifestEntry);
            const manifest: PluginManifest = JSON.parse(manifestContent);
            
            if (!manifest.id || !manifest.name || !manifest.version) {
                return { success: false, error: 'Invalid plugin manifest' };
            }
            
            // Check if already installed
            if (this.registry.plugins.has(manifest.id)) {
                return { success: false, error: `Plugin ${manifest.id} is already installed` };
            }
            
            // Create plugin directory
            const pluginDir = path.join(this.pluginsPath, manifest.id);
            if (fs.existsSync(pluginDir)) {
                fs.rmSync(pluginDir, { recursive: true });
            }
            fs.mkdirSync(pluginDir, { recursive: true });
            
            // Extract plugin files
            zip.extractAllTo(pluginDir, true);
            
            // Register and load the plugin
            const instance: PluginInstance = {
                manifest,
                status: 'installed',
                path: pluginDir
            };
            this.registry.plugins.set(manifest.id, instance);
            
            await this.loadPlugin(manifest.id);
            
            console.log(`[PluginManager] Installed plugin: ${manifest.name}`);
            return { success: true, pluginId: manifest.id };
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('[PluginManager] Failed to install plugin:', error);
            return { success: false, error: errorMessage };
        }
    }
    
    /**
     * Uninstall a plugin by ID
     */
    async uninstallPlugin(pluginId: string): Promise<{ success: boolean; error?: string }> {
        const plugin = this.registry.plugins.get(pluginId);
        if (!plugin) {
            return { success: false, error: 'Plugin not found' };
        }
        
        try {
            // Unload first
            await this.unloadPlugin(pluginId);
            
            // Remove plugin directory
            if (fs.existsSync(plugin.path)) {
                fs.rmSync(plugin.path, { recursive: true });
            }
            
            // Remove from registry
            this.registry.plugins.delete(pluginId);
            
            console.log(`[PluginManager] Uninstalled plugin: ${pluginId}`);
            return { success: true };
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[PluginManager] Failed to uninstall plugin ${pluginId}:`, error);
            return { success: false, error: errorMessage };
        }
    }
    
    /**
     * Get all registered UI entries
     */
    getUIEntries(): Array<PluginUIEntry & { pluginId: string }> {
        return Array.from(this.registry.uiEntries.values());
    }
    
    /**
     * Get all plugins
     */
    getPlugins(): PluginInstance[] {
        return Array.from(this.registry.plugins.values());
    }
    
    /**
     * Get a specific plugin
     */
    getPlugin(pluginId: string): PluginInstance | undefined {
        return this.registry.plugins.get(pluginId);
    }
    
    /**
     * Get plugin's frontend path
     */
    getPluginFrontendPath(pluginId: string): string | null {
        const plugin = this.registry.plugins.get(pluginId);
        if (!plugin || !plugin.manifest.frontend) {
            return null;
        }
        return path.join(plugin.path, 'frontend', plugin.manifest.frontend.entrypoint);
    }
    
    /**
     * Get plugin's backend router module path
     */
    getPluginBackendPath(pluginId: string): string | null {
        const plugin = this.registry.plugins.get(pluginId);
        if (!plugin || !plugin.manifest.backend) {
            return null;
        }
        return path.join(plugin.path, 'backend');
    }
    
    /**
     * Create a sandboxed webview for a plugin
     */
    createPluginView(pluginId: string, parentWindow: BrowserWindow): BrowserView | null {
        const plugin = this.registry.plugins.get(pluginId);
        if (!plugin || !plugin.manifest.frontend) {
            console.error(`[PluginManager] Cannot create view for plugin ${pluginId}: no frontend`);
            return null;
        }
        
        // Create a new session for isolation
        const pluginSession = session.fromPartition(`plugin:${pluginId}`, { cache: false });
        
        // Create the BrowserView
        const view = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                preload: plugin.manifest.frontend.preloadScript 
                    ? path.join(plugin.path, 'frontend', plugin.manifest.frontend.preloadScript)
                    : path.join(this.projectRoot, 'dist-electron', 'preload', 'pluginPreload.js'),
                session: pluginSession,
                additionalArguments: [`--plugin-id=${pluginId}`]
            }
        });
        
        // Load the plugin's frontend
        const frontendPath = this.getPluginFrontendPath(pluginId);
        if (frontendPath && fs.existsSync(frontendPath)) {
            view.webContents.loadFile(frontendPath);
        }
        
        this.pluginViews.set(pluginId, view);
        plugin.webviewId = view.webContents.id;
        
        return view;
    }
    
    /**
     * Get or create a plugin view
     */
    getOrCreatePluginView(pluginId: string, parentWindow: BrowserWindow): BrowserView | null {
        const existing = this.pluginViews.get(pluginId);
        if (existing) {
            return existing;
        }
        return this.createPluginView(pluginId, parentWindow);
    }
    
    /**
     * Emit a plugin system event
     */
    private emitEvent(event: PluginSystemEvent): void {
        this.emit('plugin-event', event);
    }
    
    /**
     * Hot reload a plugin (unload and reload)
     */
    async reloadPlugin(pluginId: string): Promise<boolean> {
        const plugin = this.registry.plugins.get(pluginId);
        if (!plugin) {
            console.error(`[PluginManager] Plugin not found for reload: ${pluginId}`);
            return false;
        }
        
        console.log(`[PluginManager] Hot-reloading plugin: ${pluginId}`);
        
        // Unload first
        await this.unloadPlugin(pluginId);
        
        // Re-read manifest in case it changed
        const manifestPath = path.join(plugin.path, PLUGIN_MANIFEST_NAME);
        if (fs.existsSync(manifestPath)) {
            try {
                const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
                plugin.manifest = JSON.parse(manifestContent);
            } catch (error) {
                console.error(`[PluginManager] Failed to re-read manifest for ${pluginId}:`, error);
            }
        }
        
        // Load again
        const success = await this.loadPlugin(pluginId);
        
        // Notify frontend to refresh
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('plugins:updated');
        }
        
        return success;
    }
    
    /**
     * Refresh all plugins (rediscover and reload)
     */
    async refreshPlugins(): Promise<void> {
        console.log('[PluginManager] Refreshing all plugins...');
        
        // Unload all active plugins
        for (const [pluginId, plugin] of this.registry.plugins) {
            if (plugin.status === 'active') {
                await this.unloadPlugin(pluginId);
            }
        }
        
        // Clear registry
        this.registry.plugins.clear();
        this.registry.uiEntries.clear();
        
        // Rediscover
        await this.discoverPlugins(this.pluginsPath);
        
        // Reload all
        for (const [pluginId, plugin] of this.registry.plugins) {
            if (plugin.status === 'installed') {
                await this.loadPlugin(pluginId);
            }
        }
        
        // Notify frontend
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('plugins:updated');
        }
        
        console.log(`[PluginManager] Refreshed ${this.registry.plugins.size} plugins`);
    }
    
    /**
     * Broadcast event to all plugin webviews
     */
    broadcastToPlugins(channel: string, ...args: unknown[]): void {
        for (const [pluginId, view] of this.pluginViews) {
            if (!view.webContents.isDestroyed()) {
                view.webContents.send(`plugin:${pluginId}:${channel}`, ...args);
            }
        }
    }
    
    /**
     * Register IPC handlers for plugin system
     */
    registerIPCHandlers(): void {
        // List all plugins
        ipcMain.handle('plugins:list', () => {
            return this.getPlugins().map(p => ({
                id: p.manifest.id,
                name: p.manifest.name,
                version: p.manifest.version,
                description: p.manifest.description,
                author: p.manifest.author,
                status: p.status,
                error: p.error,
                category: p.manifest.category
            }));
        });
        
        // Get UI entries
        ipcMain.handle('plugins:ui-entries', () => {
            return this.getUIEntries();
        });
        
        // Get plugins config
        ipcMain.handle('plugins:get-config', () => {
            return this.pluginsConfig;
        });
        
        // Get plugin manifests with config
        ipcMain.handle('plugins:get-manifests', () => {
            return this.getPluginManifests();
        });
        
        // Get enabled plugin tabs for Extensions view
        ipcMain.handle('plugins:get-enabled-tabs', () => {
            return this.getEnabledPluginTabs();
        });
        
        // Set plugin enabled state
        ipcMain.handle('plugins:set-enabled', async (_event, pluginId: string, enabled: boolean) => {
            const newConfig = setPluginEnabled(pluginId, enabled);
            if (newConfig) {
                this.pluginsConfig = newConfig;
                
                // Load or unload the plugin
                if (enabled) {
                    await this.loadPlugin(pluginId);
                } else {
                    await this.unloadPlugin(pluginId);
                }
                
                // Notify frontend
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('plugins:config-updated', newConfig);
                }
                
                return { success: true, config: newConfig };
            }
            return { success: false, error: 'Failed to update plugin config' };
        });
        
        // Reorder plugins
        ipcMain.handle('plugins:reorder', async (_event, newOrder: string[]) => {
            const newConfig = reorderPlugins(newOrder);
            if (newConfig) {
                this.pluginsConfig = newConfig;
                
                // Notify frontend
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('plugins:config-updated', newConfig);
                }
                
                return { success: true, config: newConfig };
            }
            return { success: false, error: 'Failed to reorder plugins' };
        });
        
        // Reset plugins config to defaults
        ipcMain.handle('plugins:reset-config', async () => {
            const discoveredIds = Array.from(this.registry.plugins.keys());
            const newConfig = resetPluginsConfig(discoveredIds);
            this.pluginsConfig = newConfig;
            
            // Reload plugins based on new config
            await this.refreshPlugins();
            
            return { success: true, config: newConfig };
        });
        
        // Install plugin from file path
        ipcMain.handle('plugins:install', async (_event, zipPath: string) => {
            const result = await this.installPlugin(zipPath);
            // Notify frontend after installation
            if (result.success && this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('plugins:updated');
            }
            return result;
        });
        
        // Uninstall plugin
        ipcMain.handle('plugins:uninstall', async (_event, pluginId: string) => {
            const result = await this.uninstallPlugin(pluginId);
            // Notify frontend after uninstallation
            if (result.success && this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('plugins:updated');
            }
            return result;
        });
        
        // Enable/disable plugin
        ipcMain.handle('plugins:toggle', async (_event, pluginId: string, enabled: boolean) => {
            let success: boolean;
            if (enabled) {
                success = await this.loadPlugin(pluginId);
            } else {
                success = await this.unloadPlugin(pluginId);
            }
            // Notify frontend
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('plugins:updated');
            }
            return success;
        });
        
        // Hot reload a plugin
        ipcMain.handle('plugins:reload', async (_event, pluginId: string) => {
            return this.reloadPlugin(pluginId);
        });
        
        // Refresh all plugins
        ipcMain.handle('plugins:refresh', async () => {
            await this.refreshPlugins();
            return true;
        });
        
        // Get plugin frontend content path (for webview)
        ipcMain.handle('plugins:get-frontend-url', (_event, pluginId: string) => {
            const frontendPath = this.getPluginFrontendPath(pluginId);
            if (frontendPath && fs.existsSync(frontendPath)) {
                return `file://${frontendPath}`;
            }
            return null;
        });
        
        // ========== Plugin API IPC Handlers ==========
        
        // Plugin-to-main IPC relay
        ipcMain.handle('plugin:invoke', async (_event, channel: string, pluginId: string, ...args: unknown[]) => {
            // Validate that the request comes from a valid plugin context
            const plugin = this.registry.plugins.get(pluginId);
            if (!plugin || plugin.status !== 'active') {
                throw new Error(`Invalid plugin: ${pluginId}`);
            }
            
            // Route to appropriate handler based on channel
            // Emit an event that can be handled by plugin-specific handlers
            this.emit('plugin-ipc', { pluginId, channel, args });
            return null;
        });
        
        // Backend API proxy for plugins
        ipcMain.handle('plugin:backend-request', async (_event, pluginId: string, endpoint: string, options?: RequestInit) => {
            const plugin = this.registry.plugins.get(pluginId);
            if (!plugin || plugin.status !== 'active') {
                throw new Error(`Invalid plugin: ${pluginId}`);
            }
            
            // Build the full URL - plugins get their own namespace
            const baseUrl = process.env.LOCAL_RAG_API_URL ?? 'http://127.0.0.1:8890';
            const pluginApiBase = `/plugins/${pluginId}`;
            const fullUrl = `${baseUrl}${pluginApiBase}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
            
            try {
                const response = await fetch(fullUrl, {
                    ...options,
                    headers: {
                        'Content-Type': 'application/json',
                        ...(options?.headers || {})
                    }
                });
                
                if (!response.ok) {
                    throw new Error(`Backend responded with ${response.status}: ${await response.text()}`);
                }
                
                return await response.json();
            } catch (error) {
                console.error(`[PluginManager] Backend request failed for plugin ${pluginId}:`, error);
                throw error;
            }
        });
        
        // ========== Plugin Storage Handlers ==========
        
        ipcMain.handle('plugin:storage:get', (_event, pluginId: string, key: string) => {
            return this.getPluginStorage(pluginId, key);
        });
        
        ipcMain.handle('plugin:storage:set', (_event, pluginId: string, key: string, value: unknown) => {
            this.setPluginStorage(pluginId, key, value);
            return true;
        });
        
        ipcMain.handle('plugin:storage:delete', (_event, pluginId: string, key: string) => {
            this.deletePluginStorage(pluginId, key);
            return true;
        });
        
        // ========== Plugin UI Handlers ==========
        
        // Handle plugin notifications
        ipcMain.on('plugin:notification', (_event, pluginId: string, message: string, options?: { type?: string }) => {
            console.log(`[Plugin:${pluginId}] Notification:`, message, options);
            // Forward to main window for display
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('plugin:notification', { pluginId, message, options });
            }
        });
        
        // Handle plugin navigation requests
        ipcMain.on('plugin:navigate', (_event, pluginId: string, view: string, params?: Record<string, string>) => {
            console.log(`[Plugin:${pluginId}] Navigate:`, view, params);
            // Forward to main window for handling
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('synvo:navigate', { view, params, source: pluginId });
            }
        });
        
        // ========== System Utility Handlers (for plugins) ==========
        
        // Open external URL (sandboxed - plugins can't use shell directly)
        ipcMain.handle('system:open-external', async (_event, url: string) => {
            try {
                await shell.openExternal(url);
                return true;
            } catch (error) {
                console.error('[PluginManager] Failed to open external URL:', error);
                return false;
            }
        });
        
        // Get system specs (limited info for plugins)
        ipcMain.handle('system:specs', () => {
            const os = require('os');
            return {
                totalMemory: os.totalmem(),
                platform: process.platform,
                arch: process.arch,
                cpus: os.cpus().length
            };
        });
    }
}

// Singleton instance
let pluginManagerInstance: PluginManager | null = null;

export function getPluginManager(): PluginManager | null {
    return pluginManagerInstance;
}

export function initPluginManager(projectRoot: string): PluginManager {
    if (!pluginManagerInstance) {
        pluginManagerInstance = new PluginManager(projectRoot);
    }
    return pluginManagerInstance;
}

