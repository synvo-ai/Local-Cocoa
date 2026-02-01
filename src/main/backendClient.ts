
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { config } from './config';

import type {
    AgentDiagnostics,
    AgentStep,
    AgentStepFile,
    EmailAccountPayload,
    EmailAccountSummary,
    EmailMessageContent,
    EmailMessageSummary,
    EmailSyncResult,
    FileKind,
    FileListResponse,
    FileRecord,
    FolderRecord,
    HealthStatus,
    ServiceStatus,
    IndexInventory,
    IndexProgressUpdate,
    IndexSummary,
    IndexingItem,
    NoteContent,
    NoteDraftPayload,
    NoteSummary,
    QaResponse,
    SearchHit,
    SearchResponse,
    ActivityLog,
    ActivityTimelineResponse,
    ChatSession,
    ConversationMessage,
    ChunkSnapshot,
} from './types';

export interface FailedFile {
    path: string;
    reason: string;
    timestamp: string;
}

const API_BASE_URL = process.env.LOCAL_RAG_API_URL ?? 'http://127.0.0.1:8890';

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

let cachedKey: string | null = null;

export function setSessionToken(token: string): void {
    cachedKey = token;
    console.log('[BackendClient] Session token set');
}

export function getLocalKey(): string | null {
    // Always try to read the key if not cached yet
    if (cachedKey) return cachedKey;

    // In production mode, this should never happen
    if (app.isPackaged) return null;

    const keyPath = path.join(config.paths.runtimeRoot, '.dev-session-key');
    try {
        if (fs.existsSync(keyPath)) {
            const key = fs.readFileSync(keyPath, 'utf-8').trim();
            if (key) {
                cachedKey = key;
                console.log('[BackendClient] API key loaded successfully.');
                return cachedKey;
            }
        } else {
            console.log('[BackendClient] Key file not found yet:', keyPath);
        }
    } catch (e) {
        console.error('[BackendClient] Failed to read local key:', e);
    }
    return null;
}

// Function to clear the cached key (useful when backend restarts)
export function clearCachedKey(): void {
    cachedKey = null;
}

function resolveEndpoint(endpoint: string): string {
    if (/^https?:\/\//i.test(endpoint)) {
        return endpoint;
    }
    const base = API_BASE_URL.endsWith('/') ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
    const pathPart = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${base}${pathPart}`;
}

async function requestJson<T>(endpoint: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('content-type') && !(init?.body instanceof FormData)) {
        headers.set('content-type', 'application/json');
    }

    const key = getLocalKey();
    if (key) {
        headers.set('X-API-Key', key);
        // IMPORTANT: Mark all requests from Electron app as local_ui for privacy access
        // This allows access to private files from the Local Cocoa UI
        headers.set('X-Request-Source', 'local_ui');
    } else {
        console.warn('[BackendClient] No API key available for request to:', endpoint);
    }

    const url = resolveEndpoint(endpoint);
    try {
        const response = await fetch(url, {
            ...init,
            headers
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Backend responded with ${response.status}${text ? `: ${text}` : ''}`);
        }

        if (response.status === 204) {
            return {} as T;
        }

        return (await response.json()) as T;
    } catch (error) {
        console.error(`[BackendClient] Fetch failed for ${url}:`, error);
        throw error;
    }
}

async function requestBinary(endpoint: string, init?: RequestInit): Promise<Uint8Array> {
    const url = resolveEndpoint(endpoint);
    const headers = new Headers(init?.headers ?? {});

    const key = getLocalKey();
    if (key) {
        headers.set('X-API-Key', key);
        // IMPORTANT: Mark all requests from Electron app as local_ui for privacy access
        headers.set('X-Request-Source', 'local_ui');
    }

    try {
        const response = await fetch(url, {
            ...init,
            headers
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Backend responded with ${response.status}${text ? `: ${text}` : ''}`);
        }
        const buffer = (await response.arrayBuffer()) as any;
        return new Uint8Array(buffer);
    } catch (error) {
        console.error(`[BackendClient] Fetch failed for ${url}:`, error);
        throw error;
    }
}

function mapAgentStepFile(payload: any): AgentStepFile {
    return {
        fileId: String(payload.file_id ?? payload.fileId ?? ''),
        label: payload.label ?? '',
        score: payload.score ?? null
    };
}

function mapAgentStep(payload: any): AgentStep {
    const files = Array.isArray(payload.files) ? payload.files.map(mapAgentStepFile) : [];
    const fallbackId = `step-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return {
        id: String(payload.id ?? payload.step_id ?? fallbackId),
        title: payload.title ?? 'Step',
        detail: payload.detail ?? null,
        status: payload.status ?? 'complete',
        queries: Array.isArray(payload.queries) ? payload.queries.map(String) : [],
        items: Array.isArray(payload.items) ? payload.items.map(String) : [],
        files,
        durationMs: payload.duration_ms ?? payload.durationMs ?? null
    } satisfies AgentStep;
}

function mapDiagnostics(payload: any): AgentDiagnostics | undefined {
    if (!payload) {
        return undefined;
    }
    const steps = Array.isArray(payload.steps) ? payload.steps.map(mapAgentStep) : [];
    const summary = payload.summary ?? null;
    if (!steps.length && !summary) {
        return undefined;
    }
    return {
        steps,
        summary
    } satisfies AgentDiagnostics;
}

function mapFailedFile(payload: any): FailedFile {
    return {
        path: String(payload.path ?? ''),
        reason: String(payload.reason ?? ''),
        timestamp: payload.timestamp ?? new Date().toISOString()
    };
}

function mapFolder(payload: any): FolderRecord {
    return {
        id: String(payload.id),
        label: payload.label ?? payload.path ?? 'Folder',
        path: payload.path ?? '',
        createdAt: payload.created_at ?? payload.createdAt ?? new Date().toISOString(),
        updatedAt: payload.updated_at ?? payload.updatedAt ?? new Date().toISOString(),
        lastIndexedAt: payload.last_indexed_at ?? payload.lastIndexedAt ?? null,
        enabled: payload.enabled ?? true,
        failedFiles: Array.isArray(payload.failed_files) ? payload.failed_files.map(mapFailedFile) : [],
        indexedCount: Number(payload.indexed_count ?? payload.indexedCount ?? 0),
        privacyLevel: payload.privacy_level ?? payload.privacyLevel ?? 'normal'
    };
}

function mapFile(payload: any): FileRecord & { fullPath?: string; location?: string } {
    const path = payload.path ?? '';
    return {
        id: String(payload.id),
        folderId: String(payload.folder_id ?? payload.folderId ?? ''),
        path,
        name: payload.name ?? payload.filename ?? 'Unnamed',
        extension: payload.extension ?? '',
        size: Number(payload.size ?? 0),
        modifiedAt: payload.modified_at ?? payload.modifiedAt ?? new Date().toISOString(),
        createdAt: payload.created_at ?? payload.createdAt ?? new Date().toISOString(),
        kind: (payload.kind ?? 'other') as FileKind,
        summary: payload.summary ?? null,
        metadata: payload.metadata ?? {},
        // Index status tracking
        indexStatus: payload.index_status ?? payload.indexStatus ?? 'indexed',
        errorReason: payload.error_reason ?? payload.errorReason ?? null,
        errorAt: payload.error_at ?? payload.errorAt ?? null,
        // Two-round indexing stages
        fastStage: payload.fast_stage ?? payload.fastStage ?? 0,
        fastTextAt: payload.fast_text_at ?? payload.fastTextAt ?? null,
        fastEmbedAt: payload.fast_embed_at ?? payload.fastEmbedAt ?? null,
        deepStage: payload.deep_stage ?? payload.deepStage ?? 0,
        deepTextAt: payload.deep_text_at ?? payload.deepTextAt ?? null,
        deepEmbedAt: payload.deep_embed_at ?? payload.deepEmbedAt ?? null,
        // Memory extraction status and progress
        memoryStatus: payload.memory_status ?? payload.memoryStatus ?? 'pending',
        memoryExtractedAt: payload.memory_extracted_at ?? payload.memoryExtractedAt ?? null,
        memoryTotalChunks: payload.memory_total_chunks ?? payload.memoryTotalChunks ?? 0,
        memoryProcessedChunks: payload.memory_processed_chunks ?? payload.memoryProcessedChunks ?? 0,
        memoryLastChunkSize: payload.memory_last_chunk_size ?? payload.memoryLastChunkSize ?? null,
        // Extended fields for IndexedFile
        fullPath: payload.full_path ?? payload.fullPath ?? path,
        location: payload.location ?? '',
        // Privacy level
        privacyLevel: payload.privacy_level ?? payload.privacyLevel ?? 'normal',
    };
}

function mapProgress(payload: any): IndexProgressUpdate {
    return {
        status: payload.status ?? 'idle',
        startedAt: payload.started_at ?? payload.startedAt ?? null,
        completedAt: payload.completed_at ?? payload.completedAt ?? null,
        processed: Number(payload.processed ?? 0),
        failed: Number(payload.failed ?? 0),
        failedItems: Array.isArray(payload.failed_items) ? payload.failed_items.map(mapFailedFile) : [],
        total: payload.total ?? null,
        message: payload.message ?? null,
        lastError: payload.last_error ?? payload.lastError ?? null
    };
}

function mapSummary(payload: any): IndexSummary {
    return {
        filesIndexed: Number(payload.files_indexed ?? payload.filesIndexed ?? 0),
        totalSizeBytes: Number(payload.total_size_bytes ?? payload.totalSizeBytes ?? 0),
        foldersIndexed: Number(payload.folders_indexed ?? payload.foldersIndexed ?? 0),
        lastCompletedAt: payload.last_completed_at ?? payload.lastCompletedAt ?? null
    };
}

function mapIndexingItem(payload: any): IndexingItem {
    return {
        folderId: String(payload.folder_id ?? payload.folderId ?? ''),
        folderPath: payload.folder_path ?? payload.folderPath ?? '',
        filePath: payload.file_path ?? payload.filePath ?? '',
        fileId: payload.file_id ?? payload.fileId ?? null,
        fileName: payload.file_name ?? payload.fileName ?? null,
        status: (payload.status ?? 'pending') as IndexingItem['status'],
        startedAt: payload.started_at ?? payload.startedAt ?? null,
        progress: typeof payload.progress === 'number' ? payload.progress : null,

        kind: payload.kind ?? null,
        stage: payload.stage ?? null,
        detail: payload.detail ?? null,
        stepCurrent: typeof payload.step_current === 'number' ? payload.step_current : (payload.stepCurrent ?? null),
        stepTotal: typeof payload.step_total === 'number' ? payload.step_total : (payload.stepTotal ?? null),
        recentEvents: Array.isArray(payload.recent_events)
            ? payload.recent_events
            : (Array.isArray(payload.recentEvents) ? payload.recentEvents : [])
    };
}

function mapServiceStatus(payload: any): ServiceStatus {
    return {
        name: payload.name ?? 'Unknown',
        status: payload.status ?? 'unknown',
        latencyMs: payload.latency_ms ?? payload.latencyMs ?? null,
        details: payload.details ?? null
    };
}

function mapHealth(payload: any): HealthStatus {
    return {
        status: payload.status ?? 'idle',
        indexedFiles: Number(payload.indexed_files ?? payload.indexedFiles ?? 0),
        watchedFolders: Number(payload.watched_folders ?? payload.watchedFolders ?? 0),
        message: payload.message ?? null,
        services: Array.isArray(payload.services) ? payload.services.map(mapServiceStatus) : []
    };
}

function mapSearchHit(payload: any): SearchHit {
    return {
        fileId: String(payload.file_id ?? payload.fileId ?? ''),
        score: Number(payload.score ?? 0),
        summary: payload.summary ?? null,
        snippet: payload.snippet ?? null,
        metadata: payload.metadata ?? {},
        chunkId: payload.chunk_id ?? payload.chunkId ?? null,
        // Chunk analysis results from LLM
        analysisComment: payload.analysis_comment ?? payload.analysisComment ?? null,
        hasAnswer: payload.has_answer ?? payload.hasAnswer,
        analysisConfidence: payload.analysis_confidence ?? payload.analysisConfidence
    };
}

function mapSearchResponse(payload: any): SearchResponse {
    const hits = Array.isArray(payload.hits) ? payload.hits.map(mapSearchHit) : [];
    const variantsSource = payload.query_variants ?? payload.queryVariants;
    const queryVariants = Array.isArray(variantsSource)
        ? variantsSource.map((item: any) => String(item)).filter(Boolean)
        : [];
    return {
        query: payload.query ?? '',
        hits,
        rewrittenQuery: payload.rewritten_query ?? payload.rewrittenQuery ?? null,
        queryVariants,
        strategy: payload.strategy ?? 'vector',
        latencyMs: payload.latency_ms ?? payload.latencyMs ?? null,
        diagnostics: mapDiagnostics(payload.diagnostics)
    };
}

function mapQaResponse(payload: any): QaResponse {
    const hits = Array.isArray(payload.hits) ? payload.hits.map(mapSearchHit) : [];
    const variantsSource = payload.query_variants ?? payload.queryVariants;
    const queryVariants = Array.isArray(variantsSource)
        ? variantsSource.map((item: any) => String(item)).filter(Boolean)
        : [];
    return {
        answer: payload.answer ?? '',
        hits,
        latencyMs: Number(payload.latency_ms ?? payload.latencyMs ?? 0),
        rewrittenQuery: payload.rewritten_query ?? payload.rewrittenQuery ?? null,
        queryVariants,
        diagnostics: mapDiagnostics(payload.diagnostics)
    };
}

function mapEmailAccount(payload: any): EmailAccountSummary {
    return {
        id: String(payload.id ?? payload.account_id ?? ''),
        label: payload.label ?? 'Email account',
        protocol: (payload.protocol ?? 'imap') as EmailAccountSummary['protocol'],
        host: payload.host ?? '',
        port: Number(payload.port ?? 0),
        username: payload.username ?? '',
        useSsl: Boolean(payload.use_ssl ?? payload.useSsl ?? true),
        folder: payload.folder ?? null,
        enabled: Boolean(payload.enabled ?? true),
        createdAt: payload.created_at ?? payload.createdAt ?? new Date().toISOString(),
        updatedAt: payload.updated_at ?? payload.updatedAt ?? new Date().toISOString(),
        lastSyncedAt: payload.last_synced_at ?? payload.lastSyncedAt ?? null,
        lastSyncStatus: payload.last_sync_status ?? payload.lastSyncStatus ?? null,
        totalMessages: Number(payload.total_messages ?? payload.totalMessages ?? 0),
        recentNewMessages: Number(payload.recent_new_messages ?? payload.recentNewMessages ?? 0),
        folderId: String(payload.folder_id ?? payload.folderId ?? ''),
        folderPath: payload.folder_path ?? payload.folderPath ?? ''
    };
}

function mapEmailSyncResult(payload: any): EmailSyncResult {
    return {
        accountId: String(payload.account_id ?? payload.accountId ?? ''),
        folderId: String(payload.folder_id ?? payload.folderId ?? ''),
        folderPath: payload.folder_path ?? payload.folderPath ?? '',
        newMessages: Number(payload.new_messages ?? payload.newMessages ?? 0),
        totalMessages: Number(payload.total_messages ?? payload.totalMessages ?? 0),
        indexed: Number(payload.indexed ?? 0),
        lastSyncedAt: payload.last_synced_at ?? payload.lastSyncedAt ?? new Date().toISOString(),
        status: (payload.status ?? 'ok') as EmailSyncResult['status'],
        message: payload.message ?? null
    };
}

function mapEmailMessageSummary(payload: any): EmailMessageSummary {
    return {
        id: String(payload.id ?? ''),
        accountId: String(payload.account_id ?? payload.accountId ?? ''),
        subject: payload.subject ?? null,
        sender: payload.sender ?? null,
        recipients: Array.isArray(payload.recipients) ? payload.recipients.map(String) : [],
        sentAt: payload.sent_at ?? payload.sentAt ?? null,
        storedPath: payload.stored_path ?? payload.storedPath ?? '',
        size: Number(payload.size ?? 0),
        createdAt: payload.created_at ?? payload.createdAt ?? new Date().toISOString(),
        preview: payload.preview ?? null
    };
}

function mapEmailMessageContent(payload: any): EmailMessageContent {
    const summary = mapEmailMessageSummary(payload);
    return {
        ...summary,
        markdown: payload.markdown ?? ''
    };
}

function mapNoteSummary(payload: any): NoteSummary {
    return {
        id: String(payload.id ?? ''),
        title: payload.title ?? 'Untitled note',
        updatedAt: payload.updated_at ?? payload.updatedAt ?? new Date().toISOString(),
        preview: payload.preview ?? null
    };
}

function mapNoteContent(payload: any): NoteContent {
    return {
        id: String(payload.id ?? ''),
        title: payload.title ?? 'Untitled note',
        markdown: payload.markdown ?? '',
        createdAt: payload.created_at ?? payload.createdAt ?? new Date().toISOString(),
        updatedAt: payload.updated_at ?? payload.updatedAt ?? new Date().toISOString(),
        preview: payload.preview ?? null
    };
}

function mapChatMessage(payload: any): ConversationMessage {
    return {
        role: payload.role ?? 'user',
        text: payload.content ?? payload.text ?? '',
        timestamp: payload.timestamp ?? new Date().toISOString(),
        meta: payload.meta ?? undefined,
        references: Array.isArray(payload.references) ? payload.references.map(mapSearchHit) : undefined,
        // Multi-path thinking steps
        isMultiPath: payload.is_multi_path ?? payload.isMultiPath,
        thinkingSteps: Array.isArray(payload.thinking_steps ?? payload.thinkingSteps)
            ? (payload.thinking_steps ?? payload.thinkingSteps)
            : undefined
    };
}

function mapChatSession(payload: any): ChatSession {
    return {
        id: String(payload.id ?? ''),
        title: payload.title ?? 'New Chat',
        messages: Array.isArray(payload.messages) ? payload.messages.map(mapChatMessage) : [],
        updatedAt: payload.updated_at ?? payload.updatedAt ?? new Date().toISOString()
    };
}

export async function updateSettings(settings: {
    vision_max_pixels?: number;
    search_result_limit?: number;
    qa_context_limit?: number;
    max_snippet_length?: number;
    summary_max_tokens?: number;
    embed_batch_size?: number;
    embed_batch_delay_ms?: number;
    vision_batch_delay_ms?: number;
    pdf_one_chunk_per_page?: boolean;
}): Promise<void> {
    await requestJson('/settings/', {
        method: 'PATCH',
        body: JSON.stringify(settings)
    });
}

export async function getHealth(): Promise<HealthStatus> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
    try {
        const data = await requestJson('/health', {
            method: 'GET',
            signal: controller.signal as any // Cast to any because Electron types might mismatch
        });
        clearTimeout(timeoutId);
        return mapHealth(data);
    } catch (error) {
        clearTimeout(timeoutId);
        console.warn('Health check failed or timed out:', error);
        // Return offline status instead of throwing to prevent blocking other calls
        return {
            status: 'degraded',
            indexedFiles: 0,
            watchedFolders: 0,
            message: 'Backend unreachable'
        };
    }
}

export async function listFolders(): Promise<FolderRecord[]> {
    console.log('[BackendClient] listFolders called...');
    try {
        const data = await requestJson<{ folders: any[] }>('/folders', { method: 'GET' });
        console.log('[BackendClient] listFolders raw response:', data);
        const folders = Array.isArray(data.folders) ? data.folders : [];
        console.log('[BackendClient] listFolders mapped folders:', folders.length);
        return folders.map(mapFolder);
    } catch (error) {
        console.error('[BackendClient] listFolders error:', error);
        throw error;
    }
}

export async function addFolder(pathValue: string, label?: string, scanMode?: 'full' | 'manual'): Promise<FolderRecord> {
    const payload = { path: pathValue, label, scan_mode: scanMode || 'full' };
    const data = await requestJson('/folders', {
        method: 'POST',
        body: JSON.stringify(payload)
    });
    return mapFolder(data);
}

export async function removeFolder(folderId: string): Promise<void> {
    await requestJson(`/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' });
}

export async function runIndex(options?: IndexOperationOptions): Promise<IndexProgressUpdate> {
    const inferredMode: IndexOperationMode = options?.mode
        ?? ((options?.dropCollection || (options?.purgeFolders && options.purgeFolders.length)) ? 'reindex' : 'rescan');
    const inferredScope: IndexOperationScope = options?.scope
        ?? ((options?.folders && options.folders.length) ? 'folder' : 'global');

    const payload: Record<string, unknown> = {
        mode: inferredMode,
        scope: inferredScope,
        folders: options?.folders ?? null,
        files: options?.files ?? null,
    };

    // Only set indexing_mode if explicitly provided; otherwise let backend use configured default
    if (options?.indexing_mode) {
        payload.indexing_mode = options.indexing_mode;
    }

    if (options?.refreshEmbeddings !== undefined) {
        payload.refresh_embeddings = options.refreshEmbeddings;
    }
    if (options?.dropCollection !== undefined) {
        payload.drop_collection = options.dropCollection;
    }

    if (options?.purgeFolders !== undefined) {
        payload.purge_folders = options.purgeFolders;
    } else if (inferredMode === 'reindex' && inferredScope !== 'global') {
        payload.purge_folders = options?.folders ?? [];
    }

    const data = await requestJson('/index/run', {
        method: 'POST',
        body: JSON.stringify(payload)
    });
    return mapProgress(data);
}

export async function getIndexStatus(): Promise<IndexProgressUpdate> {
    const data = await requestJson('/index/status', { method: 'GET' });
    return mapProgress(data);
}

export async function pauseIndexing(): Promise<IndexProgressUpdate> {
    const data = await requestJson('/index/pause', { method: 'POST' });
    return mapProgress(data);
}

export async function resumeIndexing(): Promise<IndexProgressUpdate> {
    const data = await requestJson('/index/resume', { method: 'POST' });
    return mapProgress(data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Staged Indexing (Two-Round Progressive System)
// ═══════════════════════════════════════════════════════════════════════════════

export interface StageProgress {
    pending: number;
    done: number;
    error: number;
    percent: number;
    enabled?: boolean;
    skipped?: number;
}

export interface StagedIndexProgress {
    total: number;
    fast_text: StageProgress;
    fast_embed: StageProgress & { enabled: boolean };
    deep: StageProgress & { enabled: boolean };
    paused: { fast_text: boolean; fast_embed: boolean; deep: boolean };
    semantic_enabled: boolean;
    deep_enabled: boolean;
}

export interface DeepStatusResponse {
    deep_enabled: boolean;
    deep_progress: StageProgress;
    message: string;
}

export interface DeepControlResponse {
    deep_enabled: boolean;
    started?: boolean;
    stopped?: boolean;
    message: string;
}

export async function getStageProgress(folderId?: string): Promise<StagedIndexProgress> {
    const url = new URL(resolveEndpoint('/index/stage-progress'));
    if (folderId) {
        url.searchParams.set('folder_id', folderId);
    }
    return requestJson<StagedIndexProgress>(url.toString(), { method: 'GET' });
}

export interface ErrorFile {
    id: string;
    name: string;
    path: string;
    error_reason: string | null;
    error_at: string | null;
}

export async function getErrorFiles(folderId?: string): Promise<ErrorFile[]> {
    const url = new URL(resolveEndpoint('/index/error-files'));
    if (folderId) {
        url.searchParams.set('folder_id', folderId);
    }
    return requestJson<ErrorFile[]>(url.toString(), { method: 'GET' });
}

export interface SemanticControlResponse {
    semantic_enabled: boolean;
    started?: boolean;
    stopped?: boolean;
    message: string;
}

export async function startSemanticIndexing(): Promise<SemanticControlResponse> {
    return requestJson<SemanticControlResponse>('/index/start-semantic', { method: 'POST' });
}

export async function stopSemanticIndexing(): Promise<SemanticControlResponse> {
    return requestJson<SemanticControlResponse>('/index/stop-semantic', { method: 'POST' });
}

export async function startDeepIndexing(): Promise<DeepControlResponse> {
    return requestJson<DeepControlResponse>('/index/start-deep', { method: 'POST' });
}

export async function stopDeepIndexing(): Promise<DeepControlResponse> {
    return requestJson<DeepControlResponse>('/index/stop-deep', { method: 'POST' });
}

export async function getDeepStatus(): Promise<DeepStatusResponse> {
    return requestJson<DeepStatusResponse>('/index/deep-status', { method: 'GET' });
}

/**
 * Stop a model running in the Python backend.
 * Used when switching models to ensure the old model is properly stopped.
 */
export async function stopPythonModel(modelType: 'vision' | 'embedding' | 'reranking' | 'transcription'): Promise<{ status: string; model: string }> {
    return requestJson<{ status: string; model: string }>(`/models/${modelType}/stop`, { method: 'POST' });
}

/**
 * Update VLM model configuration in the Python backend.
 * This ensures the Python ModelManager uses the correct model files
 * when starting VLM on-demand (e.g., after system hibernation).
 */
export async function updateVLMConfig(config: { vlm_model?: string; vlm_mmproj?: string }): Promise<{ vlm_model: string; vlm_mmproj: string }> {
    return requestJson<{ vlm_model: string; vlm_mmproj: string }>('/models/vlm/config', {
        method: 'PATCH',
        body: JSON.stringify(config)
    });
}

/**
 * Update embedding model configuration in the Python backend.
 */
export async function updateEmbeddingConfig(config: { embedding_model?: string }): Promise<{ embedding_model: string }> {
    return requestJson<{ embedding_model: string }>('/models/embedding/config', {
        method: 'PATCH',
        body: JSON.stringify(config)
    });
}

/**
 * Update reranker model configuration in the Python backend.
 */
export async function updateRerankerConfig(config: { rerank_model?: string }): Promise<{ rerank_model: string }> {
    return requestJson<{ rerank_model: string }>('/models/reranker/config', {
        method: 'PATCH',
        body: JSON.stringify(config)
    });
}

/**
 * Update whisper model configuration in the Python backend.
 */
export async function updateWhisperConfig(config: { whisper_model?: string }): Promise<{ whisper_model: string }> {
    return requestJson<{ whisper_model: string }>('/models/whisper/config', {
        method: 'PATCH',
        body: JSON.stringify(config)
    });
}

/**
 * Update all model configurations at once in the Python backend.
 * This is useful during app startup to sync all model paths.
 */
export async function updateAllModelsConfig(config: {
    vlm_model?: string;
    vlm_mmproj?: string;
    embedding_model?: string;
    rerank_model?: string;
    whisper_model?: string;
}): Promise<{
    vlm_model: string;
    vlm_mmproj: string;
    embedding_model: string;
    rerank_model: string;
    whisper_model: string;
}> {
    return requestJson('/models/config', {
        method: 'PATCH',
        body: JSON.stringify(config)
    });
}

export async function runStagedIndex(options?: { 
    folders?: string[]; 
    files?: string[];
    mode?: 'rescan' | 'reindex';
}): Promise<IndexProgressUpdate> {
    const payload: Record<string, unknown> = {};
    if (options?.folders) {
        payload.folders = options.folders;
    }
    if (options?.files) {
        payload.files = options.files;
    }
    if (options?.mode) {
        payload.mode = options.mode;
    }
    const data = await requestJson('/index/run-staged', {
        method: 'POST',
        body: JSON.stringify(payload)
    });
    return mapProgress(data);
}

export async function getIndexSummary(): Promise<IndexSummary> {
    const data = await requestJson('/index/summary', { method: 'GET' });
    return mapSummary(data);
}

export async function getIndexInventory(options?: { folderId?: string; limit?: number; offset?: number }): Promise<IndexInventory> {
    const url = new URL(resolveEndpoint('/index/list'));
    if (options?.limit !== undefined) {
        url.searchParams.set('limit', String(options.limit));
    }
    if (options?.offset !== undefined) {
        url.searchParams.set('offset', String(options.offset));
    }
    if (options?.folderId) {
        url.searchParams.set('folder_id', options.folderId);
    }
    const data = await requestJson<{ files: any[]; total?: number; indexing?: any[]; progress?: any }>(url.toString(), { method: 'GET' });
    const files = Array.isArray(data.files) ? data.files.map(mapFile) : [];
    const indexing = Array.isArray(data.indexing) ? data.indexing.map(mapIndexingItem) : [];
    return {
        files,
        total: Number(data.total ?? files.length),
        indexing,
        progress: mapProgress(data.progress ?? {})
    };
}

export async function listIndexedFiles(limit = 500, offset = 0): Promise<FileListResponse> {
    const url = new URL(resolveEndpoint('/files'));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await requestJson<{ files: any[]; total?: number }>(url.toString(), { method: 'GET' });
    const files = Array.isArray(data.files) ? data.files.map(mapFile) : [];
    return {
        files,
        total: Number(data.total ?? files.length)
    };
}

export async function getChunkById(chunkId: string): Promise<ChunkSnapshot | null> {
    if (!chunkId) {
        return null;
    }
    try {
        const data = await requestJson<any>(resolveEndpoint(`/files/chunks/${encodeURIComponent(chunkId)}`), {
            method: 'GET',
        });
        // ChunkSnapshot schema in TS already matches backend, so we can return as-is
        return data as ChunkSnapshot;
    } catch (error) {
        console.error(`Failed to get chunk ${chunkId}:`, error);
        return null;
    }
}

export async function listChunksForFile(fileId: string): Promise<ChunkSnapshot[]> {
    if (!fileId) {
        return [];
    }

    const url = resolveEndpoint(`/files/${encodeURIComponent(fileId)}/chunks`);
    try {
        const data = await requestJson<ChunkSnapshot[]>(url, { method: 'GET' });
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error(`Failed to list chunks for file ${fileId}:`, error);
        return [];
    }
}

export async function getFileById(fileId: string): Promise<FileRecord | null> {
    try {
        const data = await requestJson<any>(resolveEndpoint(`/files/${fileId}`), { method: 'GET' });
        return mapFile(data);
    } catch (error) {
        console.error(`Failed to get file ${fileId}:`, error);
        return null;
    }
}

export async function deleteIndexedFile(fileId: string): Promise<void> {
    await requestJson(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

// Plugin API prefixes
const MAIL_PLUGIN_PREFIX = '/plugins/mail';
const NOTES_PLUGIN_PREFIX = '/plugins/notes';
const ACTIVITY_PLUGIN_PREFIX = '/plugins/activity';

export async function listEmailAccounts(): Promise<EmailAccountSummary[]> {
    const data = await requestJson<any[]>(`${MAIL_PLUGIN_PREFIX}/accounts`, { method: 'GET' });
    const payload = Array.isArray(data) ? data : [];
    return payload.map(mapEmailAccount);
}

export async function startOutlookAuth(clientId: string, tenantId: string): Promise<{ flow_id: string }> {
    return requestJson(`${MAIL_PLUGIN_PREFIX}/outlook/auth`, {
        method: 'POST',
        body: JSON.stringify({ client_id: clientId, tenant_id: tenantId })
    });
}

export async function getOutlookAuthStatus(flowId: string): Promise<any> {
    return requestJson(`${MAIL_PLUGIN_PREFIX}/outlook/auth/${flowId}`, { method: 'GET' });
}

export async function completeOutlookSetup(flowId: string, label: string): Promise<EmailAccountSummary> {
    const data = await requestJson<any>(`${MAIL_PLUGIN_PREFIX}/outlook/complete`, {
        method: 'POST',
        body: JSON.stringify({ flow_id: flowId, label })
    });
    return mapEmailAccount(data);
}

export async function addEmailAccount(payload: EmailAccountPayload): Promise<EmailAccountSummary> {
    const body = {
        label: payload.label,
        protocol: payload.protocol,
        host: payload.host,
        port: payload.port,
        username: payload.username,
        password: payload.password,
        use_ssl: payload.useSsl ?? true,
        folder: payload.folder
    };
    const data = await requestJson(`${MAIL_PLUGIN_PREFIX}/accounts`, {
        method: 'POST',
        body: JSON.stringify(body)
    });
    return mapEmailAccount(data);
}

export async function removeEmailAccount(accountId: string): Promise<void> {
    await requestJson(`${MAIL_PLUGIN_PREFIX}/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
}

export async function syncEmailAccount(accountId: string, limit?: number): Promise<EmailSyncResult> {
    const payload = {
        limit: limit ?? 100
    };
    const data = await requestJson(`${MAIL_PLUGIN_PREFIX}/accounts/${encodeURIComponent(accountId)}/sync`, {
        method: 'POST',
        body: JSON.stringify(payload)
    });
    return mapEmailSyncResult(data);
}

export async function listEmailMessages(accountId: string, limit = 50): Promise<EmailMessageSummary[]> {
    const url = new URL(resolveEndpoint(`${MAIL_PLUGIN_PREFIX}/accounts/${encodeURIComponent(accountId)}/messages`));
    url.searchParams.set('limit', String(limit));
    const data = await requestJson<any[]>(url.toString(), { method: 'GET' });
    const payload = Array.isArray(data) ? data : [];
    return payload.map(mapEmailMessageSummary);
}

export async function getEmailMessage(messageId: string): Promise<EmailMessageContent> {
    const data = await requestJson(`${MAIL_PLUGIN_PREFIX}/messages/${encodeURIComponent(messageId)}`, { method: 'GET' });
    return mapEmailMessageContent(data);
}

export async function searchFiles(query: string, limit = 10): Promise<SearchResponse> {
    const trimmed = query?.trim() ?? '';
    if (!trimmed) {
        return {
            query: '',
            hits: [],
            rewrittenQuery: null,
            queryVariants: [],
            strategy: 'vector',
            latencyMs: 0
        };
    }
    const url = new URL(resolveEndpoint('/search'));
    url.searchParams.set('q', trimmed);
    url.searchParams.set('limit', String(limit));
    const data = await requestJson<{ query: string; hits: any[] }>(url.toString(), { method: 'GET' });
    return mapSearchResponse(data);
}

/**
 * Progressive/layered search with streaming results.
 * Yields incremental results from: filename → summary → metadata → hybrid vector search
 */
export async function searchFilesStream(
    query: string,
    limit = 10,
    onData: (chunk: string) => void,
    onError: (error: Error) => void,
    onDone: () => void
): Promise<void> {
    const trimmed = query?.trim() ?? '';
    if (!trimmed) {
        onDone();
        return;
    }

    try {
        const headers: Record<string, string> = {};
        const key = getLocalKey();
        if (key) {
            headers['X-API-Key'] = key;
        }

        const url = new URL(resolveEndpoint('/search/stream'));
        url.searchParams.set('q', trimmed);
        url.searchParams.set('limit', String(limit));

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers,
        });

        if (!response.ok) {
            throw new Error(`Backend responded with ${response.status}`);
        }

        if (!response.body) {
            throw new Error('No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const chunk = decoder.decode(value, { stream: true });
            onData(chunk);
        }
        onDone();
    } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
    }
}

export async function askWorkspace(
    query: string,
    limit: number | undefined,
    mode: 'qa' | 'chat' = 'qa',
    searchMode: 'auto' | 'knowledge' | 'direct' = 'auto'
): Promise<QaResponse> {
    // Only include limit in payload if explicitly provided; otherwise let backend use its qa_context_limit setting
    const payload: Record<string, any> = { query, mode, search_mode: searchMode };
    if (limit !== undefined) {
        payload.limit = limit;
    }
    const data = await requestJson<{ answer: string; hits: any[]; latency_ms?: number }>(
        '/qa',
        {
            method: 'POST',
            body: JSON.stringify(payload)
        }
    );
    return mapQaResponse(data);
}

export async function askWorkspaceStream(
    query: string,
    limit: number | undefined,
    mode: 'qa' | 'chat' = 'qa',
    onData: (chunk: string) => void,
    onError: (error: Error) => void,
    onDone: () => void,
    searchMode: 'auto' | 'knowledge' | 'direct' = 'auto',
    resumeToken?: string,
    useVisionForAnswer?: boolean
): Promise<void> {
    // Only include limit in payload if explicitly provided; otherwise let backend use its qa_context_limit setting
    const payload: Record<string, any> = { 
        query, 
        mode, 
        search_mode: searchMode, 
        resume_token: resumeToken,
        use_vision_for_answer: useVisionForAnswer ?? false
    };
    if (limit !== undefined) {
        payload.limit = limit;
    }
    console.log('[backendClient] askWorkspaceStream payload:', JSON.stringify(payload));
    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const key = getLocalKey();
        if (key) {
            headers['X-API-Key'] = key;
        }

        const response = await fetch(resolveEndpoint('/qa/stream'), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Backend responded with ${response.status}`);
        }

        if (!response.body) {
            throw new Error('No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const chunk = decoder.decode(value, { stream: true });
            onData(chunk);
        }
        onDone();
    } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
    }
}

export async function listNotes(): Promise<NoteSummary[]> {
    const data = await requestJson<any[]>(`${NOTES_PLUGIN_PREFIX}`, { method: 'GET' });
    const payload = Array.isArray(data) ? data : [];
    return payload.map(mapNoteSummary);
}

export async function createNote(payload: NoteDraftPayload): Promise<NoteSummary> {
    const body = {
        title: payload.title ?? null,
        body: payload.body ?? null
    };
    const data = await requestJson(`${NOTES_PLUGIN_PREFIX}`, {
        method: 'POST',
        body: JSON.stringify(body)
    });
    return mapNoteSummary(data);
}

export async function getNote(noteId: string): Promise<NoteContent> {
    const data = await requestJson(`${NOTES_PLUGIN_PREFIX}/${encodeURIComponent(noteId)}`, { method: 'GET' });
    return mapNoteContent(data);
}

export async function updateNote(noteId: string, payload: NoteDraftPayload): Promise<NoteContent> {
    const body = {
        title: payload.title ?? null,
        body: payload.body ?? null
    };
    const data = await requestJson(`${NOTES_PLUGIN_PREFIX}/${encodeURIComponent(noteId)}`, {
        method: 'PUT',
        body: JSON.stringify(body)
    });
    return mapNoteContent(data);
}

export async function deleteNote(noteId: string): Promise<void> {
    await requestJson(`${NOTES_PLUGIN_PREFIX}/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
}

export async function ingestScreenshot(imageBytes: Uint8Array): Promise<ActivityLog> {
    const formData = new FormData();
    // Cast to any to avoid TS issues with ArrayBufferLike vs ArrayBuffer in Electron types
    const blob = new Blob([imageBytes as any], { type: 'image/jpeg' });
    formData.append('file', blob, 'screenshot.jpg');

    const headers: Record<string, string> = {};
    const key = getLocalKey();
    if (key) {
        headers['X-API-Key'] = key;
    }

    const response = await fetch(`${API_BASE_URL}${ACTIVITY_PLUGIN_PREFIX}/ingest`, {
        method: 'POST',
        headers,
        body: formData
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to ingest screenshot: ${response.status}${text ? `: ${text}` : ''}`);
    }

    return (await response.json()) as ActivityLog;
}

export async function getChunkHighlightPngBase64(chunkId: string, zoom: number = 2.0): Promise<string> {
    if (!chunkId) {
        throw new Error('Missing chunk id.');
    }
    const params = new URLSearchParams();
    params.set('zoom', String(zoom));
    const bytes = await requestBinary(`/files/chunks/${encodeURIComponent(chunkId)}/highlight.png?${params.toString()}`, {
        method: 'GET'
    });
    // Electron main process has Node Buffer.
    return Buffer.from(bytes).toString('base64');
}

export async function getPdfPageImageBase64(fileId: string, pageNumber: number, zoom: number = 2.0): Promise<string> {
    if (!fileId) {
        throw new Error('Missing file id.');
    }
    if (pageNumber < 1) {
        throw new Error('Page number must be >= 1.');
    }
    const params = new URLSearchParams();
    params.set('zoom', String(zoom));
    const endpoint = `/files/${encodeURIComponent(fileId)}/pages/${pageNumber}/image.png?${params.toString()}`;
    const bytes = await requestBinary(endpoint, { method: 'GET' });
    return Buffer.from(bytes).toString('base64');
}

export async function getActivityTimeline(start?: string, end?: string, summary: boolean = false): Promise<ActivityTimelineResponse> {
    const params = new URLSearchParams();
    if (start) params.append('start', start);
    if (end) params.append('end', end);
    if (summary) params.append('summary', 'true');

    const headers: Record<string, string> = {};
    const key = getLocalKey();
    if (key) {
        headers['X-API-Key'] = key;
    }

    const response = await fetch(`${API_BASE_URL}${ACTIVITY_PLUGIN_PREFIX}/timeline?${params.toString()}`, {
        headers
    });

    if (!response.ok) {
        throw new Error(`Failed to get activity timeline: ${response.statusText}`);
    }

    return (await response.json()) as ActivityTimelineResponse;
}

export async function deleteActivityLog(logId: string): Promise<void> {
    await requestJson(`${ACTIVITY_PLUGIN_PREFIX}/${encodeURIComponent(logId)}`, { method: 'DELETE' });
}

export async function listChatSessions(limit = 100, offset = 0): Promise<ChatSession[]> {
    const url = new URL(resolveEndpoint('/chat/sessions'));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await requestJson<any[]>(url.toString(), { method: 'GET' });
    const payload = Array.isArray(data) ? data : [];
    return payload.map(mapChatSession);
}

export async function createChatSession(title?: string): Promise<ChatSession> {
    const body = { title };
    const data = await requestJson('/chat/sessions', {
        method: 'POST',
        body: JSON.stringify(body)
    });
    return mapChatSession(data);
}

export async function getChatSession(sessionId: string): Promise<ChatSession> {
    const data = await requestJson(`/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
    return mapChatSession(data);
}

export async function deleteChatSession(sessionId: string): Promise<void> {
    await requestJson(`/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export async function updateChatSession(sessionId: string, title: string): Promise<ChatSession> {
    const body = { title };
    const data = await requestJson(`/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PUT',
        body: JSON.stringify(body)
    });
    return mapChatSession(data);
}

export async function addChatMessage(sessionId: string, message: Partial<ConversationMessage>): Promise<ConversationMessage> {
    const body = {
        role: message.role,
        content: message.text,
        meta: message.meta,
        references: message.references,
        // Multi-path thinking steps
        is_multi_path: message.isMultiPath,
        thinking_steps: message.thinkingSteps
    };
    const data = await requestJson(`/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify(body)
    });
    return mapChatMessage(data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Memory API
// ═══════════════════════════════════════════════════════════════════════════════

export interface MemoryEpisode {
    id: string;
    user_id: string;
    summary: string;
    episode?: string;
    timestamp: string;
    subject?: string;
    metadata?: Record<string, unknown>;
}

export interface MemoryProfile {
    user_id: string;
    user_name?: string;
    personality?: string[];
    interests?: string[];
    hard_skills?: Array<{ name: string; level: string }>;
    soft_skills?: Array<{ name: string; level: string }>;
}

export interface MemoryForesight {
    id: string;
    user_id: string;
    content: string;
    evidence?: string;
    parent_episode_id?: string;
    metadata?: Record<string, unknown>;
}

export interface MemoryEventLog {
    id: string;
    user_id: string;
    atomic_fact: string;
    timestamp: string;
    parent_episode_id?: string;
    metadata?: Record<string, unknown>;
}

export interface MemorySummary {
    user_id: string;
    profile?: MemoryProfile;
    memcells_count: number;
    episodes_count: number;
    event_logs_count: number;
    foresights_count: number;
    recent_episodes: MemoryEpisode[];
    recent_foresights: MemoryForesight[];
}

export interface MemoryMemCell {
    id: string;
    user_id: string;
    original_data: string;
    summary?: string;
    subject?: string;
    file_id?: string;
    chunk_id?: string;
    chunk_ordinal?: number;
    type?: string;
    keywords?: string[];
    timestamp: string;
    created_at?: string;
    metadata?: Record<string, unknown>;
}

export interface MemCellDetail {
    memcell: MemoryMemCell;
    episodes: MemoryEpisode[];
    event_logs: MemoryEventLog[];
}

export async function getMemorySummary(userId: string): Promise<MemorySummary> {
    const data = await requestJson<MemorySummary>(`/memory/${encodeURIComponent(userId)}`, { method: 'GET' });
    return data;
}

export async function getMemoryEpisodes(userId: string, limit = 50, offset = 0): Promise<MemoryEpisode[]> {
    const url = new URL(resolveEndpoint(`/memory/${encodeURIComponent(userId)}/episodes`));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await requestJson<MemoryEpisode[]>(url.toString(), { method: 'GET' });
    return Array.isArray(data) ? data : [];
}

export async function getMemoryEventLogs(userId: string, limit = 100, offset = 0): Promise<MemoryEventLog[]> {
    const url = new URL(resolveEndpoint(`/memory/${encodeURIComponent(userId)}/events`));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await requestJson<MemoryEventLog[]>(url.toString(), { method: 'GET' });
    return Array.isArray(data) ? data : [];
}

export async function getMemoryForesights(userId: string, limit = 50): Promise<MemoryForesight[]> {
    const url = new URL(resolveEndpoint(`/memory/${encodeURIComponent(userId)}/foresights`));
    url.searchParams.set('limit', String(limit));
    const data = await requestJson<MemoryForesight[]>(url.toString(), { method: 'GET' });
    return Array.isArray(data) ? data : [];
}

export async function getMemoryMemcells(userId: string, limit = 50, offset = 0): Promise<MemoryMemCell[]> {
    const url = new URL(resolveEndpoint(`/memory/${encodeURIComponent(userId)}/memcells`));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await requestJson<MemoryMemCell[]>(url.toString(), { method: 'GET' });
    return Array.isArray(data) ? data : [];
}

export async function getMemcellDetail(memcellId: string): Promise<MemCellDetail | null> {
    try {
        const data = await requestJson<MemCellDetail>(`/memory/memcells/${encodeURIComponent(memcellId)}`, { method: 'GET' });
        return data;
    } catch (error) {
        console.error(`Failed to get memcell ${memcellId}:`, error);
        return null;
    }
}

export async function getMemcellsByFile(fileId: string, limit = 100): Promise<MemoryMemCell[]> {
    const url = new URL(resolveEndpoint(`/memory/memcells/by-file/${encodeURIComponent(fileId)}`));
    url.searchParams.set('limit', String(limit));
    const data = await requestJson<MemoryMemCell[]>(url.toString(), { method: 'GET' });
    return Array.isArray(data) ? data : [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Basic Profile API (LLM-inferred from system data)
// ═══════════════════════════════════════════════════════════════════════════════

export interface SkillRecord {
    name: string;
    level?: string; // beginner/intermediate/advanced
}

export interface RawSystemData {
    username: string;
    computer_name: string;
    shell: string;
    language: string;
    region: string;
    timezone: string;
    appearance: string;
    installed_apps: string[];
    dev_tools: Array<{ name: string; version: string }>;
}

export interface ProfileSubtopic {
    name: string;
    description?: string;
    value?: any;
    confidence?: string; // high, medium, low
    evidence?: string;
}

export interface ProfileTopic {
    topic_id: string;
    topic_name: string;
    icon?: string;
    subtopics: ProfileSubtopic[];
}

export interface BasicProfile {
    user_id: string;
    user_name?: string;
    // Hierarchical topics (new)
    topics: ProfileTopic[];
    // LLM-inferred semantic profile (legacy flat fields)
    personality: string[];
    interests: string[];
    hard_skills: SkillRecord[];
    soft_skills: SkillRecord[];
    working_habit_preference: string[];
    user_goal: string[];
    motivation_system: string[];
    value_system: string[];
    inferred_roles: string[];
    // Raw system data for reference
    raw_system_data?: RawSystemData;
    scanned_at: string;
}

// Streaming event types for progressive profile generation
export interface ProfileStreamEvent {
    type: 'init' | 'topic' | 'complete' | 'error';
    data: any;
}

/**
 * Get cached basic profile (without regenerating).
 * Returns null if no cached profile exists.
 */
export async function getCachedBasicProfile(userId: string): Promise<BasicProfile | null> {
    try {
        const data = await requestJson<BasicProfile>(`/memory/basic-profile/${encodeURIComponent(userId)}/cached`, { method: 'GET' });
        return data;
    } catch (error) {
        // 404 means no cached profile
        if (error instanceof Error && error.message.includes('404')) {
            return null;
        }
        throw error;
    }
}

/**
 * Generate basic profile (always regenerates).
 * @deprecated Use streamBasicProfile for progressive generation
 */
export async function getBasicProfile(userId: string): Promise<BasicProfile> {
    const data = await requestJson<BasicProfile>(`/memory/basic-profile/${encodeURIComponent(userId)}`, { method: 'GET' });
    return data;
}

/**
 * Stream basic profile generation progressively.
 * Uses Server-Sent Events to receive topics as they are generated.
 *
 * @param userId - User ID
 * @param onEvent - Callback for each event (init, topic, complete, error)
 */
export async function streamBasicProfile(
    userId: string,
    onEvent: (event: ProfileStreamEvent) => void
): Promise<void> {
    const url = `${API_BASE_URL}/memory/basic-profile/${encodeURIComponent(userId)}/stream`;

    // Build headers with API key
    const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
    };
    const key = getLocalKey();
    if (key) {
        headers['X-API-Key'] = key;
        headers['X-Request-Source'] = 'local_ui';
    }

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (!response.body) {
            throw new Error('No response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        onEvent(data);

                        if (data.type === 'complete') {
                            return;
                        }
                    } catch (e) {
                        console.error('Failed to parse SSE data:', line, e);
                    }
                }
            }
        }
    } catch (error) {
        onEvent({
            type: 'error',
            data: { error: String(error) }
        });
        throw error;
    }
}

// ========================================
// Privacy APIs
// ========================================

export interface PrivacyLevel {
    privacy_level: 'normal' | 'private';
}

export interface FilePrivacyResponse {
    file_id: string;
    privacy_level: 'normal' | 'private';
    updated?: boolean;
}

export interface FolderPrivacyResponse {
    folder_id: string;
    privacy_level: 'normal' | 'private';
    updated?: boolean;
    files_updated?: number;
    files_normal?: number;
    files_private?: number;
}

/**
 * Update the privacy level of a file.
 * Only callable from local UI - external requests will be rejected.
 */
export async function setFilePrivacy(fileId: string, privacyLevel: 'normal' | 'private'): Promise<FilePrivacyResponse> {
    const data = await requestJson<any>(`/files/${encodeURIComponent(fileId)}/privacy`, {
        method: 'PUT',
        body: JSON.stringify({ privacy_level: privacyLevel }),
        headers: {
            'X-Request-Source': 'local_ui'  // Mark as local UI request for privacy access
        }
    });
    return {
        file_id: data.file_id,
        privacy_level: data.privacy_level,
        updated: data.updated
    };
}

/**
 * Get the privacy level of a file.
 */
export async function getFilePrivacy(fileId: string): Promise<FilePrivacyResponse> {
    const data = await requestJson<any>(`/files/${encodeURIComponent(fileId)}/privacy`, {
        method: 'GET',
        headers: {
            'X-Request-Source': 'local_ui'
        }
    });
    return {
        file_id: data.file_id,
        privacy_level: data.privacy_level
    };
}

/**
 * Update the privacy level of a folder and optionally all its files.
 * Only callable from local UI - external requests will be rejected.
 */
export async function setFolderPrivacy(
    folderId: string, 
    privacyLevel: 'normal' | 'private', 
    applyToFiles: boolean = true
): Promise<FolderPrivacyResponse> {
    const data = await requestJson<any>(`/folders/${encodeURIComponent(folderId)}/privacy`, {
        method: 'PUT',
        body: JSON.stringify({ 
            privacy_level: privacyLevel,
            apply_to_files: applyToFiles
        }),
        headers: {
            'X-Request-Source': 'local_ui'
        }
    });
    return {
        folder_id: data.folder_id,
        privacy_level: data.privacy_level,
        updated: data.updated,
        files_updated: data.files_updated
    };
}

/**
 * Get the privacy level of a folder and file counts.
 */
export async function getFolderPrivacy(folderId: string): Promise<FolderPrivacyResponse> {
    const data = await requestJson<any>(`/folders/${encodeURIComponent(folderId)}/privacy`, {
        method: 'GET',
        headers: {
            'X-Request-Source': 'local_ui'
        }
    });
    return {
        folder_id: data.folder_id,
        privacy_level: data.privacy_level,
        files_normal: data.files_normal,
        files_private: data.files_private
    };
}

// ========================================
// API Key Management
// ========================================

export interface ApiKeyRecord {
    key: string;
    name: string;
    created_at: string;
    last_used_at: string | null;
    is_active: boolean;
    is_system: boolean;
}

/**
 * List all API keys.
 */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
    return requestJson<ApiKeyRecord[]>('/security/keys');
}

/**
 * Create a new API key.
 */
export async function createApiKey(name: string): Promise<ApiKeyRecord> {
    return requestJson<ApiKeyRecord>(`/security/keys?name=${encodeURIComponent(name)}`, {
        method: 'POST'
    });
}

/**
 * Delete an API key.
 */
export async function deleteApiKey(key: string): Promise<{ status: string }> {
    return requestJson<{ status: string }>(`/security/keys/${encodeURIComponent(key)}`, {
        method: 'DELETE'
    });
}

/**
 * Enable or disable an API key.
 * Disabled keys will receive 403 Forbidden on all requests.
 */
export async function setApiKeyActive(key: string, isActive: boolean): Promise<{ status: string; key: string }> {
    return requestJson<{ status: string; key: string }>(`/security/keys/${encodeURIComponent(key)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: isActive })
    });
}

/**
 * Rename an API key.
 */
export async function renameApiKey(key: string, newName: string): Promise<{ status: string; key: string; name: string }> {
    return requestJson<{ status: string; key: string; name: string }>(`/security/keys/${encodeURIComponent(key)}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
    });
}

/**
 * Get or create an API key by name. If a key with the given name exists, return it.
 * Otherwise, create a new one.
 */
export async function getOrCreateApiKey(name: string): Promise<ApiKeyRecord> {
    const keys = await listApiKeys();
    const existing = keys.find(k => k.name === name && k.is_active && !k.is_system);
    if (existing) {
        return existing;
    }
    return createApiKey(name);
}

// ========================================
// Memory Extraction
// ========================================

export interface ExtractMemoryResponse {
    success: boolean;
    file_id: string;
    message: string;
    memcells_created: number;
    episodes_created: number;
    event_logs_created: number;
    foresights_created: number;
}

/**
 * Manually trigger memory extraction for a specific file.
 * @param force If true, re-extract even if already processed (no resume)
 * @param chunkSize Custom chunk size in chars. If set, concatenates all text and re-chunks
 */
export async function extractMemoryForFile(
    fileId: string, 
    userId: string = 'default_user', 
    force: boolean = false,
    chunkSize?: number
): Promise<ExtractMemoryResponse> {
    const body: Record<string, unknown> = { file_id: fileId, user_id: userId, force };
    if (chunkSize && chunkSize > 0) {
        body.chunk_size = chunkSize;
    }
    return requestJson<ExtractMemoryResponse>('/memory/extract', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

export interface PauseMemoryResponse {
    success: boolean;
    file_id: string;
    message: string;
}

/**
 * Pause memory extraction for a specific file.
 * Progress is saved and can be resumed later.
 */
export async function pauseMemoryForFile(fileId: string): Promise<PauseMemoryResponse> {
    return requestJson<PauseMemoryResponse>('/memory/pause', {
        method: 'POST',
        body: JSON.stringify({ file_id: fileId }),
    });
}

// ========================================
// Backend Settings
// ========================================

export interface BackendSettings {
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
}

/**
 * Get all backend settings
 */
export async function getBackendSettings(): Promise<BackendSettings> {
    return requestJson<BackendSettings>('/settings');
}
