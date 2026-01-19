import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Folder, Plus, Trash2, AlertTriangle, Info, ChevronDown, ChevronUp, FileText, Clock, ArrowUp } from 'lucide-react';
import { cn } from '../lib/utils';
import type { FolderRecord, IndexingItem, IndexedFile } from '../types';

interface MonitoredFoldersPanelProps {
    folders: FolderRecord[];
    folderStats?: Map<string, { indexed: number; pending: number }>;
    files?: IndexedFile[];
    onAdd: () => Promise<void>;
    onRemove: (folderId: string) => Promise<void>;
    onRescan?: (folderId: string, mode?: 'fast' | 'deep') => Promise<void>;
    onReindex?: (folderId: string, mode?: 'fast' | 'deep') => Promise<void>;
    onSelectFile?: (file: IndexedFile) => void;
    onOpenFile?: (file: IndexedFile) => void | Promise<void>;
    isIndexing?: boolean;
    indexingItems?: IndexingItem[];
    lastError?: string | null;
    message?: string | null;
    className?: string;
}

// Dropdown component for index actions
function IndexDropdown({
    label,
    options,
    onSelect,
    disabled,
    variant = 'default'
}: {
    label: string;
    options: { label: string; value: string }[];
    onSelect: (value: string) => void;
    disabled?: boolean;
    variant?: 'default' | 'small';
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [openUpward, setOpenUpward] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleToggle = () => {
        if (disabled) return;

        if (!isOpen && buttonRef.current) {
            // Check if there's enough space below (menu height ~80px)
            const rect = buttonRef.current.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            setOpenUpward(spaceBelow < 100);
        }
        setIsOpen(!isOpen);
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                ref={buttonRef}
                type="button"
                onClick={handleToggle}
                disabled={disabled}
                className={cn(
                    "inline-flex items-center justify-center rounded-md border bg-background font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none",
                    variant === 'small' ? "px-2 py-1 text-[11px] gap-1" : "px-3 py-1.5 text-xs gap-1.5"
                )}
            >
                {label}
                <ChevronDown className={cn("transition-transform", variant === 'small' ? "h-3 w-3" : "h-3.5 w-3.5", isOpen && "rotate-180")} />
            </button>
            {isOpen && (
                <div className={cn(
                    "absolute right-0 z-50 min-w-[140px] rounded-md border bg-popover p-1 shadow-md",
                    openUpward ? "bottom-full mb-1" : "top-full mt-1"
                )}>
                    {options.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => {
                                onSelect(option.value);
                                setIsOpen(false);
                            }}
                            className="w-full text-left rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

function formatBytes(size: number): string {
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

type IndexMode = 'fast' | 'deep' | 'none' | 'error' | 'processing';

function getFileIndexMode(file: IndexedFile): IndexMode {
    // Check index status first
    if (file.indexStatus === 'error') return 'error';
    if (file.indexStatus === 'pending') return 'none';

    const metadata = file.metadata as Record<string, unknown> | undefined;
    if (!metadata) return 'none';

    // Check chunk_strategy which contains the indexing mode
    const chunkStrategy = metadata.chunk_strategy as string | undefined;
    if (chunkStrategy) {
        if (chunkStrategy.includes('_fine')) return 'deep';
        if (chunkStrategy.includes('_fast')) return 'fast';
    }

    // Fallback to pdf_vision_mode
    const pdfVisionMode = metadata.pdf_vision_mode as string | undefined;
    if (pdfVisionMode === 'deep') return 'deep';
    if (pdfVisionMode === 'fast') return 'fast';

    // If we have any chunk strategy, assume it's indexed
    if (chunkStrategy) return 'fast';

    return 'none';
}

function IndexModeTag({ mode, errorReason, progress }: { mode: IndexMode; errorReason?: string | null; progress?: number | null }) {
    if (mode === 'error') {
        return (
            <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-destructive/10 text-destructive"
                title={errorReason || 'Failed to index'}
            >
                Error
            </span>
        );
    }
    if (mode === 'processing') {
        const displayProgress = typeof progress === 'number' ? Math.round(progress) : null;
        return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 animate-pulse">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping" />
                {displayProgress !== null ? `${displayProgress}%` : 'Processing'}
            </span>
        );
    }
    if (mode === 'deep') {
        return (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
                Deep
            </span>
        );
    }
    if (mode === 'fast') {
        return (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                Fast
            </span>
        );
    }
    return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            Pending
        </span>
    );
}

function formatTimestamp(value: string | null | undefined): string {
    if (!value) return 'Never indexed';
    try {
        return new Date(value).toLocaleString();
    } catch {
        return value;
    }
}

export function MonitoredFoldersPanel({
    folders,
    folderStats,
    files = [],
    onAdd,
    onRemove,
    onRescan,
    onReindex,
    onSelectFile,
    onOpenFile,
    isIndexing,
    indexingItems,
    lastError,
    message,
    className
}: MonitoredFoldersPanelProps) {
    const [isAdding, setIsAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [folderModes, setFolderModes] = useState<Record<string, 'fast' | 'deep'>>({});
    const [expandedFolderId, setExpandedFolderId] = useState<string | null>(null);

    // Normalize paths for comparison
    const normalizePath = (p: string) => p?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';

    // Check if a file is being processed - using fileId, fileName, or path matching
    const isFileProcessing = useCallback((file: IndexedFile, items: IndexingItem[]) => {
        return items.some(item => {
            // Try matching by file ID first (most reliable)
            if (item.fileId && item.fileId === file.id) {
                return true;
            }
            // Try matching by file name
            if (item.fileName && item.fileName === file.name) {
                return true;
            }
            // Try matching by path
            const itemPath = normalizePath(item.filePath ?? '');
            const fileFullPath = normalizePath(file.fullPath);
            const filePath = normalizePath(file.path);
            return (
                itemPath === fileFullPath ||
                itemPath === filePath ||
                itemPath.endsWith('/' + file.name)
            );
        });
    }, []);

    // Get files for the expanded folder, sorted with processing first, then errors, then pending, then indexed
    const expandedFolderFiles = useMemo(() => {
        if (!expandedFolderId) return [];

        const items = indexingItems ?? [];

        return files
            .filter((file) => file.folderId === expandedFolderId)
            .sort((a, b) => {
                // Check if files are being processed
                const aProcessing = isFileProcessing(a, items);
                const bProcessing = isFileProcessing(b, items);

                // Processing files come first
                if (aProcessing && !bProcessing) return -1;
                if (!aProcessing && bProcessing) return 1;

                // Sort by status: error > pending > indexed
                const statusOrder = { error: 0, pending: 1, indexed: 2 };
                const aStatus = a.indexStatus ?? 'indexed';
                const bStatus = b.indexStatus ?? 'indexed';
                const statusDiff = (statusOrder[aStatus] ?? 2) - (statusOrder[bStatus] ?? 2);
                if (statusDiff !== 0) return statusDiff;
                // Then by name
                return a.name.localeCompare(b.name);
            });
    }, [expandedFolderId, files, indexingItems, isFileProcessing]);

    const readStoredMode = (folderId: string): 'fast' | 'deep' => {
        try {
            const stored = localStorage.getItem(`folder-mode-${folderId}`);
            return stored === 'deep' ? 'deep' : 'fast';
        } catch {
            return 'fast';
        }
    };

    // Initialise/reset modes when the folder list changes; drop modes for removed folders.
    useEffect(() => {
        setFolderModes(() => {
            const next: Record<string, 'fast' | 'deep'> = {};
            folders.forEach((folder) => {
                next[folder.id] = readStoredMode(folder.id);
            });
            return next;
        });
    }, [folders]);

    const setFolderMode = (folderId: string, mode: 'fast' | 'deep') => {
        setFolderModes((prev) => ({ ...prev, [folderId]: mode }));
        try {
            localStorage.setItem(`folder-mode-${folderId}`, mode);
        } catch {
            // Non-fatal: if storage fails, still keep in-memory state.
        }
    };

    const resolveMode = (folderId: string): 'fast' | 'deep' => {
        return folderModes[folderId] ?? 'fast';
    };

    // Handle folder-level index all action
    const handleIndexAll = (folderId: string, mode: 'fast' | 'deep') => {
        setFolderMode(folderId, mode);
        if (onReindex) {
            void onReindex(folderId, mode);
        } else if (onRescan) {
            void onRescan(folderId, mode);
        }
    };

    // Handle single file index/reindex
    // Use different API based on mode:
    // - Fast: Use staged indexing (fast text extraction, no VLM)
    // - Deep: Use legacy indexing with VLM processing
    const handleFileIndex = (filePath: string, mode: 'fast' | 'deep') => {
        if (mode === 'fast') {
            window.api?.runStagedIndex?.({
                files: [filePath],
                mode: 'reindex', // Always use reindex to reset file stage
            });
        } else {
            window.api?.runIndex?.({
                mode: 'reindex',
                files: [filePath],
                indexing_mode: 'deep'
            });
        }
    };

    // Combine local error with global indexing error if relevant
    const displayError = error || lastError;
    const displayMessage = message;

    async function handleAdd() {
        setError(null);
        setIsAdding(true);
        try {
            await onAdd();
        } catch (err) {
            console.error('Failed to add folder', err);
            setError(err instanceof Error ? err.message : 'Unable to add folder.');
        } finally {
            setIsAdding(false);
        }
    }

    async function handleRemove(folderId: string) {
        setError(null);
        try {
            await onRemove(folderId);
            setConfirming(null);
        } catch (err) {
            console.error('Failed to remove folder', err);
            setError(err instanceof Error ? err.message : 'Unable to remove folder.');
        }
    }

    function resolveStats(folderId: string) {
        return folderStats?.get(folderId) ?? { indexed: 0, pending: 0 };
    }

    return (
        <div className={cn("flex h-full flex-col gap-6 max-w-5xl mx-auto overflow-y-auto pb-8", className)}>
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-semibold tracking-tight">Monitored Folders</h2>
                    <p className="text-sm text-muted-foreground">
                        {folders.length
                            ? `${folders.length} folder${folders.length === 1 ? '' : 's'} watching for changes.`
                            : 'Add a local folder and the backend will keep it indexed.'}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void handleAdd()}
                    disabled={isAdding}
                    className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
                >
                    <Plus className="mr-2 h-4 w-4" />
                    {isAdding ? 'Adding…' : 'Add folder'}
                </button>
            </div>

            {displayError ? (
                <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive shadow-sm">
                    <AlertTriangle className="h-5 w-5 shrink-0" />
                    <div className="font-medium">{displayError}</div>
                </div>
            ) : isIndexing ? (
                <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2 min-w-0">
                        <Info className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">Indexing in progress — see Progress in the sidebar.</span>
                    </div>
                    {displayMessage ? (
                        <span className="hidden sm:inline truncate text-[10px] opacity-80">{displayMessage}</span>
                    ) : null}
                </div>
            ) : displayMessage ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <Info className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{displayMessage}</span>
                </div>
            ) : null}

            <div className="space-y-3">
                {folders.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center text-muted-foreground">
                        <Folder className="mb-2 h-8 w-8 opacity-50" />
                        <p className="text-sm">No folders monitored</p>
                        <p className="text-xs opacity-70 mt-1">Use the button above to choose a directory</p>
                    </div>
                ) : (
                    folders.map((folder) => {
                        const stats = resolveStats(folder.id);
                        const folderItems = indexingItems?.filter(item => item.folderId === folder.id) ?? [];
                        const processingItem = folderItems.find(item => item.status === 'processing');
                        const queuedCount = folderItems.length;

                        // Count files by status from the files list
                        const folderFiles = files.filter(f => f.folderId === folder.id);
                        const indexedFilesCount = folderFiles.filter(f => f.indexStatus === 'indexed' || !f.indexStatus).length;
                        const errorFilesCount = folderFiles.filter(f => f.indexStatus === 'error').length;
                        const pendingFilesCount = folderFiles.filter(f => f.indexStatus === 'pending').length;

                        // Total is simply the number of files we know about
                        const total = folderFiles.length || 1;
                        const failedCount = errorFilesCount;

                        // Calculate progress: indexed / total
                        let percent = 0;
                        if (total > 0) {
                            const baseProgress = (indexedFilesCount / total) * 100;
                            // Add progress from currently processing item (scaled to one file's worth)
                            const itemProgress = processingItem ? (processingItem.progress ?? 0) / total : 0;
                            percent = Math.min(100, Math.round(baseProgress + itemProgress));
                        }

                        // If we are indexing but no pending files, show indeterminate
                        const showIndeterminate = isIndexing && pendingFilesCount === 0 && queuedCount === 0 && percent === 100;
                        const hasFailedFiles = failedCount > 0;

                        return (
                            <div key={folder.id} className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex items-center gap-3">
                                        <div className="h-10 w-10 rounded bg-primary/10 flex items-center justify-center shrink-0">
                                            <Folder className="h-5 w-5 text-primary" />
                                        </div>
                                        <div>
                                            <p className="text-base font-semibold">{folder.label}</p>
                                            <p className="text-xs text-muted-foreground font-mono">{folder.path}</p>
                                            {processingItem ? (
                                                <p className="text-[10px] text-primary mt-1 animate-pulse">
                                                    Processing: {processingItem.filePath.split(/[/\\]/).pop()}
                                                    {processingItem.progress ? ` (${Math.round(processingItem.progress)}%)` : ''}
                                                </p>
                                            ) : showIndeterminate ? (
                                                <p className="text-[10px] text-primary mt-1 animate-pulse">
                                                    Checking for changes...
                                                </p>
                                            ) : null}
                                            {hasFailedFiles && !isIndexing && (
                                                <p className="text-[10px] text-destructive mt-1 flex items-center gap-1">
                                                    <AlertTriangle className="h-3 w-3" />
                                                    {(folder.failedFiles?.length ?? 0)} file(s) failed to index
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                                        <span className="rounded-full border bg-muted px-2.5 py-0.5">
                                            {percent}% synced
                                        </span>
                                        <span>{indexedFilesCount} / {total} files</span>
                                        {failedCount > 0 && (
                                            <span className="text-destructive">{failedCount} failed</span>
                                        )}
                                        {pendingFilesCount > 0 && (
                                            <span className="text-amber-600 dark:text-amber-400">{pendingFilesCount} pending</span>
                                        )}
                                        <span>{queuedCount > 0 ? `${queuedCount} queued` : 'Idle'}</span>
                                    </div>
                                </div>
                                <div className="mt-4 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                    {showIndeterminate ? (
                                        <div className="h-full w-full bg-primary/30 animate-pulse" />
                                    ) : (
                                        <div
                                            className={cn(
                                                "h-full transition-[width]",
                                                hasFailedFiles ? "bg-destructive/70" : "bg-primary"
                                            )}
                                            style={{ width: `${percent}%` }}
                                        />
                                    )}
                                </div>

                                {hasFailedFiles && (
                                    <div className="mt-2 rounded bg-destructive/10 p-2 text-[10px] text-destructive">
                                        <p className="font-semibold">
                                            {failedCount || (folder.failedFiles?.length ?? 0)} file(s) failed to index — expand &quot;Show Files&quot; to retry individual files
                                        </p>
                                    </div>
                                )}

                                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                                    <div>
                                        <span className="uppercase tracking-wider text-[10px] font-medium opacity-70">Last indexed</span>
                                        <p className="font-medium text-foreground">{formatTimestamp(folder.lastIndexedAt)}</p>
                                    </div>
                                    <div className="text-[10px] opacity-70">
                                        Added {new Date(folder.createdAt).toLocaleDateString()}
                                    </div>
                                </div>
                                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-3 border-t">
                                    <button
                                        type="button"
                                        onClick={() => setExpandedFolderId(prev => prev === folder.id ? null : folder.id)}
                                        className="inline-flex items-center justify-center rounded-md border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                                    >
                                        {expandedFolderId === folder.id ? (
                                            <ChevronUp className="mr-2 h-3.5 w-3.5" />
                                        ) : (
                                            <ChevronDown className="mr-2 h-3.5 w-3.5" />
                                        )}
                                        {expandedFolderId === folder.id ? 'Hide Files' : 'Show Files'}
                                    </button>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {/* Index All dropdown button */}
                                        <IndexDropdown
                                            label={`Index All (${resolveMode(folder.id) === 'fast' ? 'Fast' : 'Deep'})`}
                                            options={[
                                                { label: '✓ Index All (Fast)', value: 'fast' },
                                                { label: 'Index All (Deep)', value: 'deep' }
                                            ].map(opt => ({
                                                ...opt,
                                                label: opt.value === resolveMode(folder.id)
                                                    ? `✓ Index All (${opt.value === 'fast' ? 'Fast' : 'Deep'})`
                                                    : `Index All (${opt.value === 'fast' ? 'Fast' : 'Deep'})`
                                            }))}
                                            onSelect={(value) => handleIndexAll(folder.id, value as 'fast' | 'deep')}
                                        />

                                        {/* Remove button with confirmation */}
                                        {confirming === folder.id ? (
                                            <div className="flex gap-2">
                                                <button
                                                    type="button"
                                                    onClick={async (e) => {
                                                        const btn = e.currentTarget;
                                                        btn.disabled = true;
                                                        btn.textContent = 'Deleting...';
                                                        await handleRemove(folder.id);
                                                    }}
                                                    className="inline-flex items-center justify-center rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                                                >
                                                    Confirm
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setConfirming(null)}
                                                    className="inline-flex items-center justify-center rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => setConfirming(folder.id)}
                                                className="inline-flex items-center justify-center rounded-md border border-destructive/50 bg-background px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
                                            >
                                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                                Remove
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* Expanded file list */}
                                {expandedFolderId === folder.id && (
                                    <div className="mt-4 border-t pt-4">
                                        <div className="flex items-center justify-between mb-3 text-xs text-muted-foreground">
                                            <div className="flex items-center gap-1">
                                                <Clock className="h-3 w-3" />
                                                Updated {folder.lastIndexedAt ? new Date(folder.lastIndexedAt).toLocaleString() : 'Never'}
                                            </div>
                                            <span>
                                                {stats.pending ? `${stats.pending} files pending` : 'All files indexed'}
                                            </span>
                                        </div>

                                        <div className="space-y-1 max-h-60 overflow-y-auto">
                                            {expandedFolderFiles.length ? (
                                                expandedFolderFiles.map((file) => {
                                                    // Check if this file is currently being processed
                                                    const processingItem = (indexingItems ?? []).find(item => {
                                                        // Try matching by file ID first (most reliable)
                                                        if (item.fileId && item.fileId === file.id) {
                                                            return true;
                                                        }
                                                        // Try matching by file name
                                                        if (item.fileName && item.fileName === file.name) {
                                                            return true;
                                                        }
                                                        // Try matching by path
                                                        const itemPath = normalizePath(item.filePath ?? '');
                                                        const fileFullPath = normalizePath(file.fullPath);
                                                        const filePath = normalizePath(file.path);
                                                        return (
                                                            itemPath === fileFullPath ||
                                                            itemPath === filePath ||
                                                            itemPath.endsWith('/' + file.name)
                                                        );
                                                    });
                                                    const isProcessing = !!processingItem;
                                                    const processingProgress = processingItem?.progress ?? null;

                                                    const baseIndexMode = getFileIndexMode(file);
                                                    const indexMode: IndexMode = isProcessing ? 'processing' : baseIndexMode;
                                                    const isPending = indexMode === 'none';
                                                    const isError = indexMode === 'error';
                                                    const isFast = indexMode === 'fast';
                                                    const needsIndex = isPending || isError;

                                                    return (
                                                        <div
                                                            key={file.id}
                                                            className={cn(
                                                                "w-full flex items-center justify-between p-2 rounded hover:bg-accent/50 text-left group",
                                                                isError && "bg-destructive/5 border border-destructive/20",
                                                                isProcessing && "bg-blue-50/50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800"
                                                            )}
                                                        >
                                                            <button
                                                                onClick={() => onSelectFile?.(file)}
                                                                onDoubleClick={() => void onOpenFile?.(file)}
                                                                className="flex-1 flex items-center gap-2 min-w-0"
                                                            >
                                                                <FileText className={cn(
                                                                    "h-3 w-3 shrink-0",
                                                                    isError ? "text-destructive" : isProcessing ? "text-blue-500 animate-pulse" : "text-muted-foreground"
                                                                )} />
                                                                <div className="flex flex-col min-w-0">
                                                                    <span className={cn(
                                                                        "text-sm truncate",
                                                                        isError && "text-destructive",
                                                                        isProcessing && "text-blue-700 dark:text-blue-400"
                                                                    )}>{file.name}</span>
                                                                    {isError && file.errorReason && (
                                                                        <span className="text-[10px] text-destructive/80 truncate" title={file.errorReason}>
                                                                            {file.errorReason.substring(0, 60)}{file.errorReason.length > 60 ? '...' : ''}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </button>
                                                            <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                                                                <span className="uppercase hidden sm:inline">{file.extension}</span>
                                                                <span className="w-14 text-right hidden sm:inline">{formatBytes(file.size)}</span>
                                                                <IndexModeTag mode={indexMode} errorReason={file.errorReason} progress={processingProgress} />

                                                                {/* Quick upgrade button - only show for Fast indexed files */}
                                                                {isFast && !isProcessing && (
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleFileIndex(file.fullPath, 'deep');
                                                                        }}
                                                                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:hover:bg-violet-900/50 transition-colors"
                                                                        title="Upgrade to Deep index"
                                                                    >
                                                                        <ArrowUp className="h-3 w-3" />
                                                                        Deep
                                                                    </button>
                                                                )}

                                                                {/* Dropdown menu for index/reindex options - hide when processing */}
                                                                {!isProcessing && (
                                                                    <IndexDropdown
                                                                        label={needsIndex ? (isError ? 'Retry' : 'Index') : 'Reindex'}
                                                                        options={needsIndex ? [
                                                                            { label: 'Fast Index', value: 'fast' },
                                                                            { label: 'Deep Index', value: 'deep' }
                                                                        ] : [
                                                                            { label: 'Fast Reindex', value: 'fast' },
                                                                            { label: 'Deep Reindex', value: 'deep' }
                                                                        ]}
                                                                        onSelect={(value) => handleFileIndex(file.fullPath, value as 'fast' | 'deep')}
                                                                        variant="small"
                                                                    />
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })
                                            ) : (
                                                <div className="text-center py-4 text-sm text-muted-foreground border border-dashed rounded">
                                                    No files found. Click &quot;Index All&quot; to scan and index this folder.
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
