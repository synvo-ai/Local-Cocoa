/**
 * StageProgressBar - Three-Stage Progress Indicator
 */

import { useState, useCallback } from 'react';
import { 
    CheckCircle,
    Circle,
    Play,
    Pause,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { StagedIndexProgress } from '../../electron/backendClient';

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
                            <span className="text-red-500">{totalErrors} failed</span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
