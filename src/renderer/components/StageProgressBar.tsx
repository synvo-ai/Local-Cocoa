/**
 * StageProgressBar - Three-Stage Progress Indicator
 */

import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
    CheckCircle,
    Circle,
    Play,
    Pause,
    X,
    AlertCircle,
    FolderOpen,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { StagedIndexProgress } from '../../electron/backendClient';

interface ErrorFile {
    id: string;
    name: string;
    path: string;
    error_reason: string | null;
    error_at: string | null;
}

interface StageProgressBarProps {
    progress: StagedIndexProgress | null;
    onStartSemantic?: () => Promise<void>;
    onStopSemantic?: () => Promise<void>;
    onStartDeep?: () => Promise<void>;
    onStopDeep?: () => Promise<void>;
    className?: string;
}

function clampPercent(value: number | null | undefined): number {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
}

interface StageProps {
    label: string;
    percent: number;
    count: number;
    total: number;
    isComplete: boolean;
    color: 'emerald' | 'blue' | 'violet';
    showControl?: boolean;
    isRunning?: boolean;
    isLoading?: boolean;
    onToggle?: () => void;
}

function Stage({ 
    label, 
    percent, 
    count, 
    total, 
    isComplete, 
    color,
    showControl,
    isRunning,
    isLoading,
    onToggle,
}: StageProps) {
    const colors = {
        emerald: {
            icon: isComplete ? 'text-emerald-500' : 'text-emerald-400/50',
            text: isComplete ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground',
            bar: 'bg-emerald-500',
            barBg: 'bg-emerald-500/20',
            btn: 'bg-emerald-500 hover:bg-emerald-600',
            btnHover: 'hover:bg-emerald-50 hover:text-emerald-600',
        },
        blue: {
            icon: isComplete ? 'text-blue-500' : 'text-blue-400/50',
            text: isComplete ? 'text-blue-600 dark:text-blue-400' : 'text-foreground',
            bar: 'bg-blue-500',
            barBg: 'bg-blue-500/20',
            btn: 'bg-blue-500 hover:bg-blue-600',
            btnHover: 'hover:bg-blue-50 hover:text-blue-600',
        },
        violet: {
            icon: isComplete ? 'text-violet-500' : 'text-violet-400/50',
            text: isComplete ? 'text-violet-600 dark:text-violet-400' : 'text-foreground',
            bar: 'bg-violet-500',
            barBg: 'bg-violet-500/20',
            btn: 'bg-violet-500 hover:bg-violet-600',
            btnHover: 'hover:bg-violet-50 hover:text-violet-600',
        },
    }[color];

    return (
        <div className="flex-1 min-w-0">
            {/* Header row */}
            <div className="flex items-center gap-2 mb-2">
                {isComplete ? (
                    <CheckCircle className={cn("w-4 h-4 shrink-0", colors.icon)} />
                ) : (
                    <Circle className={cn("w-4 h-4 shrink-0", colors.icon)} />
                )}
                
                <span className={cn("text-sm font-medium", colors.text)}>
                    {label}
                </span>
                
                {showControl && onToggle && (
                    <button
                        onClick={onToggle}
                        disabled={isLoading}
                        className={cn(
                            "w-5 h-5 rounded-full flex items-center justify-center transition-all shrink-0",
                            isRunning
                                ? cn(colors.btn, "text-white")
                                : cn("bg-muted text-muted-foreground", colors.btnHover)
                        )}
                    >
                        {isRunning ? (
                            <Pause className="w-2.5 h-2.5" />
                        ) : (
                            <Play className="w-2.5 h-2.5 ml-0.5" />
                        )}
                    </button>
                )}
                
                <div className="flex items-baseline gap-1.5 ml-auto shrink-0">
                    <span className={cn("text-sm font-semibold tabular-nums", colors.text)}>
                        {percent}%
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                        ({count}/{total})
                    </span>
                </div>
            </div>
            
            {/* Progress bar */}
            <div className={cn("h-1.5 rounded-full overflow-hidden", colors.barBg)}>
                <div 
                    className={cn("h-full rounded-full transition-all duration-500 ease-out", colors.bar)}
                    style={{ width: `${percent}%` }}
                />
            </div>
        </div>
    );
}

export function StageProgressBar({ 
    progress, 
    onStartSemantic,
    onStopSemantic,
    onStartDeep, 
    onStopDeep,
    className 
}: StageProgressBarProps) {
    const [semanticLoading, setSemanticLoading] = useState(false);
    const [deepLoading, setDeepLoading] = useState(false);
    const [showErrorModal, setShowErrorModal] = useState(false);
    const [errorFiles, setErrorFiles] = useState<ErrorFile[]>([]);
    const [loadingErrors, setLoadingErrors] = useState(false);
    
    const handleFailedClick = useCallback(async () => {
        setShowErrorModal(true);
        setLoadingErrors(true);
        try {
            const api = window.api;
            if (api?.getErrorFiles) {
                const files = await api.getErrorFiles();
                setErrorFiles(files);
            }
        } catch (error) {
            console.error('Failed to load error files:', error);
        } finally {
            setLoadingErrors(false);
        }
    }, []);
    
    const handleShowInFolder = useCallback(async (filePath: string) => {
        try {
            const api = window.api;
            if (api?.showInFolder) {
                await api.showInFolder(filePath);
            }
        } catch (error) {
            console.error('Failed to show file in folder:', error);
        }
    }, []);
    
    const handleToggleSemantic = useCallback(async () => {
        if (!progress) return;
        setSemanticLoading(true);
        try {
            if (progress.semantic_enabled) {
                await onStopSemantic?.();
            } else {
                await onStartSemantic?.();
            }
        } finally {
            setSemanticLoading(false);
        }
    }, [progress, onStartSemantic, onStopSemantic]);
    
    const handleToggleDeep = useCallback(async () => {
        if (!progress) return;
        setDeepLoading(true);
        try {
            if (progress.deep_enabled) {
                await onStopDeep?.();
            } else {
                await onStartDeep?.();
            }
        } finally {
            setDeepLoading(false);
        }
    }, [progress, onStartDeep, onStopDeep]);
    
    if (!progress) {
        return null;
    }
    
    const textPercent = clampPercent(progress.fast_text.percent);
    const embedPercent = clampPercent(progress.fast_embed.percent);
    const deepPercent = clampPercent(progress.deep.percent);
    
    const textComplete = textPercent >= 100;
    const embedComplete = embedPercent >= 100;
    const deepComplete = deepPercent >= 100;
    
    const totalErrors = progress.fast_text.error + progress.fast_embed.error + progress.deep.error;
    const skipped = progress.deep.skipped ?? 0;
    
    const showSemanticControl = textComplete && !embedComplete && (onStartSemantic || onStopSemantic);
    const showDeepControl = embedComplete && !deepComplete && (onStartDeep || onStopDeep);
    
    return (
        <div className={cn("rounded-xl border bg-card/80 backdrop-blur-sm p-4", className)}>
            {/* Three stages */}
            <div className="flex items-start gap-6">
                <Stage
                    label="Keyword"
                    percent={textPercent}
                    count={progress.fast_text.done}
                    total={progress.total}
                    isComplete={textComplete}
                    color="emerald"
                />
                
                <Stage
                    label="Semantic"
                    percent={embedPercent}
                    count={progress.fast_embed.done}
                    total={progress.total}
                    isComplete={embedComplete}
                    color="blue"
                    showControl={showSemanticControl}
                    isRunning={progress.semantic_enabled}
                    isLoading={semanticLoading}
                    onToggle={handleToggleSemantic}
                />
                
                <Stage
                    label="Vision"
                    percent={deepPercent}
                    count={progress.deep.done}
                    total={progress.total}
                    isComplete={deepComplete}
                    color="violet"
                    showControl={showDeepControl}
                    isRunning={progress.deep_enabled}
                    isLoading={deepLoading}
                    onToggle={handleToggleDeep}
                />
            </div>
            
            {/* Footer */}
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50 text-xs text-muted-foreground">
                <span>{progress.total} files total</span>
                {(skipped > 0 || totalErrors > 0) && (
                    <div className="flex items-center gap-4">
                        {skipped > 0 && (
                            <span className="text-amber-500">{skipped} skipped</span>
                        )}
                        {totalErrors > 0 && (
                            <button 
                                onClick={handleFailedClick}
                                className="text-red-500 hover:text-red-600 hover:underline cursor-pointer transition-colors"
                            >
                                {totalErrors} failed
                            </button>
                        )}
                    </div>
                )}
            </div>
            
            {/* Error Files Drawer - Portal to body for proper positioning */}
            {showErrorModal && createPortal(
                <div 
                    className="fixed inset-0 z-50"
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                >
                    {/* Backdrop */}
                    <div 
                        className="absolute inset-0 bg-black/30" 
                        onClick={() => setShowErrorModal(false)}
                    />
                    
                    {/* Right Panel - matching RightPanel.tsx style */}
                    <div 
                        className="absolute inset-y-0 right-0 w-[480px] max-w-[90vw] flex flex-col border-l bg-background shadow-xl"
                    >
                        {/* Header - matching RightPanel style */}
                        <div className="flex items-center justify-between gap-2 border-b p-4 bg-muted/10 shrink-0">
                            <div className="flex items-center gap-2">
                                <button 
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setShowErrorModal(false);
                                    }} 
                                    className="h-8 w-8 rounded-full flex items-center justify-center hover:bg-muted transition-colors"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                                <h3 className="font-semibold text-sm">Failed Files</h3>
                            </div>
                            <span className="text-xs text-muted-foreground">
                                {errorFiles.length} file{errorFiles.length !== 1 ? 's' : ''}
                            </span>
                        </div>
                        
                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            {loadingErrors ? (
                                <div className="flex flex-col items-center justify-center py-12 gap-3">
                                    <div className="animate-spin h-6 w-6 border-2 border-primary/20 border-t-primary rounded-full" />
                                    <p className="text-xs text-muted-foreground">Loading...</p>
                                </div>
                            ) : errorFiles.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-12 gap-3">
                                    <div className="rounded-lg bg-emerald-500/10 p-2.5">
                                        <CheckCircle className="h-5 w-5 text-emerald-500" />
                                    </div>
                                    <p className="text-sm text-muted-foreground">No failed files</p>
                                </div>
                            ) : (
                                <>
                                    {/* Tip */}
                                    <div className="rounded-lg border bg-muted/30 p-3">
                                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                                            <span className="font-medium text-foreground">Tip:</span> Click any file to reveal it in Finder. Common causes include encrypted PDFs, corrupted files, or wrong file extensions.
                                        </p>
                                    </div>
                                    
                                    {/* File list */}
                                    <div className="space-y-2">
                                        {errorFiles.map((file) => (
                                            <div 
                                                key={file.id}
                                                onClick={() => handleShowInFolder(file.path)}
                                                className="rounded-lg border bg-card p-4 shadow-sm hover:bg-accent/50 transition-colors cursor-pointer group"
                                            >
                                                <div className="flex items-start gap-3">
                                                    <div className="rounded-lg bg-red-500/10 p-2 group-hover:bg-primary/10 transition-colors">
                                                        <AlertCircle className="h-4 w-4 text-red-500 group-hover:hidden" />
                                                        <FolderOpen className="h-4 w-4 text-primary hidden group-hover:block" />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <h4 className="text-sm font-medium truncate" title={file.name}>
                                                            {file.name}
                                                        </h4>
                                                        <p className="text-[11px] text-muted-foreground truncate mt-0.5 font-mono" title={file.path}>
                                                            {file.path}
                                                        </p>
                                                        {file.error_reason && (
                                                            <div className="mt-2 text-xs text-red-600 dark:text-red-400 leading-relaxed">
                                                                {file.error_reason}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
