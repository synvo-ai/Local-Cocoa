export type FileKind =
    | 'document'
    | 'image'
    | 'presentation'
    | 'spreadsheet'
    | 'audio'
    | 'video'
    | 'archive'
    | 'code'
    | 'book'
    | 'other';

export type FileIndexStatus = 'pending' | 'indexed' | 'error';

// Stage status for two-round indexing
// 0 = pending, 1 = text done, 2 = embed done, -1 = error, -2 = skipped (deep only)
export type StageValue = 0 | 1 | 2 | -1 | -2;

// Memory extraction status
export type MemoryStatus = 'pending' | 'extracting' | 'extracted' | 'skipped' | 'error';

export interface FailedFile {
    path: string;
    reason: string;
    timestamp: string;
}

export type PrivacyLevel = 'normal' | 'private';

export interface FolderRecord {
    id: string;
    label: string;
    path: string;
    createdAt: string;
    updatedAt: string;
    lastIndexedAt: string | null;
    enabled: boolean;
    failedFiles?: FailedFile[];
    indexedCount?: number;
    privacyLevel?: PrivacyLevel;
}

export interface MonitoredFolder extends FolderRecord { }

export interface FileRecord {
    id: string;
    folderId: string;
    path: string;
    name: string;
    extension: string;
    size: number;
    modifiedAt: string;
    createdAt: string;
    kind: FileKind;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    // Index status tracking (legacy)
    indexStatus?: FileIndexStatus;
    errorReason?: string | null;
    errorAt?: string | null;
    
    // Two-round indexing stages
    // Round 1 (Fast): 0=pending, 1=text_done, 2=embed_done, -1=error
    fastStage?: StageValue;
    fastTextAt?: string | null;
    fastEmbedAt?: string | null;
    
    // Round 2 (Deep): 0=pending, 1=text_done, 2=embed_done, -1=error, -2=skipped
    deepStage?: StageValue;
    deepTextAt?: string | null;
    deepEmbedAt?: string | null;
    
    // Memory extraction status
    memoryStatus?: MemoryStatus;
    memoryExtractedAt?: string | null;
    memoryTotalChunks?: number;
    memoryProcessedChunks?: number;
    memoryLastChunkSize?: number | null;

    // Privacy level
    privacyLevel?: PrivacyLevel;
}

export interface IndexedFile extends FileRecord {
    location: string;
    fullPath: string;
}

/**
 * Represents a spatial region in the source document where chunk text originated.
 * Coordinates are normalized (0-1) relative to page dimensions.
 */
export interface SourceRegion {
    pageNum: number;  // 1-indexed page number
    bbox: [number, number, number, number];  // [x0, y0, x1, y1] normalized 0-1
    confidence?: number | null;  // OCR confidence if applicable
}

export interface ChunkSnapshot {
    chunkId: string;
    fileId: string;
    ordinal: number;
    text: string;
    snippet: string;
    tokenCount: number;
    charCount: number;
    sectionPath?: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
    // Spatial metadata for chunk area visualization (optional, backward compatible)
    pageNum?: number | null;  // Primary page number (1-indexed)
    bbox?: [number, number, number, number] | null;  // Primary bbox [x0, y0, x1, y1] normalized 0-1
    sourceRegions?: SourceRegion[] | null;  // All source regions for multi-page chunks
}

export interface IndexResultSnapshot {
    files: IndexedFile[];
    startedAt: string;
    completedAt: string;
    totalCount: number;
    totalSize: number;
    byKind: Record<FileKind, number>;
    byLocation: Record<string, number>;
}

export interface IndexProgressUpdate {
    status: 'idle' | 'running' | 'paused' | 'failed' | 'completed';
    startedAt?: string | null;
    completedAt?: string | null;
    processed: number;
    failed?: number;
    failedItems?: FailedFile[];
    total?: number | null;
    message?: string | null;
    lastError?: string | null;
}

export interface IndexingItem {
    folderId: string;
    folderPath: string;
    filePath: string;
    fileId?: string | null;  // File ID for reliable matching
    fileName?: string | null;  // File name for fallback matching
    status: 'pending' | 'processing';
    startedAt?: string | null;
    progress?: number | null;

    // Optional richer details
    kind?: string | null;
    stage?: string | null;
    detail?: string | null;
    stepCurrent?: number | null;
    stepTotal?: number | null;
    recentEvents?: Array<{ ts: string; type?: string; message: string;[key: string]: any }>;
}

export interface IndexInventory {
    files: FileRecord[];
    total: number;
    indexing: IndexingItem[];
    progress: IndexProgressUpdate;
}

export interface IndexSummary {
    filesIndexed: number;
    totalSizeBytes: number;
    foldersIndexed: number;
    lastCompletedAt: string | null;
}

export interface ServiceStatus {
    name: string;
    status: 'online' | 'offline' | 'unknown';
    latencyMs?: number | null;
    details?: string | null;
}

export interface HealthStatus {
    status: 'idle' | 'indexing' | 'ready' | 'degraded';
    indexedFiles: number;
    watchedFolders: number;
    message?: string | null;
    services?: ServiceStatus[];
}

export interface FileListResponse {
    files: FileRecord[];
    total: number;
}

export interface SearchHit {
    fileId: string;
    score: number;
    summary?: string | null;
    snippet?: string | null;
    metadata: Record<string, unknown>;
    chunkId?: string | null;
    // Chunk analysis results from LLM
    analysisComment?: string | null;
    hasAnswer?: boolean;
    analysisConfidence?: number;
    // Spatial metadata for chunk area visualization (optional, backward compatible)
    pageNum?: number | null;  // Primary page number (1-indexed)
    bbox?: [number, number, number, number] | null;  // Primary bbox [x0, y0, x1, y1] normalized 0-1
    sourceRegions?: SourceRegion[] | null;  // All source regions for multi-page chunks
}

export interface AgentStepFile {
    fileId: string;
    label: string;
    score?: number | null;
}

export interface AgentStep {
    id: string;
    title: string;
    detail?: string | null;
    status?: 'running' | 'complete' | 'skipped' | 'error';
    queries?: string[];
    items?: string[];
    files?: AgentStepFile[];
    durationMs?: number | null;
}

export interface AgentDiagnostics {
    steps: AgentStep[];
    summary?: string | null;
}

export interface SearchResponse {
    query: string;
    hits: SearchHit[];
    rewrittenQuery?: string | null;
    queryVariants?: string[];
    strategy?: 'vector' | 'hybrid' | 'lexical';
    latencyMs?: number | null;
    diagnostics?: AgentDiagnostics;
}

export interface QaResponse {
    answer: string;
    hits: SearchHit[];
    latencyMs: number;
    rewrittenQuery?: string | null;
    queryVariants?: string[];
    diagnostics?: AgentDiagnostics;
}

export type EmailProtocol = 'imap' | 'pop3' | 'outlook';

export interface EmailAccountPayload {
    label: string;
    protocol: EmailProtocol;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    useSsl?: boolean;
    folder?: string;
    // Outlook
    clientId?: string;
    tenantId?: string;
}

export interface EmailAccountSummary {
    id: string;
    label: string;
    protocol: EmailProtocol;
    host?: string;
    port: number;
    username?: string;
    useSsl: boolean;
    folder?: string | null;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
    lastSyncedAt?: string | null;
    lastSyncStatus?: string | null;
    totalMessages: number;
    recentNewMessages: number;
    folderId: string;
    folderPath: string;
    // Outlook
    clientId?: string;
    tenantId?: string;
}

export interface EmailSyncResult {
    accountId: string;
    folderId: string;
    folderPath: string;
    newMessages: number;
    totalMessages: number;
    indexed: number;
    lastSyncedAt: string;
    status: 'ok' | 'error';
    message?: string | null;
}

export interface EmailMessageSummary {
    id: string;
    accountId: string;
    subject?: string | null;
    sender?: string | null;
    recipients: string[];
    sentAt?: string | null;
    storedPath: string;
    size: number;
    createdAt: string;
    preview?: string | null;
}

export interface EmailMessageContent extends EmailMessageSummary {
    markdown: string;
}

export interface NoteSummary {
    id: string;
    title: string;
    updatedAt: string;
    preview?: string | null;
}

export interface NoteContent extends NoteSummary {
    markdown: string;
    createdAt: string;
}

export interface NoteDraftPayload {
    title?: string | null;
    body?: string | null;
}

export interface ModelAssetStatus {
    id: string;
    label: string;
    path: string;
    exists: boolean;
    sizeBytes: number | null;
    optional?: boolean;
    mmprojId?: string;
}

export interface ModelStatusSummary {
    assets: ModelAssetStatus[];
    ready: boolean;
    missing: string[];
    lastCheckedAt: string;
}

export interface ModelDownloadEvent {
    state: 'idle' | 'checking' | 'downloading' | 'completed' | 'error';
    message?: string | null;
    percent?: number | null;
    assetId?: string | null;
    statuses?: ModelAssetStatus[];
    logLine?: string;
}

export interface ActivityLog {
    id: string;
    timestamp: string;
    description: string;
    short_description?: string | null;
}

export interface ActivityTimelineResponse {
    logs: ActivityLog[];
    summary?: string | null;
}

export type ThinkingStepStatus = 'pending' | 'running' | 'complete' | 'error';

export interface ThinkingStepHit {
    fileId: string;
    chunkId?: string | null;
    score: number;
    summary?: string | null;
    snippet?: string | null;
    metadata?: Record<string, unknown>;
    // Analysis results
    hasAnswer?: boolean;
    analysisComment?: string | null;
    analysisConfidence?: number;
    // Spatial metadata for chunk area visualization
    pageNum?: number | null;
    bbox?: [number, number, number, number] | null;
    sourceRegions?: SourceRegion[] | null;
}

// Rich chunk reference for clickable display
export interface ChunkReference {
    chunkId?: string | null;
    fileId: string;
    score: number;
    snippet?: string;
    metadata?: Record<string, unknown>;
    // Verification results if available
    confidence?: number;
    isRelevant?: boolean;
    extractedAnswer?: string;
    // Spatial metadata for chunk area visualization
    pageNum?: number | null;
    bbox?: [number, number, number, number] | null;
    sourceRegions?: SourceRegion[] | null;
}

// Verification result from LLM
export interface VerificationResult {
    chunkId?: string | null;
    fileId: string;
    confidence: number;
    isRelevant: boolean;
    extractedAnswer?: string;
    snippet?: string;
}

export interface ThinkingStep {
    id: string;
    type: 'decompose' | 'subquery' | 'search' | 'analyze' | 'merge' | 'synthesize' | 'info';
    title: string;
    summary?: string;
    details?: string;
    status: ThinkingStepStatus;
    children?: ThinkingStep[];
    hits?: ThinkingStepHit[];
    subQuery?: string;
    subQueryAnswer?: string;  // Answer generated for this sub-query
    timestampMs?: number;  // Time since start of operation in ms
    metadata?: {
        subQueryIndex?: number;
        totalSubQueries?: number;
        resultsCount?: number;
        relevantCount?: number;
        strategy?: string;
        sources?: string[];
        // New rich metadata fields
        sub_query_id?: string;
        sub_query?: string;
        sub_queries?: Array<{ id: string; text: string }>;
        keywords?: string[];
        method?: string;
        candidates?: ChunkReference[];
        verification_results?: VerificationResult[];
        best_answer?: string;
        confidence?: number;
        chunks?: ChunkReference[];
    };
}

export interface AnalysisProgress {
    processedCount: number;
    totalCount: number;
    highQualityCount: number;
    batchNum: number;
    totalBatches: number;
    currentFiles?: string[];
    isProcessing?: boolean;
    isPreparing?: boolean;
    isComplete: boolean;
}

export interface ConversationMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
    meta?: string;
    references?: SearchHit[];
    steps?: AgentStep[];
    diagnosticsSummary?: string | null;
    thinkingSteps?: ThinkingStep[];
    isMultiPath?: boolean;
    analysisProgress?: AnalysisProgress;
    needsUserDecision?: boolean;
    resumeToken?: string | null;
    decisionMessage?: string;
}

export interface ChatSession {
    id: string;
    title: string;
    messages: ConversationMessage[];
    updatedAt: string;
}

export type IndexOperationMode = 'rescan' | 'reindex';
export type IndexScope = 'global' | 'folder' | 'email' | 'notes';

export interface RunIndexOptions {
    mode?: IndexOperationMode;
    scope?: IndexScope;
    folders?: string[];
    refreshEmbeddings?: boolean;
    dropCollection?: boolean;
    purgeFolders?: string[];
    indexing_mode?: 'fast' | 'deep';
}

// Stage progress statistics for UI display
export interface StageProgressStats {
    fastPending: number;
    fastTextDone: number;
    fastEmbedDone: number;
    fastError: number;
    deepPending: number;
    deepTextDone: number;
    deepEmbedDone: number;
    deepSkipped: number;
    deepError: number;
    total: number;
}

// Modality-grouped statistics
export interface ModalityStats {
    kind: FileKind;
    fileCount: number;
    totalSize: number;
    stageProgress: StageProgressStats;
}

export interface SystemSpecs {
    totalMemory: number;
    platform: string;
    arch: string;
    cpus: number;
}

export interface ApiKey {
    key: string;
    name: string;
    created_at: string;
    last_used_at?: string | null;
    is_active: boolean;
    is_system: boolean;
}

// Scan feature types
export type ScanMode = 'smart' | 'custom';
export type FileOrigin = 'downloaded' | 'synced' | 'created_here' | 'unknown';
export type ScanStage = 'idle' | 'planning' | 'scanning' | 'building' | 'completed' | 'cancelled' | 'error';

export interface ScanDirectory {
    path: string;
    label: string;
    isDefault: boolean;
    isCloudSync?: boolean;
    selected?: boolean; // for UI state
}

export interface ScanScope {
    mode: ScanMode;
    directories: ScanDirectory[];
    useRecommendedExclusions: boolean;
    customExclusions: string[];
}

export interface ScanSettings {
    scope: ScanScope;
    lastScanAt?: string;
}

export interface ScannedFile {
    path: string;
    name: string;
    extension: string;
    size: number;
    modifiedAt: string;
    createdAt: string;
    kind: FileKind;
    origin?: FileOrigin; // Downloaded, Synced, Created here, Unknown
    parentPath?: string; // For folder tree building
}

export interface ScanProgress {
    status: ScanStage;
    stage?: string; // Human readable stage name
    currentPath?: string;
    scannedCount: number; // Total files scanned
    matchedCount: number; // Files matching filters
    skippedCount: number; // Files skipped by exclusions
    totalEstimate?: number;
    startedAt?: string;
    completedAt?: string;
    error?: string;
}

export interface ScanOptions {
    daysBack: number | null; // null = all time (for relative time ranges)
    dateFrom?: string | null; // ISO date string for start of range (for year-based or custom)
    dateTo?: string | null; // ISO date string for end of range (for year-based or custom)
    directories: string[]; // specific directories to scan
    useRecommendedExclusions?: boolean;
    customExclusions?: string[];
}

// Folder tree node for hierarchical display
export interface FolderNode {
    path: string;
    name: string;
    fileCount: number; // Files matching current filter in this folder
    totalFileCount: number; // Total files in subtree
    totalSize: number; // Total size of files in subtree
    latestModified: string; // Max mtime in subtree
    children: FolderNode[];
    files: ScannedFile[];
    isExpanded?: boolean;
}

