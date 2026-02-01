import { contextBridge, ipcRenderer } from 'electron';

import type {
    EmailAccountPayload,
    EmailAccountSummary,
    EmailMessageContent,
    EmailMessageSummary,
    EmailSyncResult,
    FileListResponse,
    FileRecord,
    FolderRecord,
    HealthStatus,
    IndexInventory,
    IndexProgressUpdate,
    IndexSummary,
    NoteContent,
    NoteDraftPayload,
    NoteSummary,
    QaResponse,
    SearchResponse,
    ModelStatusSummary,
    ModelDownloadEvent,
    ChatSession,
    ConversationMessage,
    ChunkSnapshot,
    ScannedFile,
    ScanProgress,
    ScanDirectory,
    ScanSettings,
    ScanOptions,
    FolderNode,
    FileKind,
} from '../types/files';

type SpotlightFilePayload = { fileId: string };
type RunIndexOptions = {
    mode?: 'rescan' | 'reindex';
    scope?: 'global' | 'folder' | 'email' | 'notes';
    folders?: string[];
    files?: string[];
    refreshEmbeddings?: boolean;
    dropCollection?: boolean;
    purgeFolders?: string[];
    indexing_mode?: 'fast' | 'deep';
};

const api = {
    pickFolders: (): Promise<string[]> => ipcRenderer.invoke('folders:pick'),
    listFolders: (): Promise<FolderRecord[]> => ipcRenderer.invoke('folders:list'),
    addFolder: (path: string, label?: string, scanMode?: 'full' | 'manual'): Promise<FolderRecord> =>
        ipcRenderer.invoke('folders:add', { path, label, scanMode }),
    removeFolder: (folderId: string): Promise<{ id: string }> =>
        ipcRenderer.invoke('folders:remove', folderId),
    getLocalKey: (): Promise<string> => ipcRenderer.invoke('auth:get-local-key'),
    runIndex: (options?: RunIndexOptions): Promise<IndexProgressUpdate> =>
        ipcRenderer.invoke('index:run', options ?? {}),
    indexFolder: (folderId: string): Promise<IndexProgressUpdate> =>
        ipcRenderer.invoke('index:run', { folders: [folderId], mode: 'rescan' }),
    indexFile: (path: string): Promise<IndexProgressUpdate> =>
        ipcRenderer.invoke('index:run', { files: [path], mode: 'rescan' }),
    indexStatus: (): Promise<IndexProgressUpdate> => ipcRenderer.invoke('index:status'),
    indexSummary: (): Promise<IndexSummary> => ipcRenderer.invoke('index:summary'),
    pauseIndexing: (): Promise<IndexProgressUpdate> => ipcRenderer.invoke('index:pause'),
    resumeIndexing: (): Promise<IndexProgressUpdate> => ipcRenderer.invoke('index:resume'),

    // Staged indexing (two-round progressive system)
    stageProgress: (folderId?: string): Promise<any> =>
        ipcRenderer.invoke('index:stage-progress', folderId),
    getErrorFiles: (folderId?: string): Promise<Array<{id: string; name: string; path: string; error_reason: string | null; error_at: string | null}>> =>
        ipcRenderer.invoke('index:error-files', folderId),
    startSemanticIndexing: (): Promise<any> =>
        ipcRenderer.invoke('index:start-semantic'),
    stopSemanticIndexing: (): Promise<any> =>
        ipcRenderer.invoke('index:stop-semantic'),
    startDeepIndexing: (): Promise<any> =>
        ipcRenderer.invoke('index:start-deep'),
    stopDeepIndexing: (): Promise<any> =>
        ipcRenderer.invoke('index:stop-deep'),
    deepStatus: (): Promise<any> =>
        ipcRenderer.invoke('index:deep-status'),
    runStagedIndex: (options?: { folders?: string[]; files?: string[]; mode?: 'rescan' | 'reindex' }): Promise<IndexProgressUpdate> =>
        ipcRenderer.invoke('index:run-staged', options),

    indexInventory: (options?: { folderId?: string; limit?: number; offset?: number }): Promise<IndexInventory> =>
        ipcRenderer.invoke('index:list', options ?? {}),
    listFiles: (limit?: number, offset?: number): Promise<FileListResponse> =>
        ipcRenderer.invoke('files:list', { limit, offset }),
    getFile: (fileId: string): Promise<FileRecord | null> =>
        ipcRenderer.invoke('files:get', fileId),
    getChunk: (chunkId: string): Promise<ChunkSnapshot | null> =>
        ipcRenderer.invoke('files:get-chunk', chunkId),
    listFileChunks: (fileId: string): Promise<ChunkSnapshot[]> =>
        ipcRenderer.invoke('files:list-chunks', fileId),
    getChunkHighlight: (chunkId: string, zoom?: number): Promise<string> =>
        ipcRenderer.invoke('files:chunk-highlight', { chunkId, zoom }),
    getPdfPageImage: (fileId: string, pageNumber: number, zoom?: number): Promise<string> =>
        ipcRenderer.invoke('files:pdf-page-image', { fileId, pageNumber, zoom }),
    openFile: (filePath: string): Promise<{ path: string }> =>
        ipcRenderer.invoke('files:open', { path: filePath }),
    deleteFile: (fileId: string): Promise<{ id: string }> => ipcRenderer.invoke('files:delete', fileId),
    search: (query: string, limit?: number): Promise<SearchResponse> =>
        ipcRenderer.invoke('search:query', { query, limit }),

    // Progressive/layered search with streaming results
    searchStream: (query: string, limit?: number, callbacks?: {
        onData: (chunk: string) => void;
        onError: (error: string) => void;
        onDone: () => void;
    }): () => void => {
        const dataChannel = 'search:stream-data';
        const errorChannel = 'search:stream-error';
        const doneChannel = 'search:stream-done';

        const onData = (_event: unknown, chunk: string) => callbacks?.onData(chunk);
        const onError = (_event: unknown, error: string) => callbacks?.onError(error);
        const onDone = (_event: unknown) => callbacks?.onDone();

        ipcRenderer.on(dataChannel, onData);
        ipcRenderer.on(errorChannel, onError);
        ipcRenderer.on(doneChannel, onDone);

        ipcRenderer.send('search:stream', { query, limit });

        return () => {
            ipcRenderer.removeListener(dataChannel, onData);
            ipcRenderer.removeListener(errorChannel, onError);
            ipcRenderer.removeListener(doneChannel, onDone);
        };
    },

    ask: (query: string, limit?: number, mode?: 'qa' | 'chat', searchMode?: 'auto' | 'knowledge' | 'direct'): Promise<QaResponse> =>
        ipcRenderer.invoke('qa:ask', { query, limit, mode, searchMode }),
    health: (): Promise<HealthStatus> => ipcRenderer.invoke('health:ping'),
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('system:open-external', url),
    showInFolder: (filePath: string): Promise<boolean> => ipcRenderer.invoke('system:show-in-folder', filePath),
    getSystemSpecs: (): Promise<{ totalMemory: number; platform: string; arch: string; cpus: number }> =>
        ipcRenderer.invoke('system:specs'),
    saveImage: (options: { data: string; defaultName?: string; title?: string }): Promise<{ saved: boolean; path: string | null }> =>
        ipcRenderer.invoke('system:save-image', options),
    exportLogs: (): Promise<{ exported: boolean; path: string | null; error?: string }> =>
        ipcRenderer.invoke('system:export-logs'),
    getLogsPath: (): Promise<string> =>
        ipcRenderer.invoke('system:get-logs-path'),
    listEmailAccounts: (): Promise<EmailAccountSummary[]> => ipcRenderer.invoke('email:list'),
    addEmailAccount: (payload: EmailAccountPayload): Promise<EmailAccountSummary> =>
        ipcRenderer.invoke('email:add', payload),
    removeEmailAccount: (accountId: string): Promise<{ id: string }> =>
        ipcRenderer.invoke('email:remove', accountId),
    syncEmailAccount: (accountId: string, limit?: number): Promise<EmailSyncResult> =>
        ipcRenderer.invoke('email:sync', { accountId, limit }),
    listEmailMessages: (accountId: string, limit?: number): Promise<EmailMessageSummary[]> =>
        ipcRenderer.invoke('email:messages', { accountId, limit }),
    getEmailMessage: (messageId: string): Promise<EmailMessageContent> =>
        ipcRenderer.invoke('email:message', { messageId }),
    listNotes: (): Promise<NoteSummary[]> => ipcRenderer.invoke('notes:list'),
    createNote: (payload: NoteDraftPayload): Promise<NoteSummary> =>
        ipcRenderer.invoke('notes:create', payload),
    getNote: (noteId: string): Promise<NoteContent> => ipcRenderer.invoke('notes:get', { noteId }),
    updateNote: (noteId: string, payload: NoteDraftPayload): Promise<NoteContent> =>
        ipcRenderer.invoke('notes:update', { noteId, payload }),
    deleteNote: (noteId: string): Promise<{ id: string }> =>
        ipcRenderer.invoke('notes:delete', { noteId }),
    showSpotlightWindow: (): Promise<unknown> => ipcRenderer.invoke('spotlight:show'),
    toggleSpotlightWindow: (): Promise<unknown> => ipcRenderer.invoke('spotlight:toggle'),
    hideSpotlightWindow: (): void => {
        ipcRenderer.send('spotlight:hide');
    },
    spotlightFocusFile: (fileId: string): void => {
        const payload: SpotlightFilePayload = { fileId };
        ipcRenderer.send('spotlight:focus-request', payload);
    },
    spotlightOpenFile: (fileId: string): void => {
        const payload: SpotlightFilePayload = { fileId };
        ipcRenderer.send('spotlight:open-request', payload);
    },
    onSpotlightFocusFile: (callback: (payload: SpotlightFilePayload) => void): (() => void) => {
        const channel = 'spotlight:focus';
        const listener = (_event: unknown, payload: SpotlightFilePayload) => {
            callback(payload);
        };
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },
    onSpotlightOpenFile: (callback: (payload: SpotlightFilePayload) => void): (() => void) => {
        const channel = 'spotlight:open';
        const listener = (_event: unknown, payload: SpotlightFilePayload) => {
            callback(payload);
        };
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },
    onSpotlightTabSwitch: (callback: (payload: { tab: 'search' | 'notes' }) => void): (() => void) => {
        const channel = 'spotlight:switch-tab';
        const listener = (_event: unknown, payload: { tab: 'search' | 'notes' }) => {
            callback(payload);
        };
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },
    // Notify all windows that notes have changed
    notifyNotesChanged: (): void => {
        ipcRenderer.send('notes:changed');
    },
    onNotesChanged: (callback: () => void): (() => void) => {
        const channel = 'notes:refresh';
        const listener = () => callback();
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },
    modelStatus: (): Promise<ModelStatusSummary> => ipcRenderer.invoke('models:status'),
    downloadModels: (): Promise<ModelStatusSummary> => ipcRenderer.invoke('models:download'),
    redownloadModel: (assetId: string): Promise<ModelStatusSummary> => ipcRenderer.invoke('models:redownload', assetId),
    getModelConfig: (): Promise<any> => ipcRenderer.invoke('models:get-config'),
    setModelConfig: (config: any): Promise<any> => ipcRenderer.invoke('models:set-config', config),
    addModel: (descriptor: any): Promise<any> => ipcRenderer.invoke('models:add', descriptor),
    pickFile: (options?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null> =>
        ipcRenderer.invoke('files:pick-one', options),
    pickFiles: (options?: { filters?: { name: string; extensions: string[] }[] }): Promise<string[]> =>
        ipcRenderer.invoke('files:pick-multiple', options),
    onModelDownloadEvent: (callback: (event: ModelDownloadEvent) => void) => {
        const subscription = (_event: any, payload: ModelDownloadEvent) => callback(payload);
        ipcRenderer.on('models:progress', subscription);
        return () => ipcRenderer.removeListener('models:progress', subscription);
    },

    ingestScreenshot: (image: Uint8Array) => ipcRenderer.invoke('activity:ingest', { image }),
    getActivityTimeline: (start?: string, end?: string, summary?: boolean) => ipcRenderer.invoke('activity:timeline', { start, end, summary }),
    deleteActivityLog: (logId: string) => ipcRenderer.invoke('activity:delete', { logId }),
    captureScreen: () => ipcRenderer.invoke('activity:capture'),
    readImage: (filePath: string): Promise<string> => ipcRenderer.invoke('files:read-image', { filePath }),
    askStream: (query: string, limit?: number, mode?: 'qa' | 'chat', callbacks?: {
        onData: (chunk: string) => void;
        onError: (error: string) => void;
        onDone: () => void;
    }, searchMode?: 'auto' | 'knowledge' | 'direct', resumeToken?: string, useVisionForAnswer?: boolean): () => void => {
        const dataChannel = 'qa:stream-data';
        const errorChannel = 'qa:stream-error';
        const doneChannel = 'qa:stream-done';

        const onData = (_event: unknown, chunk: string) => callbacks?.onData(chunk);
        const onError = (_event: unknown, error: string) => callbacks?.onError(error);
        const onDone = (_event: unknown) => callbacks?.onDone();

        ipcRenderer.on(dataChannel, onData);
        ipcRenderer.on(errorChannel, onError);
        ipcRenderer.on(doneChannel, onDone);

        ipcRenderer.send('qa:ask-stream', { query, limit, mode, searchMode, resumeToken, useVisionForAnswer });

        return () => {
            ipcRenderer.removeListener(dataChannel, onData);
            ipcRenderer.removeListener(errorChannel, onError);
            ipcRenderer.removeListener(doneChannel, onDone);
        };
    },
    // Outlook auth
    startOutlookAuth: (clientId: string, tenantId: string): Promise<{ flow_id: string }> =>
        ipcRenderer.invoke('email:outlook:auth', { clientId, tenantId }),
    getOutlookAuthStatus: (flowId: string): Promise<any> =>
        ipcRenderer.invoke('email:outlook:status', flowId),
    completeOutlookSetup: (flowId: string, label: string): Promise<EmailAccountSummary> =>
        ipcRenderer.invoke('email:outlook:complete', { flowId, label }),

    listChatSessions: (limit?: number, offset?: number): Promise<ChatSession[]> =>
        ipcRenderer.invoke('chat:list', { limit, offset }),
    createChatSession: (title?: string): Promise<ChatSession> =>
        ipcRenderer.invoke('chat:create', { title }),
    getChatSession: (sessionId: string): Promise<ChatSession> =>
        ipcRenderer.invoke('chat:get', { sessionId }),
    deleteChatSession: (sessionId: string): Promise<{ id: string }> =>
        ipcRenderer.invoke('chat:delete', { sessionId }),
    updateChatSession: (sessionId: string, title: string): Promise<ChatSession> =>
        ipcRenderer.invoke('chat:update', { sessionId, title }),
    addChatMessage: (sessionId: string, message: Partial<ConversationMessage>): Promise<ConversationMessage> =>
        ipcRenderer.invoke('chat:add-message', { sessionId, message }),

    // ========================================
    // Enhanced File System Scan APIs
    // ========================================

    // Get smart recommended directories based on OS
    getRecommendedDirectories: (): Promise<ScanDirectory[]> =>
        ipcRenderer.invoke('scan:get-recommended-directories'),

    // Get exclusion rules
    getExclusions: (): Promise<{ system: string[]; universal: string[] }> =>
        ipcRenderer.invoke('scan:get-exclusions'),

    // Load saved scan settings
    getScanSettings: (): Promise<ScanSettings> =>
        ipcRenderer.invoke('scan:get-settings'),

    // Save scan settings
    saveScanSettings: (settings: ScanSettings): Promise<{ success: boolean }> =>
        ipcRenderer.invoke('scan:save-settings', settings),

    // Pick directories dialog
    pickScanDirectories: (): Promise<ScanDirectory[]> =>
        ipcRenderer.invoke('scan:pick-directories'),

    // Build folder tree from scanned files
    buildFolderTree: (payload: {
        files: ScannedFile[];
        rootPaths: string[];
        filterKind?: FileKind
    }): Promise<FolderNode[]> =>
        ipcRenderer.invoke('scan:build-tree', payload),

    // Start scan with streaming results
    scanFiles: (options: {
        daysBack: number | null;
        dateFrom?: string | null; // ISO date string for year-based or custom ranges
        dateTo?: string | null; // ISO date string for year-based or custom ranges
        directories: string[];
        useRecommendedExclusions?: boolean;
        customExclusions?: string[];
        onProgress?: (progress: ScanProgress) => void;
        onFiles?: (files: ScannedFile[]) => void;
        onComplete?: (result: { files: ScannedFile[]; folderTree: FolderNode[]; partial: boolean }) => void;
        onError?: (error: string) => void;
    }): (() => void) => {
        const progressChannel = 'scan:progress';
        const filesChannel = 'scan:files';
        const doneChannel = 'scan:done';
        const errorChannel = 'scan:error';

        const onProgress = (_event: unknown, progress: ScanProgress) => options.onProgress?.(progress);
        const onFiles = (_event: unknown, files: ScannedFile[]) => options.onFiles?.(files);
        const onDone = (_event: unknown, result: { files: ScannedFile[]; folderTree: FolderNode[]; partial: boolean }) =>
            options.onComplete?.(result);
        const onError = (_event: unknown, error: string) => options.onError?.(error);

        ipcRenderer.on(progressChannel, onProgress);
        ipcRenderer.on(filesChannel, onFiles);
        ipcRenderer.on(doneChannel, onDone);
        ipcRenderer.on(errorChannel, onError);

        const scanOptions: ScanOptions = {
            daysBack: options.daysBack,
            dateFrom: options.dateFrom,
            dateTo: options.dateTo,
            directories: options.directories,
            useRecommendedExclusions: options.useRecommendedExclusions ?? true,
            customExclusions: options.customExclusions,
        };

        ipcRenderer.send('scan:start', scanOptions);

        return () => {
            ipcRenderer.removeListener(progressChannel, onProgress);
            ipcRenderer.removeListener(filesChannel, onFiles);
            ipcRenderer.removeListener(doneChannel, onDone);
            ipcRenderer.removeListener(errorChannel, onError);
            ipcRenderer.send('scan:cancel');
        };
    },

    cancelScan: (): void => {
        ipcRenderer.send('scan:cancel');
    },

    // ========================================
    // MCP (Model Context Protocol) APIs
    // ========================================

    // Get Claude Desktop config for Local Cocoa MCP
    mcpGetClaudeConfig: (): Promise<object> =>
        ipcRenderer.invoke('mcp:get-claude-config'),

    // Get Claude Desktop config file path
    mcpGetClaudeConfigPath: (): Promise<string> =>
        ipcRenderer.invoke('mcp:get-claude-config-path'),

    // Check if Claude Desktop config exists
    mcpCheckClaudeConfig: (): Promise<boolean> =>
        ipcRenderer.invoke('mcp:check-claude-config'),

    // Install MCP config to Claude Desktop
    mcpInstallToClaude: (): Promise<{ success: boolean; path?: string; error?: string }> =>
        ipcRenderer.invoke('mcp:install-to-claude'),

    // Remove MCP config from Claude Desktop
    mcpUninstallFromClaude: (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('mcp:uninstall-from-claude'),

    // Check if MCP is installed in Claude Desktop
    mcpIsInstalled: (): Promise<boolean> =>
        ipcRenderer.invoke('mcp:is-installed'),

    // Open Claude Desktop config file in editor
    mcpOpenClaudeConfig: (): Promise<boolean> =>
        ipcRenderer.invoke('mcp:open-claude-config'),

    // Get MCP server status
    mcpGetStatus: (): Promise<{
        initialized: boolean;
        running: boolean;
        pythonPath: string | null;
        serverPath: string | null;
    }> => ipcRenderer.invoke('mcp:get-status'),

    // Copy config to clipboard (returns JSON string)
    mcpCopyConfig: (): Promise<string> =>
        ipcRenderer.invoke('mcp:copy-config'),

    // List all external app connections (non-system API keys)
    mcpListConnections: (): Promise<{
        name: string;
        key: string;
        createdAt: string;
        lastUsedAt: string | null;
        isActive: boolean;
    }[]> => ipcRenderer.invoke('mcp:list-connections'),

    onMCPActivity: (callback: (activity: any) => void) => {
        const channel = 'mcp:activity';
        const listener = (_event: unknown, data: any) => callback(data);
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },

    closeMCPWindow: (): void => ipcRenderer.send('mcp:close-window'),

    // Create a new connection for an external app
    mcpCreateConnection: (name: string): Promise<{
        success: boolean;
        connection?: {
            name: string;
            key: string;
            createdAt: string;
            lastUsedAt: string | null;
            isActive: boolean;
        };
        error?: string;
    }> => ipcRenderer.invoke('mcp:create-connection', name),

    // Revoke a connection (delete API key)
    mcpRevokeConnection: (key: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('mcp:revoke-connection', key),

    // Enable or disable a connection (without deleting)
    mcpSetConnectionActive: (key: string, isActive: boolean): Promise<{ success: boolean; isActive?: boolean; error?: string }> =>
        ipcRenderer.invoke('mcp:set-connection-active', key, isActive),

    // Rename a connection
    mcpRenameConnection: (key: string, newName: string): Promise<{ success: boolean; name?: string; error?: string }> =>
        ipcRenderer.invoke('mcp:rename-connection', key, newName),

    // Get Claude Desktop connection status
    mcpGetClaudeConnection: (): Promise<{
        connected: boolean;
        key?: string;
        createdAt?: string;
        lastUsedAt?: string | null;
    }> => ipcRenderer.invoke('mcp:get-claude-connection'),

    // ========================================
    // Plugin System APIs
    // ========================================

    // List all installed plugins
    listPlugins: (): Promise<any[]> =>
        ipcRenderer.invoke('plugins:list'),

    // Get UI entries from plugins
    getPluginUIEntries: (): Promise<any[]> =>
        ipcRenderer.invoke('plugins:ui-entries'),

    // Get plugins configuration
    getPluginsConfig: (): Promise<any> =>
        ipcRenderer.invoke('plugins:get-config'),

    // Get plugin manifests with user config
    getPluginManifests: (): Promise<any[]> =>
        ipcRenderer.invoke('plugins:get-manifests'),

    // Get enabled plugin tabs for Extensions view
    getEnabledPluginTabs: (): Promise<Array<{
        id: string;
        pluginId: string;
        label: string;
        icon: string;
        component?: string;
    }>> => ipcRenderer.invoke('plugins:get-enabled-tabs'),

    // Set plugin enabled state
    setPluginEnabled: (pluginId: string, enabled: boolean): Promise<{ success: boolean; config?: any; error?: string }> =>
        ipcRenderer.invoke('plugins:set-enabled', pluginId, enabled),

    // Reorder plugins
    reorderPlugins: (newOrder: string[]): Promise<{ success: boolean; config?: any; error?: string }> =>
        ipcRenderer.invoke('plugins:reorder', newOrder),

    // Reset plugins config to defaults
    resetPluginsConfig: (): Promise<{ success: boolean; config?: any }> =>
        ipcRenderer.invoke('plugins:reset-config'),

    // Install a plugin from file
    installPlugin: (zipPath: string): Promise<{ success: boolean; pluginId?: string; error?: string }> =>
        ipcRenderer.invoke('plugins:install', zipPath),

    // Uninstall a plugin
    uninstallPlugin: (pluginId: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('plugins:uninstall', pluginId),

    // Enable/disable a plugin (legacy - use setPluginEnabled instead)
    togglePlugin: (pluginId: string, enabled: boolean): Promise<boolean> =>
        ipcRenderer.invoke('plugins:toggle', pluginId, enabled),

    // Hot reload a plugin (unload and reload without app restart)
    reloadPlugin: (pluginId: string): Promise<boolean> =>
        ipcRenderer.invoke('plugins:reload', pluginId),

    // Refresh all plugins (rediscover and reload)
    refreshPlugins: (): Promise<boolean> =>
        ipcRenderer.invoke('plugins:refresh'),

    // Get frontend URL for a plugin
    getPluginFrontendUrl: (pluginId: string): Promise<string | null> =>
        ipcRenderer.invoke('plugins:get-frontend-url', pluginId),

    // Pick a plugin file for installation
    pickPluginFile: (): Promise<string | null> =>
        ipcRenderer.invoke('files:pick-one', {
            filters: [{ name: 'Synvo Plugin', extensions: ['synvo-plugin', 'zip'] }]
        }),

    // Listen for plugin events
    onPluginEvent: (callback: (event: { type: string; pluginId: string;[key: string]: any }) => void): (() => void) => {
        const channel = 'plugin:event';
        const listener = (_event: unknown, payload: any) => callback(payload);
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },

    // Listen for plugin updates (hot reload notifications)
    onPluginsUpdated: (callback: () => void): (() => void) => {
        const channel = 'plugins:updated';
        const listener = () => callback();
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },

    // Listen for plugins config updates
    onPluginsConfigUpdated: (callback: (config: any) => void): (() => void) => {
        const channel = 'plugins:config-updated';
        const listener = (_event: unknown, payload: any) => callback(payload);
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },

    // Listen for plugin notifications
    onPluginNotification: (callback: (notification: { pluginId: string; message: string; options?: { type?: string } }) => void): (() => void) => {
        const channel = 'plugin:notification';
        const listener = (_event: unknown, payload: any) => callback(payload);
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    },

    // ========================================
    // User Memory APIs
    // ========================================

    // Get memory summary for a user
    memoryGetSummary: (userId: string): Promise<any> =>
        ipcRenderer.invoke('memory:summary', { userId }),

    // Get episodic memories
    memoryGetEpisodes: (userId: string, limit?: number, offset?: number): Promise<any[]> =>
        ipcRenderer.invoke('memory:episodes', { userId, limit, offset }),

    // Get event logs
    memoryGetEventLogs: (userId: string, limit?: number, offset?: number): Promise<any[]> =>
        ipcRenderer.invoke('memory:events', { userId, limit, offset }),

    // Get foresights
    memoryGetForesights: (userId: string, limit?: number): Promise<any[]> =>
        ipcRenderer.invoke('memory:foresights', { userId, limit }),

    // Get memcells
    memoryGetMemcells: (userId: string, limit?: number, offset?: number): Promise<any[]> =>
        ipcRenderer.invoke('memory:memcells', { userId, limit, offset }),

    // Get memcell detail
    memoryGetMemcellDetail: (memcellId: string): Promise<any> =>
        ipcRenderer.invoke('memory:memcell-detail', { memcellId }),

    // Get memcells by file
    memoryGetMemcellsByFile: (fileId: string, limit?: number): Promise<any[]> =>
        ipcRenderer.invoke('memory:memcells-by-file', { fileId, limit }),

    // Get LLM-inferred basic profile from system data (hierarchical structure)
    memoryGetBasicProfile: (userId: string): Promise<{
        user_id: string;
        user_name?: string;
        // Hierarchical topics
        topics: Array<{
            topic_id: string;
            topic_name: string;
            icon?: string;
            subtopics: Array<{
                name: string;
                description?: string;
                value?: any;
                confidence?: string;  // high, medium, low
                evidence?: string;
            }>;
        }>;
        // Legacy flat fields (backward compatibility)
        personality: string[];
        interests: string[];
        hard_skills: Array<{ name: string; level?: string }>;
        soft_skills: Array<{ name: string; level?: string }>;
        working_habit_preference: string[];
        user_goal: string[];
        motivation_system: string[];
        value_system: string[];
        inferred_roles: string[];
        raw_system_data?: {
            username: string;
            computer_name: string;
            shell: string;
            language: string;
            region: string;
            timezone: string;
            appearance: string;
            installed_apps: string[];
            dev_tools: Array<{ name: string; version: string }>;
        };
        scanned_at: string;
    }> => ipcRenderer.invoke('memory:basic-profile', { userId }),

    // Get cached basic profile (without regenerating, returns null if not found)
    memoryGetCachedBasicProfile: (userId: string): Promise<{
        user_id: string;
        user_name?: string;
        topics: Array<{
            topic_id: string;
            topic_name: string;
            icon?: string;
            subtopics: Array<{
                name: string;
                value?: any;
                confidence?: string;
                evidence?: string;
            }>;
        }>;
        raw_system_data?: {
            username: string;
            computer_name: string;
            shell: string;
            language: string;
            region: string;
            timezone: string;
            appearance: string;
            installed_apps: string[];
            dev_tools: Array<{ name: string; version: string }>;
        };
        scanned_at: string;
    } | null> => ipcRenderer.invoke('memory:basic-profile-cached', { userId }),

    // Stream basic profile generation progressively
    // Returns cleanup function to stop listening
    memoryStreamBasicProfile: (
        userId: string,
        onEvent: (event: {
            type: 'init' | 'topic' | 'complete' | 'error';
            data: any;
        }) => void
    ): (() => void) => {
        // Set up event listeners
        const eventHandler = (_: any, eventData: any) => {
            onEvent(eventData);
        };
        const endHandler = () => {
            // Cleanup listeners when stream ends
            ipcRenderer.removeListener('memory:basic-profile-stream-event', eventHandler);
            ipcRenderer.removeListener('memory:basic-profile-stream-end', endHandler);
        };

        ipcRenderer.on('memory:basic-profile-stream-event', eventHandler);
        ipcRenderer.on('memory:basic-profile-stream-end', endHandler);

        // Start the stream
        ipcRenderer.send('memory:basic-profile-stream-start', { userId });

        // Return cleanup function
        return () => {
            ipcRenderer.removeListener('memory:basic-profile-stream-event', eventHandler);
            ipcRenderer.removeListener('memory:basic-profile-stream-end', endHandler);
            ipcRenderer.send('memory:basic-profile-stream-cancel');
        };
    },

    // Manually extract memory for a file
    // force: If true, re-extract all chunks (no resume / 不支持断点续传)
    // chunkSize: Custom chunk size in chars. If set, concatenates all text and re-chunks (no resume)
    memoryExtractForFile: (fileId: string, userId?: string, force?: boolean, chunkSize?: number): Promise<{
        success: boolean;
        fileId: string;
        message: string;
        memcellsCreated: number;
        episodesCreated: number;
        eventLogsCreated: number;
        foresightsCreated: number;
    }> => ipcRenderer.invoke('memory:extract', { fileId, userId, force, chunkSize }),

    // Pause memory extraction for a file
    memoryPauseForFile: (fileId: string): Promise<{
        success: boolean;
        fileId: string;
        message: string;
    }> => ipcRenderer.invoke('memory:pause', { fileId }),

    // Get backend settings (includes memory_chunk_size)
    getSettings: (): Promise<{
        vision_max_pixels: number;
        video_max_pixels: number;
        embed_batch_size: number;
        embed_batch_delay_ms: number;
        vision_batch_delay_ms: number;
        search_result_limit: number;
        qa_context_limit: number;
        max_snippet_length: number;
        summary_max_tokens: number;
        pdf_one_chunk_per_page: boolean;
        rag_chunk_size: number;
        rag_chunk_overlap: number;
        default_indexing_mode: 'fast' | 'deep';
        enable_memory_extraction: boolean;
        memory_extraction_stage: 'fast' | 'deep' | 'none';
        memory_chunk_size: number;
    }> => ipcRenderer.invoke('settings:get-backend'),

    // ========================================
    // Privacy APIs
    // ========================================

    // Update file privacy level
    setFilePrivacy: (fileId: string, privacyLevel: 'normal' | 'private'): Promise<{
        fileId: string;
        privacyLevel: 'normal' | 'private';
        updated: boolean;
    }> => ipcRenderer.invoke('privacy:set-file', { fileId, privacyLevel }),

    // Get file privacy level
    getFilePrivacy: (fileId: string): Promise<{
        fileId: string;
        privacyLevel: 'normal' | 'private';
    }> => ipcRenderer.invoke('privacy:get-file', { fileId }),

    // Update folder privacy level
    setFolderPrivacy: (folderId: string, privacyLevel: 'normal' | 'private', applyToFiles: boolean = true): Promise<{
        folderId: string;
        privacyLevel: 'normal' | 'private';
        updated: boolean;
        filesUpdated: number;
    }> => ipcRenderer.invoke('privacy:set-folder', { folderId, privacyLevel, applyToFiles }),

    // Get folder privacy level
    getFolderPrivacy: (folderId: string): Promise<{
        folderId: string;
        privacyLevel: 'normal' | 'private';
        filesNormal: number;
        filesPrivate: number;
    }> => ipcRenderer.invoke('privacy:get-folder', { folderId }),

    on: (channel: string, callback: (event: any, ...args: any[]) => void) => {
        const subscription = (_event: any, ...args: any[]) => callback(_event, ...args);
        ipcRenderer.on(channel, subscription);
        return () => {
            ipcRenderer.removeListener(channel, subscription);
        };
    },
    off: (channel: string, listener: (...args: any[]) => void) => {
        ipcRenderer.removeListener(channel, listener);
    }
};

contextBridge.exposeInMainWorld('api', api);

contextBridge.exposeInMainWorld('env', {
    LOG_LEVEL: process.env.LOG_LEVEL,
    APP_VERSION: process.env.APP_VERSION,
    APP_NAME: process.env.APP_NAME,
});

declare global {
    interface Window {
        api: typeof api;
        env: {
            LOG_LEVEL?: string;
            APP_VERSION?: string;
            APP_NAME?: string;
            [key: string]: any;
        };
    }
}
