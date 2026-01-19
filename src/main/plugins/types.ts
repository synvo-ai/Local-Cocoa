/**
 * Plugin System Type Definitions
 * Defines the structure of plugins, their metadata, and UI extension points
 */

export type PluginUIEntryType = 
    | 'primary'      // Primary entry point (top-level tab in sidebar)
    | 'secondary'    // Secondary entry point (sub-tab within a primary entry)
    | 'settings';    // Tab within the Settings panel

export interface PluginUIEntry {
    id: string;
    label: string;
    icon?: string;          // Lucide icon name or custom icon path
    parentId?: string;      // For secondary entries, the ID of the parent entry
    order?: number;         // Order within the same level
    badge?: string;         // Badge text (e.g., count)
}

export interface PluginManifest {
    id: string;                              // Unique plugin identifier (e.g., "com.synvo.activity")
    name: string;                            // Display name
    version: string;                         // Semantic version
    description?: string;                    // Short description
    author?: string;                         // Author name
    homepage?: string;                       // Homepage URL
    
    // Capabilities
    frontend?: {
        entrypoint: string;                  // Path to main HTML/JS file relative to frontend/
        uiEntries?: PluginUIEntry[];         // UI extension points this plugin provides
        preloadScript?: string;              // Custom preload script (optional)
    };
    
    backend?: {
        entrypoint: string;                  // Python module path relative to backend/ (e.g., "router")
        routerModule?: string;               // Module containing the FastAPI router
        dbInit?: string;                     // Database initialization script
        dbMigrate?: string;                  // Database migration script
        requirements?: string;               // requirements.txt path
    };
    
    // Dependencies
    dependencies?: {
        plugins?: string[];                  // Other plugins this depends on
        minAppVersion?: string;              // Minimum app version required
    };
    
    // Permissions
    permissions?: string[];                  // Required permissions (future use)
    
    // Plugin category
    category?: 'core' | 'productivity' | 'integration' | 'custom';
}

export type PluginStatus = 
    | 'installed'    // Installed but not loaded
    | 'loading'      // Currently loading
    | 'active'       // Loaded and running
    | 'error'        // Failed to load
    | 'disabled';    // Installed but disabled

export interface PluginInstance {
    manifest: PluginManifest;
    status: PluginStatus;
    error?: string;
    path: string;                            // Path to plugin directory
    
    // Runtime state
    webviewId?: number;                      // BrowserView ID if using webview isolation
    backendLoaded?: boolean;                 // Whether backend router is registered
}

export interface PluginRegistry {
    plugins: Map<string, PluginInstance>;
    uiEntries: Map<string, PluginUIEntry & { pluginId: string }>;
}

// IPC message types for plugin communication
export interface PluginIPCMessage {
    type: string;
    pluginId: string;
    payload: unknown;
}

// Plugin API exposed to plugin webviews via contextBridge
export interface PluginAPI {
    // Plugin identity
    getPluginId(): string;
    getManifest(): PluginManifest;
    
    // Communication with main process
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    send(channel: string, ...args: unknown[]): void;
    on(channel: string, callback: (...args: unknown[]) => void): () => void;
    
    // Backend API access (proxied through main process)
    backendRequest<T>(endpoint: string, options?: RequestInit): Promise<T>;
    
    // Storage (scoped to plugin)
    storage: {
        get<T>(key: string): Promise<T | null>;
        set<T>(key: string, value: T): Promise<void>;
        delete(key: string): Promise<void>;
    };
    
    // UI utilities
    showNotification(message: string, options?: { type?: 'info' | 'success' | 'warning' | 'error' }): void;
    navigate(view: string, params?: Record<string, string>): void;
}

// Events emitted by the plugin system
export type PluginSystemEvent = 
    | { type: 'plugin-loaded'; pluginId: string }
    | { type: 'plugin-unloaded'; pluginId: string }
    | { type: 'plugin-error'; pluginId: string; error: string }
    | { type: 'ui-entry-added'; entry: PluginUIEntry & { pluginId: string } }
    | { type: 'ui-entry-removed'; entryId: string };

