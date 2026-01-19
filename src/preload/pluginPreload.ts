/**
 * Plugin Preload Script
 * Provides a sandboxed API for plugins running in isolated webviews
 */

import { contextBridge, ipcRenderer } from 'electron';

// Extract plugin ID from command line arguments
const pluginIdArg = process.argv.find(arg => arg.startsWith('--plugin-id='));
const pluginId = pluginIdArg ? pluginIdArg.split('=')[1] : 'unknown';

// Scoped IPC channel names
const scopedChannel = (channel: string) => `plugin:${pluginId}:${channel}`;

/**
 * Plugin API exposed to plugin webviews
 * All communication goes through the main process for security
 */
const pluginAPI = {
    // Plugin identity
    getPluginId: () => pluginId,
    
    // Invoke main process handler with plugin context
    invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
        return ipcRenderer.invoke('plugin:invoke', channel, pluginId, ...args);
    },
    
    // Send message to main process
    send: (channel: string, ...args: unknown[]): void => {
        ipcRenderer.send(scopedChannel(channel), ...args);
    },
    
    // Listen for messages from main process
    on: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
        const fullChannel = scopedChannel(channel);
        const listener = (_event: unknown, ...args: unknown[]) => callback(...args);
        ipcRenderer.on(fullChannel, listener);
        return () => {
            ipcRenderer.removeListener(fullChannel, listener);
        };
    },
    
    // Backend API request (proxied through main process)
    backendRequest: async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
        return ipcRenderer.invoke('plugin:backend-request', pluginId, endpoint, options);
    },
    
    // Scoped storage
    storage: {
        get: async <T>(key: string): Promise<T | null> => {
            return ipcRenderer.invoke('plugin:storage:get', pluginId, key);
        },
        set: async <T>(key: string, value: T): Promise<void> => {
            return ipcRenderer.invoke('plugin:storage:set', pluginId, key, value);
        },
        delete: async (key: string): Promise<void> => {
            return ipcRenderer.invoke('plugin:storage:delete', pluginId, key);
        }
    },
    
    // UI utilities
    showNotification: (message: string, options?: { type?: 'info' | 'success' | 'warning' | 'error' }): void => {
        ipcRenderer.send('plugin:notification', pluginId, message, options);
    },
    
    navigate: (view: string, params?: Record<string, string>): void => {
        ipcRenderer.send('plugin:navigate', pluginId, view, params);
    },
    
    // Access to common app APIs through main process relay
    app: {
        // Open external URL
        openExternal: (url: string): Promise<boolean> => {
            return ipcRenderer.invoke('system:open-external', url);
        },
        
        // Get system info
        getSystemSpecs: (): Promise<{ totalMemory: number; platform: string; arch: string; cpus: number }> => {
            return ipcRenderer.invoke('system:specs');
        }
    }
};

// Expose to renderer
contextBridge.exposeInMainWorld('pluginAPI', pluginAPI);
contextBridge.exposeInMainWorld('PLUGIN_ID', pluginId);

// Type declaration for TypeScript
declare global {
    interface Window {
        pluginAPI: typeof pluginAPI;
        PLUGIN_ID: string;
    }
}

