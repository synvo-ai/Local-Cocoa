// @ts-nocheck

export type IndexOperationMode = 'rescan' | 'reindex';
export type IndexOperationScope = 'global' | 'folder' | 'email' | 'notes';

export interface IndexOperationOptions {
    mode?: IndexOperationMode;
    scope?: IndexOperationScope;
    folders?: string[];
    files?: string[];
    refreshEmbeddings?: boolean;
    dropCollection?: boolean;
    purgeFolders?: string[];
    indexing_mode?: 'fast' | 'deep';
}

export type FileKind = import('../types/files').FileKind;
export type FileIndexStatus = import('../types/files').FileIndexStatus;
export type FileRecord = import('../types/files').FileRecord;
export type FileListResponse = import('../types/files').FileListResponse;
export type FolderRecord = import('../types/files').FolderRecord;
export type IndexProgressUpdate = import('../types/files').IndexProgressUpdate;
export type IndexResultSnapshot = import('../types/files').IndexResultSnapshot;
export type ChunkSnapshot = import('../types/files').ChunkSnapshot;
export type IndexingItem = import('../types/files').IndexingItem;
export type IndexInventory = import('../types/files').IndexInventory;
export type IndexSummary = import('../types/files').IndexSummary;
export type IndexedFile = import('../types/files').IndexedFile;
export type MonitoredFolder = import('../types/files').MonitoredFolder;
export type ServiceStatus = import('../types/files').ServiceStatus;
export type HealthStatus = import('../types/files').HealthStatus;
export type SearchHit = import('../types/files').SearchHit;
export type SearchResponse = import('../types/files').SearchResponse;
export type QaResponse = import('../types/files').QaResponse;
export type EmailAccountPayload = import('../types/files').EmailAccountPayload;
export type EmailAccountSummary = import('../types/files').EmailAccountSummary;
export type EmailSyncResult = import('../types/files').EmailSyncResult;
export type EmailMessageSummary = import('../types/files').EmailMessageSummary;
export type EmailMessageContent = import('../types/files').EmailMessageContent;
export type NoteSummary = import('../types/files').NoteSummary;
export type NoteContent = import('../types/files').NoteContent;
export type NoteDraftPayload = import('../types/files').NoteDraftPayload;
export type AgentDiagnostics = import('../types/files').AgentDiagnostics;
export type AgentStep = import('../types/files').AgentStep;
export type AgentStepFile = import('../types/files').AgentStepFile;
export type ModelAssetStatus = import('../types/files').ModelAssetStatus;
export type ModelStatusSummary = import('../types/files').ModelStatusSummary;
export type ModelDownloadEvent = import('../types/files').ModelDownloadEvent;
export type ActivityLog = import('../types/files').ActivityLog;
export type ActivityTimelineResponse = import('../types/files').ActivityTimelineResponse;
export type ChatSession = import('../types/files').ChatSession;
export type ConversationMessage = import('../types/files').ConversationMessage;
