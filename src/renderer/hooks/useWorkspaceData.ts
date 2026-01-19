import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type {
    FolderRecord,
    IndexedFile,
    IndexingItem,
    IndexSummary,
    IndexProgressUpdate,
    HealthStatus,
    FileRecord,
    FileKind,
    IndexResultSnapshot,
    EmailAccountSummary,
    SystemSpecs
} from '../types';

const INVENTORY_LIMIT = 500;

const KIND_DEFAULT_COUNTS: Record<FileKind, number> = {
    document: 0,
    image: 0,
    presentation: 0,
    spreadsheet: 0,
    audio: 0,
    video: 0,
    archive: 0,
    code: 0,
    book: 0,
    other: 0
};

function inferKind(extension: string): IndexedFile['kind'] {
    const ext = extension.toLowerCase();
    if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) return 'document';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'webp'].includes(ext)) return 'image';
    if (['ppt', 'pptx', 'key'].includes(ext)) return 'presentation';
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'spreadsheet';
    if (['mp3', 'wav', 'aac', 'flac'].includes(ext)) return 'audio';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'video';
    if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) return 'archive';
    return 'other';
}

function deriveDefaultLabel(pathValue: string): string {
    const normalised = pathValue.replace(/\\/g, '/');
    const segments = normalised.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? pathValue ?? 'Folder';
}

function deriveFolderLabel(folder: FolderRecord): string {
    if (folder.label && folder.label.trim()) return folder.label.trim();
    if (folder.path) return deriveDefaultLabel(folder.path);
    return `Folder ${folder.id}`;
}

function mapIndexedFile(record: FileRecord, folderMap: Map<string, FolderRecord>): IndexedFile {
    const folder = folderMap.get(record.folderId);
    const location = folder ? deriveFolderLabel(folder) : 'Unknown';
    const fullPath = record.path || record.name;

    // Ensure kind is set
    let kind = record.kind as IndexedFile['kind'];
    if (!kind) {
        const ext = record.extension || (record.name.includes('.') ? record.name.split('.').pop() || 'other' : 'other');
        kind = inferKind(ext);
    }

    return {
        ...record,
        kind,
        location,
        fullPath
    };
}

function buildSnapshot(files: IndexedFile[], summary: IndexSummary | null): IndexResultSnapshot | null {
    if (!summary) return null;
    const byKind: Record<FileKind, number> = { ...KIND_DEFAULT_COUNTS };
    const byLocation: Record<string, number> = {};
    files.forEach((file) => {
        byKind[file.kind] = (byKind[file.kind] ?? 0) + 1;
        byLocation[file.location] = (byLocation[file.location] ?? 0) + 1;
    });

    const completedAt = summary.lastCompletedAt ?? new Date().toISOString();
    const totalSize = summary.totalSizeBytes || files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const totalCount = summary.filesIndexed || files.length;

    return {
        files,
        startedAt: summary.lastCompletedAt ?? completedAt,
        completedAt,
        totalCount,
        totalSize,
        byKind,
        byLocation
    };
}

function normalisePath(value: string | null | undefined): string {
    return (value ?? '').replace(/\\/g, '/').toLowerCase();
}

export function useWorkspaceData() {
    const [folders, setFolders] = useState<FolderRecord[]>([]);
    const [emailAccounts, setEmailAccounts] = useState<EmailAccountSummary[]>([]);
    const [files, setFiles] = useState<IndexedFile[]>([]);
    const [indexingItems, setIndexingItems] = useState<IndexingItem[]>([]);
    const [summary, setSummary] = useState<IndexSummary | null>(null);
    const [progress, setProgress] = useState<IndexProgressUpdate | null>(null);
    const [stageProgress, setStageProgress] = useState<any | null>(null);
    const [health, setHealth] = useState<HealthStatus | null>(null);
    const [systemSpecs, setSystemSpecs] = useState<SystemSpecs | null>(null);
    const [isIndexing, setIsIndexing] = useState(false);
    const [backendStarting, setBackendStarting] = useState(true);

    // These are needed for partitioning but managed by other hooks or passed in
    // For now we'll keep the partitioning logic here but it might need to accept email/notes data
    const [emailIndexingByAccount, setEmailIndexingByAccount] = useState<Record<string, IndexingItem[]>>({});
    const [noteIndexingItems, setNoteIndexingItems] = useState<IndexingItem[]>([]);
    const [noteFolderId, setNoteFolderId] = useState<string | null>(null);

    const pollTimerRef = useRef<number | null>(null);
    const startupRetryCountRef = useRef(0);
    const maxStartupRetries = 30; // Allow up to 30 retries (about 60 seconds with 2s intervals)
    const refreshCountRef = useRef(0); // Track refresh count for skipping expensive queries during indexing

    const partitionIndexingItems = useCallback(
        (
            items: IndexingItem[],
            folderRecords: FolderRecord[],
            accountSummaries: EmailAccountSummary[]
        ) => {
            const accountFolderMap = new Map<string, string>();
            accountSummaries.forEach((account) => {
                accountFolderMap.set(account.folderId, account.id);
            });

            const notesFolderIds = new Set(
                folderRecords
                    .filter((folder) => folder.path.toLowerCase().includes('/.local_rag/notes'))
                    .map((folder) => folder.id)
            );

            const emailIndexing: Record<string, IndexingItem[]> = {};
            const noteIndexing: IndexingItem[] = [];
            const generalIndexing: IndexingItem[] = [];

            items.forEach((item) => {
                const accountId = accountFolderMap.get(item.folderId);
                if (accountId) {
                    if (!emailIndexing[accountId]) {
                        emailIndexing[accountId] = [];
                    }
                    emailIndexing[accountId].push(item);
                    return;
                }
                if (notesFolderIds.has(item.folderId)) {
                    noteIndexing.push(item);
                    return;
                }
                generalIndexing.push(item);
            });

            return { generalIndexing, emailIndexing, noteIndexing };
        },
        []
    );

    const refreshData = useCallback(async () => {
        const api = window.api;
        if (!api) return;

        try {
            // First check if backend is reachable via health check
            const healthData = await api.health();
            
            // If health status is degraded (backend unreachable), handle gracefully
            if (healthData.status === 'degraded') {
                setHealth(healthData);
                // During startup, silently wait for backend - don't spam errors
                if (backendStarting && startupRetryCountRef.current < maxStartupRetries) {
                    startupRetryCountRef.current += 1;
                    return null;
                }
                // After startup period, log but don't spam
                if (startupRetryCountRef.current === maxStartupRetries) {
                    console.warn('Backend appears to be offline. Will continue checking...');
                    startupRetryCountRef.current += 1; // Prevent repeated warnings
                }
                return null;
            }

            // Backend is ready - reset startup state
            if (backendStarting) {
                setBackendStarting(false);
                startupRetryCountRef.current = 0;
            }

            // OPTIMIZATION: Skip expensive inventory query during active indexing
            // This query fetches 500 files with full metadata, causing DB contention
            // Only fetch every 3rd time during indexing to reduce load
            refreshCountRef.current += 1;
            const isCurrentlyIndexing = healthData.status === 'indexing';
            const shouldSkipInventory = isCurrentlyIndexing && (refreshCountRef.current % 3 !== 0);
            
            const [summaryData, folderData, inventoryData, emailData, specsData, stageProgressData] = await Promise.all([
                api.indexSummary(),
                api.listFolders(),
                shouldSkipInventory
                    ? Promise.resolve({ files: files, progress, indexing: [] }) // Return cached data
                    : api.indexInventory({ limit: INVENTORY_LIMIT }),
                api.listEmailAccounts?.() ?? Promise.resolve([]),
                (api as any).getSystemSpecs ? (api as any).getSystemSpecs() : Promise.resolve(null),
                (api as any).stageProgress ? (api as any).stageProgress() : Promise.resolve(null)
            ]);

            setHealth(healthData);
            setSystemSpecs(specsData);
            setSummary(summaryData);
            setProgress(inventoryData.progress);
            setStageProgress(stageProgressData);
            setIsIndexing(inventoryData.progress.status === 'running' || inventoryData.progress.status === 'paused');
            setFolders(folderData);

            const foundNotesFolder = folderData.find((folder: FolderRecord) => normalisePath(folder.path).includes('/.local_rag/notes'));
            setNoteFolderId(foundNotesFolder ? foundNotesFolder.id : null);

            const folderMap = new Map<string, FolderRecord>(folderData.map((folder: FolderRecord) => [folder.id, folder]));
            const indexedFiles = inventoryData.files.map((record: FileRecord) => mapIndexedFile(record, folderMap));
            setFiles(indexedFiles);

            const resolvedEmailAccounts = Array.isArray(emailData)
                ? (emailData as EmailAccountSummary[])
                : [];
            setEmailAccounts(resolvedEmailAccounts);

            const { generalIndexing, emailIndexing, noteIndexing } = partitionIndexingItems(
                inventoryData.indexing,
                folderData,
                resolvedEmailAccounts
            );
            setIndexingItems(generalIndexing);
            setEmailIndexingByAccount(emailIndexing);
            setNoteIndexingItems(noteIndexing);

            return {
                folders: folderData,
                emailAccounts: resolvedEmailAccounts
            };
        } catch (error) {
            // During startup, silently handle errors to avoid log spam
            if (backendStarting && startupRetryCountRef.current < maxStartupRetries) {
                startupRetryCountRef.current += 1;
                // Set degraded health status
                setHealth({
                    status: 'degraded',
                    indexedFiles: 0,
                    watchedFolders: 0,
                    message: 'Backend starting...'
                });
                return null;
            }
            // Only log after startup period
            console.error('Failed to refresh workspace data', error);
            return null;
        }
    }, [partitionIndexingItems, backendStarting]);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current !== null) {
            window.clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    const scheduleStatusPoll = useCallback(() => {
        const api = window.api;
        if (!api?.indexStatus) return;

        stopPolling();

        const poll = async () => {
            try {
                const status = await api.indexStatus();
                setProgress(status);

                // We need current folders and email accounts for partitioning
                // Since we can't easily access state inside the callback without refs or deps,
                // we might need to fetch them or rely on the last refresh.
                // For simplicity in this hook, we'll re-fetch folders/emails if needed or just use what we have if we can.
                // Actually, let's just fetch inventory and partition.

                if (status.status === 'running') {
                    setIsIndexing(true);
                    try {
                        const [inventory, folderData, emailData] = await Promise.all([
                            api.indexInventory({ limit: INVENTORY_LIMIT }),
                            api.listFolders(),
                            api.listEmailAccounts?.() ?? Promise.resolve([])
                        ]);

                        const { generalIndexing, emailIndexing, noteIndexing } = partitionIndexingItems(
                            inventory.indexing,
                            folderData,
                            emailData as EmailAccountSummary[]
                        );
                        setIndexingItems(generalIndexing);
                        setEmailIndexingByAccount(emailIndexing);
                        setNoteIndexingItems(noteIndexing);
                        setProgress(inventory.progress);
                    } catch (inventoryError) {
                        console.warn('Failed to refresh inventory during indexing', inventoryError);
                    }
                    pollTimerRef.current = window.setTimeout(poll, 1500);
                } else if (status.status === 'paused') {
                    setIsIndexing(true);
                    pollTimerRef.current = window.setTimeout(poll, 1500);
                } else {
                    setIndexingItems([]);
                    setEmailIndexingByAccount({});
                    setNoteIndexingItems([]);
                    setIsIndexing(false);
                    stopPolling();
                    await refreshData();
                }
            } catch (error) {
                console.error('Index status polling failed', error);
                setIsIndexing(false);
                stopPolling();
            }
        };

        // OPTIMIZATION: Reduce polling frequency during indexing to avoid DB lock contention
        // Previous: 1500ms caused too many requests competing with indexing I/O
        pollTimerRef.current = window.setTimeout(poll, 3000);
    }, [partitionIndexingItems, refreshData, stopPolling]);

    useEffect(() => {
        void refreshData();
        return () => {
            stopPolling();
        };
    }, [refreshData, stopPolling]);

    useEffect(() => {
        // Use shorter interval during startup to detect backend readiness faster
        // OPTIMIZATION: Increase interval during normal operation to reduce DB contention
        // Previous: 5000ms was still causing significant overhead during bulk indexing
        const interval = backendStarting ? 2000 : 8000;
        const intervalId = window.setInterval(() => {
            void refreshData();
        }, interval);
        return () => window.clearInterval(intervalId);
    }, [refreshData, backendStarting]);

    useEffect(() => {
        if (progress?.status === 'running' && pollTimerRef.current === null) {
            scheduleStatusPoll();
        }
    }, [progress?.status, scheduleStatusPoll]);

    const snapshot = useMemo(() => buildSnapshot(files, summary), [files, summary]);
    const fileMap = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);

    const startSemanticIndexing = useCallback(async () => {
        const api = window.api;
        if (!api || !(api as any).startSemanticIndexing) return;
        try {
            await (api as any).startSemanticIndexing();
            await refreshData();
        } catch (error) {
            console.error('Failed to start semantic indexing', error);
        }
    }, [refreshData]);

    const stopSemanticIndexing = useCallback(async () => {
        const api = window.api;
        if (!api || !(api as any).stopSemanticIndexing) return;
        try {
            await (api as any).stopSemanticIndexing();
            await refreshData();
        } catch (error) {
            console.error('Failed to stop semantic indexing', error);
        }
    }, [refreshData]);

    const startDeepIndexing = useCallback(async () => {
        const api = window.api;
        if (!api || !(api as any).startDeepIndexing) return;
        try {
            await (api as any).startDeepIndexing();
            await refreshData();
        } catch (error) {
            console.error('Failed to start deep indexing', error);
        }
    }, [refreshData]);

    const stopDeepIndexing = useCallback(async () => {
        const api = window.api;
        if (!api || !(api as any).stopDeepIndexing) return;
        try {
            await (api as any).stopDeepIndexing();
            await refreshData();
        } catch (error) {
            console.error('Failed to stop deep indexing', error);
        }
    }, [refreshData]);

    return {
        folders,
        emailAccounts,
        files,
        indexingItems,
        summary,
        progress,
        stageProgress,
        health,
        systemSpecs,
        isIndexing,
        emailIndexingByAccount,
        noteIndexingItems,
        noteFolderId,
        snapshot,
        fileMap,
        refreshData,
        scheduleStatusPoll,
        setIsIndexing,
        setProgress,
        setIndexingItems,
        backendStarting,
        startSemanticIndexing,
        stopSemanticIndexing,
        startDeepIndexing,
        stopDeepIndexing
    };
}
