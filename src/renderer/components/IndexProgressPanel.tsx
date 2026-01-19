import { useState, useMemo } from 'react';
import { Activity, FileText, Image as ImageIcon, Video, Music, X, Pause, Play, ChevronDown, ChevronUp, Search, Brain, Eye, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import type { IndexProgressUpdate, IndexingItem } from '../types';
import type { StagedIndexProgress } from '../../electron/backendClient';

function basename(pathValue: string): string {
    const parts = (pathValue ?? '').split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? pathValue;
}

function kindIcon(kind?: string | null) {
    switch ((kind ?? '').toLowerCase()) {
        case 'video':
            return <Video className="h-4 w-4 text-primary" />;
        case 'audio':
            return <Music className="h-4 w-4 text-primary" />;
        case 'image':
            return <ImageIcon className="h-4 w-4 text-primary" />;
        case 'document':
        default:
            return <FileText className="h-4 w-4 text-primary" />;
    }
}

function clampPercent(value: number | null | undefined): number {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
}

function extractPageLabel(text?: string | null): string | null {
    if (!text) return null;
    const match = text.match(/page\s+(\d+)/i);
    return match ? match[1] : null;
}

// Stage badge component
function StageBadge({ 
    stage, 
    isActive 
}: { 
    stage: 'keyword' | 'semantic' | 'vision';
    isActive: boolean;
}) {
    const config = {
        keyword: { 
            icon: Search, 
            label: 'Keyword', 
            color: 'text-emerald-500', 
            bg: 'bg-emerald-500/10', 
            border: 'border-emerald-500/30' 
        },
        semantic: { 
            icon: Brain, 
            label: 'Semantic', 
            color: 'text-blue-500', 
            bg: 'bg-blue-500/10', 
            border: 'border-blue-500/30' 
        },
        vision: { 
            icon: Eye, 
            label: 'Vision', 
            color: 'text-purple-500', 
            bg: 'bg-purple-500/10', 
            border: 'border-purple-500/30' 
        },
    }[stage];

    const Icon = config.icon;

    return (
        <div className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium",
            config.bg,
            config.border,
            config.color,
            isActive && "animate-pulse"
        )}>
            {isActive ? (
                <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
                <Icon className="h-3 w-3" />
            )}
            <span>{config.label}</span>
        </div>
    );
}

export function IndexProgressPanel({
    isIndexing,
    progress,
    indexingItems,
    stageProgress,
    onRemoveItem,
    onPauseIndexing,
    onResumeIndexing,
}: {
    isIndexing: boolean;
    progress: IndexProgressUpdate | null;
    indexingItems: IndexingItem[];
    stageProgress?: StagedIndexProgress | null;
    onRemoveItem?: (filePath: string) => void;
    onPauseIndexing?: () => void;
    onResumeIndexing?: () => void;
}) {
    const [isPreviewExpanded, setIsPreviewExpanded] = useState(false);
    const processing = indexingItems.find((item) => item.status === 'processing') ?? null;
    const pendingCount = indexingItems.filter((item) => item.status === 'pending').length;
    const queueItems = indexingItems.slice(0, 50);

    // Determine current active stage from stageProgress
    const activeStage = useMemo(() => {
        if (!stageProgress || stageProgress.total === 0) return null;
        
        const textPercent = clampPercent(stageProgress.fast_text.percent);
        const embedPercent = clampPercent(stageProgress.fast_embed.percent);
        const deepPercent = clampPercent(stageProgress.deep.percent);
        
        // Check which stage is actively running
        if (textPercent < 100) return 'keyword';
        if (stageProgress.semantic_enabled && embedPercent < 100) return 'semantic';
        if (stageProgress.deep_enabled && deepPercent < 100) return 'vision';
        return null;
    }, [stageProgress]);

    // Get stage-specific progress info
    const stageInfo = useMemo(() => {
        if (!stageProgress || !activeStage) return null;
        
        const stages = {
            keyword: {
                done: stageProgress.fast_text.done,
                total: stageProgress.total,
                percent: clampPercent(stageProgress.fast_text.percent),
            },
            semantic: {
                done: stageProgress.fast_embed.done,
                total: stageProgress.total,
                percent: clampPercent(stageProgress.fast_embed.percent),
            },
            vision: {
                done: stageProgress.deep.done,
                total: stageProgress.total,
                percent: clampPercent(stageProgress.deep.percent),
            },
        };
        return stages[activeStage];
    }, [stageProgress, activeStage]);

    const headerMessage =
        progress?.status === 'running'
            ? (progress?.message ?? 'Indexing…')
            : progress?.status === 'failed'
                ? (progress?.lastError ?? 'Indexing failed')
                : progress?.status === 'completed'
                    ? 'Indexing completed'
                    : 'Idle';

    const processed = progress?.processed ?? 0;
    const total = progress?.total ?? null;
    const failed = progress?.failed ?? 0;

    const previewEvents = processing?.recentEvents ?? [];
    const latestPreviewEvent = previewEvents.length ? previewEvents[previewEvents.length - 1] : null;
    const previewMessage = latestPreviewEvent?.message ?? processing?.detail ?? '';
    const previewPage = latestPreviewEvent?.page ?? extractPageLabel(previewMessage);
    const streamEvents = previewEvents.slice(-4).reverse();

    return (
        <div className="space-y-4">
            <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm space-y-4">
                {/* Header with stage indicator */}
                <div className="flex flex-wrap items-center justify-between gap-3 overflow-hidden">
                    <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
                        <div className={cn(
                            "h-10 w-10 rounded flex items-center justify-center shrink-0",
                            activeStage ? "bg-primary/10" : "bg-muted"
                        )}>
                            {activeStage ? (
                                <Loader2 className="h-5 w-5 text-primary animate-spin" />
                            ) : (
                                <Activity className="h-5 w-5 text-muted-foreground" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1 overflow-hidden">
                            <div className="flex items-center gap-2">
                                <p className="text-base font-semibold">Index Progress</p>
                                {activeStage && (
                                    <StageBadge stage={activeStage} isActive={true} />
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate" title={headerMessage}>{headerMessage}</p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="rounded-full border bg-muted px-2.5 py-0.5">
                            {processed}{total ? ` / ${total}` : ''} processed
                        </span>
                        <span>{pendingCount ? `${pendingCount} queued` : isIndexing ? 'Working…' : 'Idle'}</span>
                        {failed ? (
                            <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-0.5 text-destructive">
                                {failed} failed
                            </span>
                        ) : null}
                        
                        {/* Pause/Resume Button */}
                        {isIndexing && progress?.status === 'running' && onPauseIndexing && (
                            <button
                                onClick={onPauseIndexing}
                                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-amber-600 hover:bg-amber-500/20 transition-colors"
                                title="Pause indexing"
                            >
                                <Pause className="h-3 w-3" />
                                Pause
                            </button>
                        )}
                        {progress?.status === 'paused' && onResumeIndexing && (
                            <button
                                onClick={onResumeIndexing}
                                className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-primary hover:bg-primary/20 transition-colors"
                                title="Resume indexing"
                            >
                                <Play className="h-3 w-3" />
                                Resume
                            </button>
                        )}
                    </div>
                </div>

                {/* Stage-level progress bar (when no file-level processing shown) */}
                {!processing && activeStage && stageInfo && (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                            <span className={cn(
                                "font-medium",
                                activeStage === 'keyword' && "text-emerald-600",
                                activeStage === 'semantic' && "text-blue-600",
                                activeStage === 'vision' && "text-purple-600"
                            )}>
                                {activeStage === 'keyword' && "Extracting text for keyword search..."}
                                {activeStage === 'semantic' && "Generating embeddings for semantic search..."}
                                {activeStage === 'vision' && "Analyzing with vision model..."}
                            </span>
                            <span className="text-muted-foreground tabular-nums">
                                {stageInfo.done}/{stageInfo.total} files
                            </span>
                        </div>
                        <div className={cn(
                            "h-2 w-full rounded-full overflow-hidden",
                            activeStage === 'keyword' && "bg-emerald-500/10",
                            activeStage === 'semantic' && "bg-blue-500/10",
                            activeStage === 'vision' && "bg-purple-500/10"
                        )}>
                            <div
                                className={cn(
                                    "h-full rounded-full transition-all duration-300",
                                    activeStage === 'keyword' && "bg-emerald-500",
                                    activeStage === 'semantic' && "bg-blue-500",
                                    activeStage === 'vision' && "bg-purple-500"
                                )}
                                style={{ 
                                    width: `${stageInfo.percent}%`,
                                    animation: stageInfo.percent < 100 ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : 'none'
                                }}
                            />
                        </div>
                        {/* Activity indicator */}
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="relative flex h-2 w-2">
                                <span className={cn(
                                    "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                                    activeStage === 'keyword' && "bg-emerald-400",
                                    activeStage === 'semantic' && "bg-blue-400",
                                    activeStage === 'vision' && "bg-purple-400"
                                )} />
                                <span className={cn(
                                    "relative inline-flex rounded-full h-2 w-2",
                                    activeStage === 'keyword' && "bg-emerald-500",
                                    activeStage === 'semantic' && "bg-blue-500",
                                    activeStage === 'vision' && "bg-purple-500"
                                )} />
                            </span>
                            <span>Processing files...</span>
                        </div>
                    </div>
                )}

                {processing ? (
                    <div className="space-y-3">
                        <div className="flex flex-col gap-3">
                            <div className="flex items-start gap-3">
                                <div className="h-9 w-9 rounded bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                                    {kindIcon(processing.kind)}
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-foreground truncate">{basename(processing.filePath)}</p>
                                    <p
                                        className="text-[11px] text-muted-foreground font-mono truncate opacity-80"
                                        title={processing.filePath}
                                    >
                                        {processing.filePath}
                                    </p>
                                    <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1 flex-wrap">
                                        {processing.stage ? (
                                            <span className="uppercase tracking-wider text-[10px] font-semibold text-primary/80">
                                                {processing.stage.replace(/_/g, ' ')}
                                            </span>
                                        ) : null}
                                        {processing.detail ? <span className="text-foreground/80">— {processing.detail}</span> : null}
                                        {typeof processing.stepCurrent === 'number' && typeof processing.stepTotal === 'number' ? (
                                            <span className="text-muted-foreground">— {processing.stepCurrent}/{processing.stepTotal}</span>
                                        ) : null}
                                    </p>
                                </div>
                                <div className="text-xs text-muted-foreground shrink-0">
                                    <span className="rounded-full border bg-muted px-2.5 py-0.5">
                                        {clampPercent(processing.progress)}%
                                    </span>
                                </div>
                            </div>

                            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                <div
                                    className={cn('h-full bg-primary transition-[width]')}
                                    style={{ width: `${clampPercent(processing.progress)}%` }}
                                />
                            </div>
                        </div>

                        {(previewMessage || streamEvents.length) ? (
                            <div className="grid gap-3">
                                {previewMessage ? (
                                    <div className="rounded-md border bg-background/80 p-3 min-w-0 overflow-hidden">
                                        <div className="flex items-center justify-between text-[11px] text-muted-foreground uppercase tracking-wider">
                                            <span>Now Processing</span>
                                            {previewPage ? <span className="text-primary">Page {previewPage}</span> : null}
                                        </div>
                                        <p
                                            className={cn(
                                                "mt-2 text-sm text-foreground leading-snug break-all",
                                                !isPreviewExpanded && "line-clamp-3"
                                            )}
                                            title={isPreviewExpanded ? undefined : previewMessage}
                                        >
                                            {previewMessage}
                                        </p>
                                        {previewMessage.length > 150 && (
                                            <button
                                                onClick={() => setIsPreviewExpanded(!isPreviewExpanded)}
                                                className="mt-2 flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 transition-colors"
                                            >
                                                {isPreviewExpanded ? (
                                                    <>
                                                        <ChevronUp className="h-3 w-3" />
                                                        <span>Collapse</span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <ChevronDown className="h-3 w-3" />
                                                        <span>View All</span>
                                                    </>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                ) : null}

                                {streamEvents.length ? (
                                    <div className="rounded-md border bg-muted/20 p-3 min-w-0 overflow-hidden">
                                        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Stream</p>
                                        <div className="mt-2 space-y-1.5">
                                            {streamEvents.map((evt, idx) => (
                                                <div key={`${evt.ts}-${idx}`} className="flex items-start gap-2 min-w-0">
                                                    <span className="text-primary">—</span>
                                                    <div className="flex-1 min-w-0">
                                                        <p
                                                            className="text-xs text-foreground/90 leading-snug line-clamp-2 break-all"
                                                            title={evt.message}
                                                        >
                                                            {evt.message}
                                                        </p>
                                                        <p className="text-[10px] text-muted-foreground">
                                                            {(evt.ts ?? '').split('T')[1]?.replace('Z', '')?.slice(0, 8) ?? ''}
                                                        </p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>

            <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
                <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">Queue</p>
                    <p className="text-xs text-muted-foreground">{indexingItems.length} item(s)</p>
                </div>

                <div className="mt-3 divide-y">
                    {queueItems.length ? (
                        queueItems.map((item, idx) => (
                            <div key={`${item.filePath}-${idx}`} className="py-2 flex items-center justify-between gap-3 text-xs">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center shrink-0">
                                        {kindIcon(item.kind)}
                                    </div>
                                    <div className="min-w-0">
                                        <p className="font-medium truncate text-sm">{basename(item.filePath)}</p>
                                        <p className="text-[11px] text-muted-foreground truncate font-mono">{item.folderPath}</p>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                    <span className={cn(
                                        'rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
                                        item.status === 'processing'
                                            ? 'border-primary/30 bg-primary/10 text-primary'
                                            : 'bg-muted text-muted-foreground'
                                    )}>
                                        {item.status}
                                    </span>
                                    {item.status === 'processing' ? (
                                        <span className="rounded-full border bg-muted px-2.5 py-0.5 text-[10px] text-muted-foreground">
                                            {clampPercent(item.progress)}%
                                        </span>
                                    ) : null}
                                    
                                    {/* Remove from queue button - only for pending items */}
                                    {item.status === 'pending' && onRemoveItem && (
                                        <button
                                            onClick={() => onRemoveItem(item.filePath)}
                                            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                                            title="Remove from queue"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="py-8 text-center text-sm text-muted-foreground">
                            No indexing activity.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
