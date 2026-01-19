import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, FileText, ExternalLink, Activity, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Shield, ShieldOff } from 'lucide-react';
import type { IndexedFile, SearchHit, IndexProgressUpdate, IndexingItem, PrivacyLevel } from '../../types';
import type { StagedIndexProgress } from '../../../electron/backendClient';
import { IndexProgressPanel } from '../IndexProgressPanel';

interface RightPanelProps {
    selectedFile: IndexedFile | null;
    selectedHit: SearchHit | null;
    onClose: () => void;
    onOpenFile: (file: IndexedFile) => void;

    tabRequest?: { tab: 'preview' | 'progress'; nonce: number } | null;

    // Optional indexing drawer
    indexingOpen?: boolean;
    isIndexing?: boolean;
    indexProgress?: IndexProgressUpdate | null;
    indexingItems?: IndexingItem[];
    stageProgress?: StagedIndexProgress | null;
    onCloseIndexing?: () => void;
    
    // Queue management
    onRemoveFromQueue?: (filePath: string) => void;
    onPauseIndexing?: () => void;
    onResumeIndexing?: () => void;
}

export function RightPanel({
    selectedFile,
    selectedHit,
    onClose,
    onOpenFile,
    tabRequest,
    indexingOpen = false,
    isIndexing = false,
    indexProgress = null,
    indexingItems = [],
    stageProgress = null,
    onCloseIndexing,
    onRemoveFromQueue,
    onPauseIndexing,
    onResumeIndexing,
}: RightPanelProps) {
    const file = selectedFile;
    const hasPreview = !!(selectedFile || selectedHit);
    const hasIndexing = !!indexingOpen;
    const [activeTab, setActiveTab] = useState<'preview' | 'progress'>(hasPreview ? 'preview' : 'progress');
    const [zoom, setZoom] = useState<number | 'page-width'>('page-width');

    // Resizable panel state
    const [panelWidth, setPanelWidth] = useState(480);
    const isResizing = useRef(false);
    const startX = useRef(0);
    const startWidth = useRef(480);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        isResizing.current = true;
        startX.current = e.clientX;
        startWidth.current = panelWidth;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
    }, [panelWidth]);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing.current) return;
            const delta = startX.current - e.clientX;
            const newWidth = Math.min(Math.max(startWidth.current + delta, 320), 800);
            setPanelWidth(newWidth);
        };

        const handleMouseUp = () => {
            isResizing.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    // Reset zoom when file changes
    useEffect(() => {
        setZoom('page-width');
    }, [selectedFile?.id]);

    useEffect(() => {
        // If preview disappears but indexing is open, switch to progress.
        if (!hasPreview && hasIndexing) {
            setActiveTab('progress');
        }
        // If indexing closes but preview exists, switch to preview.
        if (!hasIndexing && hasPreview) {
            setActiveTab('preview');
        }
    }, [hasPreview, hasIndexing]);

    useEffect(() => {
        if (!tabRequest) return;
        if (tabRequest.tab === 'progress' && !hasIndexing) return;
        if (tabRequest.tab === 'preview' && !hasPreview) return;
        setActiveTab(tabRequest.tab);
    }, [tabRequest?.nonce, tabRequest?.tab, hasIndexing, hasPreview]);
    const isImage = file?.kind === 'image' || file?.extension?.match(/^(jpg|jpeg|png|gif|webp|bmp)$/i);
    const isPdf = file?.extension?.toLowerCase() === 'pdf';
    const isVideo = file?.kind === 'video' || file?.extension?.match(/^(mp4|webm|ogg|mov)$/i);

    const [imageData, setImageData] = useState<string | null>(null);
    const [imageLoading, setImageLoading] = useState(false);

    const [fullContext, setFullContext] = useState<string | null>(null);
    const [fullContextError, setFullContextError] = useState<string | null>(null);
    const [showFullContext, setShowFullContext] = useState(false);
    
    // Privacy state
    const [privacyLevel, setPrivacyLevel] = useState<PrivacyLevel>('normal');
    const [isUpdatingPrivacy, setIsUpdatingPrivacy] = useState(false);

    interface FileChunkSnapshot {
        chunk_id: string;
        file_id: string;
        ordinal: number;
        text: string;
        snippet: string;
        metadata?: Record<string, any>;
    }

    const [chunks, setChunks] = useState<FileChunkSnapshot[]>([]);
    const [chunksLoading, setChunksLoading] = useState(false);
    const [chunksError, setChunksError] = useState<string | null>(null);
    const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);

    const activeChunk: FileChunkSnapshot | null = useMemo(() => {
        if (!selectedChunkId) return null;
        return chunks.find((chunk) => chunk.chunk_id === selectedChunkId) ?? null;
    }, [chunks, selectedChunkId]);

    const lastIndexStatusRef = useRef<IndexProgressUpdate['status'] | null>(null);
    const selectedChunkIdRef = useRef(selectedChunkId);
    const activeChunkRef = useRef(activeChunk);

    useEffect(() => {
        selectedChunkIdRef.current = selectedChunkId;
        activeChunkRef.current = activeChunk;
    }, [selectedChunkId, activeChunk]);

    const fileId = file?.id ?? null;
    const activeChunkId = activeChunk?.chunk_id ?? null;

    const loadChunks = useCallback(
        async (opts?: { preserveContext?: boolean }) => {
            if (!fileId || !window.api?.listFileChunks) return;

            const preserveContext = opts?.preserveContext ?? true;
            const previousSelectedChunkId = preserveContext ? selectedChunkIdRef.current : null;
            const previousActivePage = preserveContext
                ? resolvePageNumber((activeChunkRef.current?.metadata as Record<string, any>) || {})
                : null;

            setChunksLoading(true);
            setChunksError(null);
            try {
                const response: any = await window.api.listFileChunks(fileId);
                const normalized = Array.isArray(response)
                    ? response.map((chunk: any) => ({
                        chunk_id: String(chunk.chunk_id),
                        file_id: String(chunk.file_id),
                        ordinal: Number(chunk.ordinal ?? 0),
                        text: String(chunk.text ?? ''),
                        snippet: String(chunk.snippet ?? ''),
                        metadata: (chunk.metadata ?? {}) as Record<string, any>,
                    }))
                    : [];
                normalized.sort((a, b) => a.ordinal - b.ordinal);
                setChunks(normalized);

                // Determine which chunk to select based on selectedHit, then prior selection/page.
                let preferredId: string | null = null;

                if (selectedHit) {
                    if (selectedHit.chunkId) {
                        const foundById = normalized.find((c) => c.chunk_id === selectedHit.chunkId);
                        if (foundById) preferredId = foundById.chunk_id;
                    }

                    if (!preferredId) {
                        const hitMeta = selectedHit.metadata || {};
                        const hitChunkMeta = (hitMeta.chunk_metadata as Record<string, any>) || {};
                        const targetPage =
                            hitMeta.page_number ||
                            hitMeta.page ||
                            hitChunkMeta.page_number ||
                            hitChunkMeta.page ||
                            hitMeta.page_start ||
                            hitChunkMeta.page_start;

                        if (targetPage) {
                            const matchingChunk = normalized.find((chunk) => {
                                const chunkMeta = (chunk.metadata ?? {}) as Record<string, any>;
                                const chunkPage = chunkMeta.page_number ?? chunkMeta.page;
                                const chunkPageStart = chunkMeta.page_start;
                                const chunkPageNumbers = chunkMeta.page_numbers as number[] | undefined;

                                if (chunkPage === targetPage) return true;
                                if (chunkPageStart === targetPage) return true;
                                if (Array.isArray(chunkPageNumbers) && chunkPageNumbers.includes(targetPage)) return true;
                                return false;
                            });
                            if (matchingChunk) preferredId = matchingChunk.chunk_id;
                        }
                    }
                }

                if (!preferredId && previousSelectedChunkId) {
                    const stillExists = normalized.some((c) => c.chunk_id === previousSelectedChunkId);
                    if (stillExists) preferredId = previousSelectedChunkId;
                }

                if (!preferredId && previousActivePage != null) {
                    const pageMatch = normalized.find((chunk) => {
                        const chunkMeta = (chunk.metadata ?? {}) as Record<string, any>;
                        const chunkPage = chunkMeta.page_number ?? chunkMeta.page ?? chunkMeta.page_start;
                        const chunkPageNumbers = chunkMeta.page_numbers as number[] | undefined;
                        if (chunkPage === previousActivePage) return true;
                        if (Array.isArray(chunkPageNumbers) && chunkPageNumbers.includes(previousActivePage)) return true;
                        return false;
                    });
                    if (pageMatch) preferredId = pageMatch.chunk_id;
                }

                if (!preferredId && normalized.length > 0) preferredId = normalized[0].chunk_id;
                setSelectedChunkId(preferredId);
            } catch (err: any) {
                console.error('Failed to load file chunks', err);
                setChunks([]);
                setSelectedChunkId(null);
                setChunksError(err instanceof Error ? err.message : 'Failed to load chunks');
            } finally {
                setChunksLoading(false);
            }
        },
        [
            fileId,
            selectedHit,
        ]
    );

    // Extract navigation info (page number / timestamp) from either hit metadata or active chunk metadata
    // Helper to normalise page info from various metadata shapes
    const resolvePageNumber = (meta: Record<string, any> | null | undefined): number | null => {
        if (!meta) return null;

        // Prefer explicit single-page fields
        if (meta.page_number) return meta.page_number as number;
        if (meta.page) return meta.page as number;

        // Then fall back to range / list-style fields
        if (meta.page_start) return meta.page_start as number;

        const pageNumbers = meta.page_numbers as number[] | undefined;
        if (Array.isArray(pageNumbers) && pageNumbers.length > 0) {
            return pageNumbers[0] as number;
        }

        return null;
    };

    const resolvedPageNumber = useMemo(() => {
        const hitMeta = selectedHit?.metadata || {};
        const hitChunkMeta = (hitMeta.chunk_metadata as Record<string, any>) || {};
        const chunkMeta = (activeChunk?.metadata as Record<string, any>) || {};

        return (
            resolvePageNumber(chunkMeta) ??
            resolvePageNumber(hitMeta) ??
            resolvePageNumber(hitChunkMeta) ??
            null
        );
    }, [selectedHit, activeChunk]);

    const pageNumber = resolvedPageNumber ?? 1;

    const timestamp = useMemo(() => {
        const hitMeta = selectedHit?.metadata || {};
        const hitChunkMeta = (hitMeta.chunk_metadata as Record<string, any>) || {};
        const chunkMeta = (activeChunk?.metadata as Record<string, any>) || {};
        return (
            chunkMeta.timestamp ||
            chunkMeta.start ||
            chunkMeta.start_time ||
            hitMeta.timestamp ||
            hitMeta.start ||
            hitMeta.start_time ||
            hitChunkMeta.timestamp ||
            hitChunkMeta.start ||
            hitChunkMeta.start_time ||
            0
        );
    }, [selectedHit, activeChunk]);

    const pageChunks = useMemo(() => {
        if (!isPdf) return [];
        return chunks.filter((c, index) => {
            let p = resolvePageNumber(c.metadata);
            if (p === null && index === 0) p = 1;
            // If we still don't have a page number, maybe group it with page 1 or handle it?
            // For now, let's match the grouping logic which defaults to 1 if null
            if (p === null) p = 1;
            return p === pageNumber;
        });
    }, [chunks, isPdf, pageNumber]);

    const pageText = useMemo(() => {
        if (!isPdf) return null;
        return pageChunks.map(c => c.text || c.snippet).join('\n\n');
    }, [pageChunks, isPdf]);

    const totalPages = useMemo(() => {
        if (!isPdf || chunks.length === 0) return 0;
        let max = 0;
        for (const c of chunks) {
            const p = resolvePageNumber(c.metadata);
            if (p && p > max) max = p;
        }
        return max;
    }, [chunks, isPdf]);

    const pageGroups = useMemo(() => {
        const groups = new Map<number, { page: number; firstChunkId: string; count: number; startIdx: number; endIdx: number }>();
        
        chunks.forEach((chunk, index) => {
            // If page number is missing for the first chunk of a PDF, assume it's page 1
            let page = resolvePageNumber(chunk.metadata);
            if (page === null && index === 0 && isPdf) page = 1;
            if (page === null) page = 1; // Fallback for grouping

            if (!groups.has(page)) {
                groups.set(page, { 
                    page, 
                    firstChunkId: chunk.chunk_id, 
                    count: 0,
                    startIdx: index + 1,
                    endIdx: index + 1
                });
            }
            const group = groups.get(page)!;
            group.count++;
            group.endIdx = index + 1;
        });
        
        return Array.from(groups.values()).sort((a, b) => a.page - b.page);
    }, [chunks, isPdf]);

    const handlePageChange = (delta: number) => {
        const newPage = pageNumber + delta;
        if (newPage < 1) return;
        
        const targetGroup = pageGroups.find(g => g.page === newPage);
        if (targetGroup) {
            setSelectedChunkId(targetGroup.firstChunkId);
        }
    };

    useEffect(() => {
        setChunks([]);
        setChunksError(null);
        setSelectedChunkId(null);
        setFullContext(null);
        setFullContextError(null);
        setShowFullContext(false);

        if (!fileId) return;
        void loadChunks({ preserveContext: false });
    }, [fileId, loadChunks]);

    // Load image preview
    useEffect(() => {
        if (!file || !isImage || !window.api?.readImage) {
            setImageData(null);
            return;
        }

        let active = true;
        setImageLoading(true);
        window.api.readImage(file.fullPath)
            .then((data) => {
                if (active) {
                    const ext = file.extension?.toLowerCase();
                    let mime = 'image/png';
                    if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
                    else if (ext === 'gif') mime = 'image/gif';
                    else if (ext === 'webp') mime = 'image/webp';
                    else if (ext === 'bmp') mime = 'image/bmp';
                    setImageData(`data:${mime};base64,${data}`);
                }
            })
            .catch((err) => {
                console.error('Failed to load image preview', err);
                if (active) setImageData(null);
            })
            .finally(() => {
                if (active) setImageLoading(false);
            });

        return () => {
            active = false;
        };
    }, [file, isImage]);

    useEffect(() => {
        const status = indexProgress?.status ?? null;
        const last = lastIndexStatusRef.current;
        lastIndexStatusRef.current = status;

        const finished = status === 'completed' || status === 'failed';
        const transitionedToFinished = finished && last !== status;
        if (!transitionedToFinished) return;
        if (!fileId) return;

        void loadChunks({ preserveContext: true });
    }, [indexProgress?.status, fileId, loadChunks]);

    // Keep fullContext in sync when user manually changes the selected chunk
    useEffect(() => {
        if (activeChunk) {
            setFullContext(activeChunk.text || activeChunk.snippet || null);
            setFullContextError(null);
        }
    }, [activeChunk]);
    
    // Load privacy level when file changes
    useEffect(() => {
        if (!fileId || !window.api?.getFilePrivacy) {
            setPrivacyLevel('normal');
            return;
        }
        
        window.api.getFilePrivacy(fileId)
            .then((result) => {
                setPrivacyLevel(result.privacyLevel || 'normal');
            })
            .catch((err) => {
                console.error('Failed to get file privacy:', err);
                setPrivacyLevel('normal');
            });
    }, [fileId]);
    
    // Toggle privacy level
    const handleTogglePrivacy = useCallback(async () => {
        if (!fileId || !window.api?.setFilePrivacy || isUpdatingPrivacy) return;
        
        setIsUpdatingPrivacy(true);
        const newLevel: PrivacyLevel = privacyLevel === 'normal' ? 'private' : 'normal';
        
        try {
            const result = await window.api.setFilePrivacy(fileId, newLevel);
            setPrivacyLevel(result.privacyLevel);
        } catch (err) {
            console.error('Failed to update privacy:', err);
        } finally {
            setIsUpdatingPrivacy(false);
        }
    }, [fileId, privacyLevel, isUpdatingPrivacy]);

    const handleClose = () => {
        if (activeTab === 'preview' && hasPreview) {
            onClose();
            if (hasIndexing) {
                setActiveTab('progress');
            }
            return;
        }
        if (activeTab === 'progress' && hasIndexing) {
            onCloseIndexing?.();
            if (hasPreview) {
                setActiveTab('preview');
            }
            return;
        }
        // Fallback: close both
        onCloseIndexing?.();
        onClose();
    };

    return (
        <div 
            className="relative flex h-full flex-col border-l bg-background shadow-xl z-20"
            style={{ width: panelWidth }}
        >
            {/* Resize handle */}
            <div
                onMouseDown={handleMouseDown}
                className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-30"
            />
            <div className="flex items-center justify-between gap-2 border-b p-4 bg-muted/10">
                <div className="flex items-center gap-2">
                    <button onClick={handleClose} className="rounded-full p-1.5 hover:bg-muted transition-colors">
                        <X className="h-4 w-4" />
                    </button>
                    <h3 className="font-semibold text-sm">{activeTab === 'preview' ? 'Context Preview' : 'Index Progress'}</h3>
                </div>
                {(hasPreview && hasIndexing) ? (
                    <div className="inline-flex overflow-hidden rounded-md border bg-background">
                        <button
                            type="button"
                            onClick={() => setActiveTab('preview')}
                            className={activeTab === 'preview'
                                ? 'px-2.5 py-1.5 text-[11px] font-medium bg-secondary text-secondary-foreground'
                                : 'px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}
                            title="Context preview"
                        >
                            <span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />Preview</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveTab('progress')}
                            className={activeTab === 'progress'
                                ? 'px-2.5 py-1.5 text-[11px] font-medium bg-secondary text-secondary-foreground'
                                : 'px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}
                            title="Index progress"
                        >
                            <span className="inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5" />Progress</span>
                        </button>
                    </div>
                ) : null}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6">
                {activeTab === 'progress' && hasIndexing ? (
                    <IndexProgressPanel
                        isIndexing={isIndexing}
                        progress={indexProgress}
                        indexingItems={indexingItems}
                        stageProgress={stageProgress}
                        onRemoveItem={onRemoveFromQueue}
                        onPauseIndexing={onPauseIndexing}
                        onResumeIndexing={onResumeIndexing}
                    />
                ) : null}

                {activeTab === 'preview' && hasPreview && file ? (
                    <>
                        <div className="rounded-lg border bg-card p-4 shadow-sm">
                            <div className="flex items-start gap-3">
                                <div className="rounded-lg bg-primary/10 p-2.5">
                                    <FileText className="h-5 w-5 text-primary" />
                                </div>
                                <div className="flex-1 overflow-hidden">
                                    <h4 className="truncate font-medium text-sm">{file.name}</h4>
                                    <p className="truncate text-xs text-muted-foreground mt-0.5" title={file.fullPath}>{file.fullPath}</p>
                                </div>
                            </div>
                            <div className="mt-4 flex gap-2">
                                <button
                                    onClick={() => onOpenFile(file)}
                                    className="flex flex-1 items-center justify-center gap-2 rounded-md border bg-background px-3 py-2 text-xs font-medium hover:bg-accent transition-colors"
                                >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                    Open in Default App
                                </button>
                            </div>
                            
                            {/* Privacy Toggle */}
                            <div className="mt-4 pt-4 border-t">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        {privacyLevel === 'private' ? (
                                            <Shield className="h-4 w-4 text-amber-500" />
                                        ) : (
                                            <ShieldOff className="h-4 w-4 text-muted-foreground" />
                                        )}
                                        <div>
                                            <p className="text-xs font-medium">
                                                {privacyLevel === 'private' ? 'Private' : 'Normal'}
                                            </p>
                                            <p className="text-[10px] text-muted-foreground">
                                                {privacyLevel === 'private' 
                                                    ? 'Hidden from external access'
                                                    : 'Accessible by external agents'
                                                }
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={handleTogglePrivacy}
                                        disabled={isUpdatingPrivacy}
                                        className={`relative h-6 w-11 rounded-full transition-colors duration-200 ${
                                            privacyLevel === 'private'
                                                ? 'bg-amber-500'
                                                : 'bg-muted'
                                        } ${isUpdatingPrivacy ? 'opacity-50 cursor-not-allowed' : ''}`}
                                        title={privacyLevel === 'private' ? 'Make Normal' : 'Make Private'}
                                    >
                                        <span
                                            className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                                                privacyLevel === 'private' ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                        />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {file.summary && (
                            <div className="space-y-2">
                                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Summary</h4>
                                <details className="group rounded-lg border bg-muted/30 text-sm leading-relaxed">
                                    <summary className="cursor-pointer p-3 font-medium text-muted-foreground hover:text-foreground select-none list-none flex items-center justify-between">
                                        <span>Show Summary</span>
                                        <span className="group-open:rotate-180 transition-transform">▼</span>
                                    </summary>
                                    <div className="px-3 pb-3 pt-0 border-t border-transparent group-open:border-border/50 max-h-[300px] overflow-y-auto">
                                        <p className="whitespace-pre-wrap text-foreground/90">{file.summary}</p>
                                    </div>
                                </details>
                            </div>
                        )}

                        {isPdf && (
                            <div className="space-y-2 flex-1 flex flex-col min-h-[400px] relative">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">PDF Preview</h4>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => handlePageChange(-1)}
                                            className="p-1 hover:bg-muted rounded disabled:opacity-50"
                                            disabled={pageNumber <= 1}
                                            title="Previous Page"
                                        >
                                            <ChevronLeft className="h-3 w-3" />
                                        </button>
                                        <span className="text-[10px] bg-muted px-2 py-0.5 rounded min-w-[3rem] text-center">
                                            Page {pageNumber}
                                        </span>
                                        <button
                                            onClick={() => handlePageChange(1)}
                                            className="p-1 hover:bg-muted rounded"
                                            title="Next Page"
                                        >
                                            <ChevronRight className="h-3 w-3" />
                                        </button>
                                    </div>
                                </div>
                                <iframe
                                    key={`${file.fullPath}-page-${pageNumber}-zoom-${zoom}`}
                                    src={`file://${file.fullPath}#page=${pageNumber}&zoom=${zoom}&toolbar=0&navpanes=0`}
                                    className="w-full flex-1 rounded border bg-white"
                                    title="PDF Preview"
                                />
                                <div className="absolute bottom-6 right-6 flex flex-col gap-2 bg-background/90 backdrop-blur border rounded-lg shadow-lg p-1.5">
                                    <button
                                        onClick={() => setZoom(z => {
                                            const current = typeof z === 'number' ? z : 100;
                                            return Math.min(current + 25, 1000);
                                        })}
                                        className="p-1.5 hover:bg-muted rounded-md transition-colors"
                                        title="Zoom In"
                                    >
                                        <ZoomIn className="h-4 w-4" />
                                    </button>
                                    <button
                                        onClick={() => setZoom(z => {
                                            const current = typeof z === 'number' ? z : 100;
                                            return Math.max(current - 25, 10);
                                        })}
                                        className="p-1.5 hover:bg-muted rounded-md transition-colors"
                                        title="Zoom Out"
                                    >
                                        <ZoomOut className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        )}

                        {isVideo && (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Video Preview</h4>
                                    <span className="text-[10px] bg-muted px-2 py-0.5 rounded">Time: {String(timestamp)}s</span>
                                </div>
                                <video
                                    key={`${file.fullPath}-time-${timestamp}`}
                                    src={`file://${file.fullPath}#t=${timestamp}`}
                                    controls
                                    className="w-full rounded border bg-black"
                                />
                            </div>
                        )}

                        {isImage && (
                            <div className="space-y-2">
                                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Image Preview</h4>
                                <div className="rounded-lg border bg-muted/20 p-2 flex items-center justify-center min-h-[200px]">
                                    {imageLoading ? (
                                        <div className="text-xs text-muted-foreground">Loading preview...</div>
                                    ) : imageData ? (
                                        <img
                                            src={imageData}
                                            alt={file.name}
                                            className="max-w-full max-h-[400px] object-contain rounded shadow-sm"
                                        />
                                    ) : (
                                        <p className="text-xs text-muted-foreground">Preview unavailable</p>
                                    )}
                                </div>
                            </div>
                        )}

                        {(selectedHit || activeChunk) && (selectedHit?.snippet || activeChunk?.snippet || fullContext || activeChunk?.text || pageText) && (
                            <div className="space-y-2">
                                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    {isPdf ? `Page ${pageNumber} Content` : 'Relevant Content'}
                                </h4>
                                {chunksLoading && (
                                    <p className="text-[11px] text-muted-foreground">Loading chunks…</p>
                                )}
                                {!!chunksError && (
                                    <p className="text-[11px] text-destructive">{chunksError}</p>
                                )}
                                {chunks.length > 0 && (
                                    <div className="flex items-center justify-between gap-2 text-[11px] mb-1">
                                        <span className="text-muted-foreground">{isPdf ? 'Page' : 'Chunk'}</span>
                                        <select
                                            className="flex-1 rounded border bg-background px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-primary/40"
                                            value={isPdf ? pageNumber : (selectedChunkId ?? '')}
                                            onChange={(event) => {
                                                if (isPdf) {
                                                    const page = Number(event.target.value);
                                                    const group = pageGroups.find(g => g.page === page);
                                                    if (group) setSelectedChunkId(group.firstChunkId);
                                                } else {
                                                    setSelectedChunkId(event.target.value || null);
                                                }
                                            }}
                                        >
                                            {isPdf ? (
                                                pageGroups.map((group) => (
                                                    <option key={group.page} value={group.page}>
                                                        Page {group.page} (Chunks {group.startIdx}-{group.endIdx})
                                                    </option>
                                                ))
                                            ) : (
                                                chunks.map((chunk, index) => {
                                                    const meta = (chunk.metadata || {}) as Record<string, any>;
                                                    const resolvedPage = resolvePageNumber(meta);
                                                    const labelParts = [`Chunk ${index + 1}`];
                                                    if (resolvedPage != null) {
                                                        labelParts.push(`Page ${resolvedPage}`);
                                                    }
                                                    return (
                                                        <option key={chunk.chunk_id} value={chunk.chunk_id}>
                                                            {labelParts.join(' — ')}
                                                        </option>
                                                    );
                                                })
                                            )}
                                        </select>
                                    </div>
                                )}
                                <div className="rounded-lg border border-l-4 border-l-yellow-500/50 bg-yellow-500/5 p-4 text-sm leading-relaxed max-h-[400px] overflow-y-auto">
                                    <div className="flex flex-col gap-3">
                                        {fullContextError && (
                                            <p className="text-[11px] text-destructive">
                                                {fullContextError}
                                            </p>
                                        )}
                                        {isPdf && pageChunks.length > 0 ? (
                                            pageChunks.map((chunk, idx) => (
                                                <div key={chunk.chunk_id} className="relative">
                                                    {idx > 0 && (
                                                        <div className="absolute -top-1.5 left-0 right-0 border-t border-dashed border-muted-foreground/30" />
                                                    )}
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                                            Chunk {chunk.ordinal + 1}
                                                        </span>
                                                    </div>
                                                    <p className="whitespace-pre-wrap font-serif text-foreground/90 text-sm">
                                                        {chunk.text || chunk.snippet}
                                                    </p>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="whitespace-pre-wrap font-serif text-foreground/90 text-sm">
                                                {showFullContext && fullContext
                                                    ? fullContext
                                                    : activeChunk?.snippet ?? activeChunk?.text ?? selectedHit?.snippet ?? fullContext}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center justify-between">
                                    {!isPdf && fullContext && (
                                        <button
                                            type="button"
                                            className="text-[10px] text-primary hover:underline"
                                            onClick={() => setShowFullContext((prev) => !prev)}
                                        >
                                            {showFullContext ? 'Show snippet only' : 'Show full context'}
                                        </button>
                                    )}
                                    {selectedHit?.score && (
                                        <div className="flex-1 flex items-center justify-end">
                                            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                                                Relevance: {selectedHit.score.toFixed(3)}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        <div className="space-y-2 pt-4 border-t">
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Metadata</h4>
                            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-xs">
                                <div className="text-muted-foreground">Size</div>
                                <div className="font-mono">{(file.size / 1024).toFixed(1)} KB</div>
                                <div className="text-muted-foreground">Type</div>
                                <div className="uppercase">{file.extension}</div>
                                <div className="text-muted-foreground">Modified</div>
                                <div>{new Date(file.modifiedAt).toLocaleDateString()}</div>
                                <div className="text-muted-foreground">Folder</div>
                                <div className="truncate" title={file.path}>{file.path.split('/').pop()}</div>
                                <div className="text-muted-foreground">Chunks</div>
                                <div className="font-mono">{chunks.length}</div>
                                {isPdf && totalPages > 0 && (
                                    <>
                                        <div className="text-muted-foreground">Pages</div>
                                        <div className="font-mono">{totalPages}</div>
                                    </>
                                )}
                            </div>
                        </div>
                    </>
                ) : null}
            </div>
        </div>
    );
}
