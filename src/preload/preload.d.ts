import type {
    EmailAccountPayload,
    EmailAccountSummary,
    EmailMessageContent,
    EmailMessageSummary,
    EmailSyncResult,
    FileListResponse,
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
    ActivityLog,
    ActivityTimelineResponse,
    ChatSession,
    ConversationMessage,
    ChunkSnapshot,
} from '../main/types';

type RunIndexOptions = {
    mode?: 'rescan' | 'reindex';
    scope?: 'global' | 'folder' | 'email' | 'notes';
    folders?: string[];
    refreshEmbeddings?: boolean;
    dropCollection?: boolean;
    purgeFolders?: string[];
};

declare global {
    interface Window {
        api?: {
            pickFolders: () => Promise<string[]>;
            listFolders: () => Promise<FolderRecord[]>;
            addFolder: (path: string, label?: string, scanMode?: 'full' | 'manual') => Promise<FolderRecord>;
            removeFolder: (folderId: string) => Promise<{ id: string }>;
            getLocalKey: () => Promise<string | null>;
            setLocalKeyOverride: (key: string | null) => Promise<boolean>;
            runIndex: (options?: RunIndexOptions) => Promise<IndexProgressUpdate>;
            indexFolder: (folderId: string) => Promise<IndexProgressUpdate>;
            indexFile: (path: string) => Promise<IndexProgressUpdate>;
            indexStatus: () => Promise<IndexProgressUpdate>;
            indexSummary: () => Promise<IndexSummary>;
            pauseIndexing: () => Promise<IndexProgressUpdate>;
            resumeIndexing: () => Promise<IndexProgressUpdate>;
            indexInventory: (options?: { folderId?: string; limit?: number; offset?: number }) => Promise<IndexInventory>;
            listFiles: (limit?: number, offset?: number) => Promise<FileListResponse>;
            getFile: (fileId: string) => Promise<import('./types').FileRecord | null>;
            getChunk: (chunkId: string) => Promise<ChunkSnapshot | null>;
            listFileChunks: (fileId: string) => Promise<ChunkSnapshot[]>;
            getChunkHighlight?: (chunkId: string, zoom?: number) => Promise<string>;
            openFile: (filePath: string) => Promise<{ path: string }>;
            deleteFile: (fileId: string) => Promise<{ id: string }>;
            search: (query: string, limit?: number) => Promise<SearchResponse>;
            searchStream: (query: string, limit: number, callbacks: {
                onData: (chunk: string) => void;
                onError: (error: string) => void;
                onDone: () => void;
            }) => () => void;
            ask: (query: string, limit?: number, mode?: 'qa' | 'chat', searchMode?: 'auto' | 'knowledge' | 'direct') => Promise<QaResponse>;
            askStream: (query: string, limit: number, mode: 'qa' | 'chat', callbacks: {
                onData: (chunk: string) => void;
                onError: (error: string) => void;
                onDone: () => void;
            }, searchMode?: 'auto' | 'knowledge' | 'direct') => () => void;
            health: () => Promise<HealthStatus>;
            listEmailAccounts: () => Promise<EmailAccountSummary[]>;
            addEmailAccount: (payload: EmailAccountPayload) => Promise<EmailAccountSummary>;
            removeEmailAccount: (accountId: string) => Promise<{ id: string }>;
            syncEmailAccount: (accountId: string, limit?: number) => Promise<EmailSyncResult>;
            listEmailMessages: (accountId: string, limit?: number) => Promise<EmailMessageSummary[]>;
            getEmailMessage: (messageId: string) => Promise<EmailMessageContent>;
            listNotes: () => Promise<NoteSummary[]>;
            createNote: (payload: NoteDraftPayload) => Promise<NoteSummary>;
            getNote: (noteId: string) => Promise<NoteContent>;
            updateNote: (noteId: string, payload: NoteDraftPayload) => Promise<NoteContent>;
            deleteNote: (noteId: string) => Promise<{ id: string }>;
            showSpotlightWindow: () => Promise<unknown>;
            toggleSpotlightWindow: () => Promise<unknown>;
            hideSpotlightWindow: () => void;
            spotlightFocusFile: (fileId: string) => void;
            spotlightOpenFile: (fileId: string) => void;
            onSpotlightFocusFile: (callback: (payload: { fileId: string }) => void) => () => void;
            onSpotlightOpenFile: (callback: (payload: { fileId: string }) => void) => () => void;
            onSpotlightTabSwitch: (callback: (payload: { tab: 'search' | 'notes' }) => void) => () => void;
            notifyNotesChanged: () => void;
            onNotesChanged: (callback: () => void) => () => void;
            modelStatus: () => Promise<ModelStatusSummary>;
            downloadModels: () => Promise<ModelStatusSummary>;
            redownloadModel: (assetId: string) => Promise<ModelStatusSummary>;
            getModelConfig: () => Promise<any>;
            setModelConfig: (config: any) => Promise<any>;
            addModel: (descriptor: any) => Promise<any>;
            pickFile: (options?: { filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
            onModelDownloadEvent?: (callback: (event: ModelDownloadEvent) => void) => () => void;
            ingestScreenshot?: (image: Uint8Array) => Promise<ActivityLog>;
            getActivityTimeline?: (start?: string, end?: string, summary?: boolean) => Promise<ActivityTimelineResponse>;
            deleteActivityLog?: (logId: string) => Promise<void>;
            captureScreen?: () => Promise<Uint8Array>;
            readImage: (filePath: string) => Promise<string>;
            listChatSessions: (limit?: number, offset?: number) => Promise<ChatSession[]>;
            createChatSession: (title?: string) => Promise<ChatSession>;
            getChatSession: (sessionId: string) => Promise<ChatSession>;
            deleteChatSession: (sessionId: string) => Promise<{ id: string }>;
            updateChatSession: (sessionId: string, title: string) => Promise<ChatSession>;
            addChatMessage: (sessionId: string, message: Partial<ConversationMessage>) => Promise<ConversationMessage>;
            exportLogs: () => Promise<{ exported: boolean; path: string | null; error?: string }>;
            getLogsPath: () => Promise<string>;
// User Memory APIs
            memoryGetSummary?: (userId: string) => Promise<{
                user_id: string;
                profile?: {
                    user_id: string;
                    user_name?: string;
                    personality?: string[];
                    interests?: string[];
                    hard_skills?: Array<{ name: string; level: string }>;
                    soft_skills?: Array<{ name: string; level: string }>;
                };
                episodes_count: number;
                event_logs_count: number;
                foresights_count: number;
                recent_episodes: Array<{
                    id: string;
                    user_id: string;
                    summary: string;
                    episode?: string;
                    timestamp: string;
                    subject?: string;
                    metadata?: Record<string, unknown>;
                }>;
                recent_foresights: Array<{
                    id: string;
                    user_id: string;
                    content: string;
                    evidence?: string;
                    parent_episode_id?: string;
                    metadata?: Record<string, unknown>;
                }>;
            }>;
            memoryGetEpisodes?: (userId: string, limit?: number, offset?: number) => Promise<Array<{
                id: string;
                user_id: string;
                summary: string;
                episode?: string;
                timestamp: string;
                subject?: string;
                metadata?: Record<string, unknown>;
            }>>;
            memoryGetEventLogs?: (userId: string, limit?: number, offset?: number) => Promise<Array<{
                id: string;
                user_id: string;
                atomic_fact: string;
                timestamp: string;
                parent_episode_id?: string;
                metadata?: Record<string, unknown>;
            }>>;
            memoryGetForesights?: (userId: string, limit?: number) => Promise<Array<{
                id: string;
                user_id: string;
                content: string;
                evidence?: string;
                parent_episode_id?: string;
                metadata?: Record<string, unknown>;
            }>>;

            // MCP (Model Context Protocol) APIs
            mcpGetClaudeConfig: () => Promise<object>;
            mcpGetClaudeConfigPath: () => Promise<string>;
            mcpCheckClaudeConfig: () => Promise<boolean>;
            mcpInstallToClaude: () => Promise<{ success: boolean; path?: string; error?: string }>;
            mcpUninstallFromClaude: () => Promise<{ success: boolean; error?: string }>;
            mcpIsInstalled: () => Promise<boolean>;
            mcpOpenClaudeConfig: () => Promise<boolean>;
            mcpGetStatus: () => Promise<{
                initialized: boolean;
                running: boolean;
                pythonPath: string | null;
                serverPath: string | null;
            }>;
            mcpCopyConfig: () => Promise<string>;
            
            // MCP Connection Management APIs
            mcpListConnections: () => Promise<{
                name: string;
                key: string;
                createdAt: string;
                lastUsedAt: string | null;
                isActive: boolean;
            }[]>;
            mcpCreateConnection: (name: string) => Promise<{
                success: boolean;
                connection?: {
                    name: string;
                    key: string;
                    createdAt: string;
                    lastUsedAt: string | null;
                    isActive: boolean;
                };
                error?: string;
            }>;
            mcpRevokeConnection: (key: string) => Promise<{ success: boolean; error?: string }>;
            mcpSetConnectionActive: (key: string, isActive: boolean) => Promise<{ success: boolean; isActive?: boolean; error?: string }>;
            mcpRenameConnection: (key: string, newName: string) => Promise<{ success: boolean; name?: string; error?: string }>;
            mcpGetClaudeConnection: () => Promise<{
                connected: boolean;
                key?: string;
                createdAt?: string;
                lastUsedAt?: string | null;
            }>;

            // ========================================
            // Privacy APIs
            // ========================================
            
            // Update file privacy level (normal | private)
            setFilePrivacy: (fileId: string, privacyLevel: 'normal' | 'private') => Promise<{
                fileId: string;
                privacyLevel: 'normal' | 'private';
                updated: boolean;
            }>;
            
            // Get file privacy level
            getFilePrivacy: (fileId: string) => Promise<{
                fileId: string;
                privacyLevel: 'normal' | 'private';
            }>;
            
            // Update folder privacy level (with option to apply to all files)
            setFolderPrivacy: (folderId: string, privacyLevel: 'normal' | 'private', applyToFiles?: boolean) => Promise<{
                folderId: string;
                privacyLevel: 'normal' | 'private';
                updated: boolean;
                filesUpdated: number;
            }>;
            
            // Get folder privacy level and file counts
            getFolderPrivacy: (folderId: string) => Promise<{
                folderId: string;
                privacyLevel: 'normal' | 'private';
                filesNormal: number;
                filesPrivate: number;
            }>;
        };
    }
}

export { };
