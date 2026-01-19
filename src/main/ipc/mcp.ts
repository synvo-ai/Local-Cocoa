import { ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { MCPServer } from '../mcpServer';
import { listApiKeys, createApiKey, deleteApiKey, setApiKeyActive, renameApiKey, getOrCreateApiKey } from '../backendClient';

let mcpServer: MCPServer | null = null;

// Name for the Claude Desktop API key
const CLAUDE_DESKTOP_KEY_NAME = 'claude-desktop';

/**
 * Initialize the MCP server instance
 */
export function initMCPServer(): MCPServer {
    if (!mcpServer) {
        mcpServer = new MCPServer();
    }
    return mcpServer;
}

/**
 * Get the MCP server instance
 */
export function getMCPServer(): MCPServer | null {
    return mcpServer;
}

/**
 * Register MCP-related IPC handlers
 */
export function registerMCPHandlers(): void {
    // Get Claude Desktop config for Local Cocoa MCP
    ipcMain.handle('mcp:get-claude-config', async () => {
        const server = initMCPServer();
        return server.generateClaudeConfig();
    });

    // Get Claude Desktop config file path
    ipcMain.handle('mcp:get-claude-config-path', async () => {
        return MCPServer.getClaudeConfigPath();
    });

    // Check if Claude Desktop config exists
    ipcMain.handle('mcp:check-claude-config', async () => {
        const configPath = MCPServer.getClaudeConfigPath();
        return fs.existsSync(configPath);
    });

    // Install MCP config to Claude Desktop
    // This creates a persistent API key for Claude Desktop and installs the config
    ipcMain.handle('mcp:install-to-claude', async () => {
        const server = initMCPServer();
        const configPath = MCPServer.getClaudeConfigPath();

        try {
            // Get or create a persistent API key for Claude Desktop
            const apiKey = await getOrCreateApiKey(CLAUDE_DESKTOP_KEY_NAME);
            
            // Generate config with the persistent key
            const mcpConfig = server.generateClaudeConfigWithKey(apiKey.key);

            // Ensure directory exists
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            // Read existing config or create new
            let existingConfig: Record<string, unknown> = {};
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf-8');
                existingConfig = JSON.parse(content);
            }

            // Merge MCP servers
            const mcpServers = existingConfig.mcpServers as Record<string, unknown> || {};
            Object.assign(mcpServers, mcpConfig);
            existingConfig.mcpServers = mcpServers;

            // Write back
            fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

            return { success: true, path: configPath, apiKeyName: apiKey.name };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Remove MCP config from Claude Desktop and revoke the API key
    ipcMain.handle('mcp:uninstall-from-claude', async () => {
        const configPath = MCPServer.getClaudeConfigPath();

        try {
            // Remove from Claude config file
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf-8');
                const config = JSON.parse(content);

                // Remove local-cocoa from mcpServers
                if (config.mcpServers && config.mcpServers['local-cocoa']) {
                    delete config.mcpServers['local-cocoa'];
                }

                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            }

            // Also revoke the Claude Desktop API key
            try {
                const keys = await listApiKeys();
                const claudeKey = keys.find(k => k.name === CLAUDE_DESKTOP_KEY_NAME && !k.is_system);
                if (claudeKey) {
                    await deleteApiKey(claudeKey.key);
                }
            } catch (keyError) {
                console.warn('Failed to revoke Claude Desktop API key:', keyError);
                // Continue anyway - config is already removed
            }

            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Check if MCP is installed in Claude Desktop
    ipcMain.handle('mcp:is-installed', async () => {
        const configPath = MCPServer.getClaudeConfigPath();

        try {
            if (!fs.existsSync(configPath)) {
                return false;
            }

            const content = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(content);

            return !!(config.mcpServers && config.mcpServers['local-cocoa']);
        } catch {
            return false;
        }
    });

    // Open Claude Desktop config file in editor
    ipcMain.handle('mcp:open-claude-config', async () => {
        const configPath = MCPServer.getClaudeConfigPath();
        if (fs.existsSync(configPath)) {
            shell.openPath(configPath);
            return true;
        }
        return false;
    });

    // Get MCP server status
    ipcMain.handle('mcp:get-status', async () => {
        const server = getMCPServer();
        return {
            initialized: !!server,
            running: server?.isRunning() ?? false,
            pythonPath: server?.getPythonPath() ?? null,
            serverPath: server?.getServerScriptPath() ?? null,
        };
    });

    // Copy config to clipboard (as JSON string)
    // This generates a config with the Claude Desktop key if it exists
    ipcMain.handle('mcp:copy-config', async () => {
        const server = initMCPServer();
        try {
            const keys = await listApiKeys();
            const claudeKey = keys.find(k => k.name === CLAUDE_DESKTOP_KEY_NAME && k.is_active && !k.is_system);
            const apiKey = claudeKey?.key || '';
            const config = server.generateClaudeConfigWithKey(apiKey);
            return JSON.stringify({ mcpServers: config }, null, 2);
        } catch {
            const config = server.generateClaudeConfigWithKey('');
            return JSON.stringify({ mcpServers: config }, null, 2);
        }
    });

    // ========================================
    // API Key Management for MCP Connections
    // ========================================

    // List all non-system API keys (external app connections)
    ipcMain.handle('mcp:list-connections', async () => {
        try {
            const keys = await listApiKeys();
            // Filter to only show non-system keys (external app connections)
            return keys.filter(k => !k.is_system).map(k => ({
                name: k.name,
                key: k.key,
                createdAt: k.created_at,
                lastUsedAt: k.last_used_at,
                isActive: k.is_active
            }));
        } catch (error: any) {
            console.error('Failed to list connections:', error);
            return [];
        }
    });

    // Create a new connection (API key) for an external app
    ipcMain.handle('mcp:create-connection', async (_event, name: string) => {
        try {
            const key = await createApiKey(name);
            return {
                success: true,
                connection: {
                    name: key.name,
                    key: key.key,
                    createdAt: key.created_at,
                    lastUsedAt: key.last_used_at,
                    isActive: key.is_active
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Revoke a connection (delete API key)
    ipcMain.handle('mcp:revoke-connection', async (_event, key: string) => {
        try {
            await deleteApiKey(key);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Enable or disable a connection (without deleting)
    ipcMain.handle('mcp:set-connection-active', async (_event, key: string, isActive: boolean) => {
        try {
            await setApiKeyActive(key, isActive);
            return { success: true, isActive };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Rename a connection
    ipcMain.handle('mcp:rename-connection', async (_event, key: string, newName: string) => {
        try {
            await renameApiKey(key, newName);
            return { success: true, name: newName };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Get the Claude Desktop connection status
    ipcMain.handle('mcp:get-claude-connection', async () => {
        try {
            const keys = await listApiKeys();
            const claudeKey = keys.find(k => k.name === CLAUDE_DESKTOP_KEY_NAME && k.is_active && !k.is_system);
            if (claudeKey) {
                return {
                    connected: true,
                    key: claudeKey.key,
                    createdAt: claudeKey.created_at,
                    lastUsedAt: claudeKey.last_used_at
                };
            }
            return { connected: false };
        } catch {
            return { connected: false };
        }
    });
}

