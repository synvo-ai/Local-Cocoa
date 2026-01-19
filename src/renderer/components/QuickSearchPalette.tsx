import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Loader2, FileText, ExternalLink, Eye, ChevronDown, ChevronRight, Layers, Search, StickyNote, Plus, Trash2, Save, ArrowLeft, Check } from 'lucide-react';
import type { SearchHit, NoteSummary, NoteContent } from '../types';
import { cn } from '../lib/utils';

// Grouped file result with all its chunks
interface FileGroup {
    fileId: string;
    fileName: string;
    filePath: string;
    bestScore: number;
    chunks: SearchHit[];
}

// Group search hits by file
function groupHitsByFile(hits: SearchHit[]): FileGroup[] {
    const groups = new Map<string, FileGroup>();

    for (const hit of hits) {
        const fileId = hit.fileId;
        const metadata = hit.metadata ?? {};
        const fileName = String(metadata.name || metadata.file_name || metadata.filename || metadata.title || 'Untitled');
        const filePath = String(metadata.path || metadata.file_path || metadata.full_path || '');

        if (!groups.has(fileId)) {
            groups.set(fileId, {
                fileId,
                fileName,
                filePath,
                bestScore: hit.score,
                chunks: [],
            });
        }

        const group = groups.get(fileId)!;
        group.chunks.push(hit);
        // Update best score if this chunk has a higher score
        if (hit.score > group.bestScore) {
            group.bestScore = hit.score;
        }
    }

    // Convert to array and sort by best score descending
    return Array.from(groups.values())
        .sort((a, b) => b.bestScore - a.bestScore);
}

function getReferenceLabel(reference: SearchHit): { name: string; location: string } {
    const metadata = reference.metadata ?? {};
    const name = (metadata.file_name || metadata.name || metadata.filename || metadata.title) as string | undefined;
    const location = (metadata.path || metadata.file_path || metadata.full_path || '') as string | undefined;

    if (name && location) {
        return { name: String(name), location: String(location) };
    }

    if (location) {
        const normalised = String(location).replace(/\\/g, '/');
        const segments = normalised.split('/').filter(Boolean);
        const derivedName = segments[segments.length - 1] ?? `File ${reference.fileId}`;
        return { name: derivedName, location: String(location) };
    }

    if (name) {
        return { name: String(name), location: '' };
    }

    return { name: `File ${reference.fileId}`, location: '' };
}

// Extract page number from chunk metadata if available
function getPageNumber(hit: SearchHit): number | null {
    const metadata = hit.metadata ?? {};

    // Try various page number keys
    for (const key of ['page_number', 'page', 'page_start']) {
        const val = metadata[key];
        if (typeof val === 'number' && val > 0) {
            return val;
        }
    }

    // Try page_numbers array
    const pageNumbers = metadata.page_numbers;
    if (Array.isArray(pageNumbers) && pageNumbers.length > 0) {
        const first = pageNumbers[0];
        if (typeof first === 'number' && first > 0) {
            return first;
        }
    }

    return null;
}

// Score threshold below which results are collapsed
const LOW_SCORE_THRESHOLD = 0.3;

type PaletteTab = 'search' | 'notes';

interface QuickSearchPaletteProps {
    open: boolean;
    query: string;
    results: SearchHit[];
    isSearching: boolean;
    mode: 'rag' | 'qa';
    onModeChange: (mode: 'rag' | 'qa') => void;
    qaAnswer: string | null;
    qaMeta: string | null;
    statusMessage: string | null;
    searchContext?: { rewritten?: string | null; strategy?: string | null; latencyMs?: number | null; variants?: string[] } | null;
    searchStage?: string | null;
    fileFirstSeenMs?: Record<string, number>;
    onChange: (value: string) => void;
    onClose: () => void;
    onSubmit: (value: string) => void;
    onSelect: (hit: SearchHit) => void;
    onOpen: (hit: SearchHit) => void;
    // Notes props
    activeTab?: PaletteTab;
    onTabChange?: (tab: PaletteTab) => void;
    notes?: NoteSummary[];
    selectedNote?: NoteContent | null;
    isNotesLoading?: boolean;
    isNoteSaving?: boolean;
    onSelectNote?: (noteId: string) => void;
    onCreateNote?: () => void;
    onSaveNote?: (noteId: string, payload: { title: string; body: string }) => void;
    onDeleteNote?: (noteId: string) => void;
    onBackToNotesList?: () => void;
    // Progressive QA props
    needsUserDecision?: boolean;
    onResumeSearch?: () => void;
    resumeToken?: string | null;
}

export function QuickSearchPalette({
    open,
    query,
    results,
    isSearching,
    mode,
    qaAnswer,
    statusMessage,
    searchContext,
    searchStage,
    fileFirstSeenMs = {},
    onChange,
    onClose,
    onSubmit,
    onSelect,
    onOpen,
    // Notes props
    activeTab = 'search',
    onTabChange,
    notes = [],
    selectedNote,
    isNotesLoading = false,
    isNoteSaving = false,
    onSelectNote,
    onCreateNote,
    onSaveNote,
    onDeleteNote,
    onBackToNotesList,
    needsUserDecision = false,
    onResumeSearch,
    resumeToken
}: QuickSearchPaletteProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [hoveredHit, setHoveredHit] = useState<SearchHit | null>(null);
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
    const [elapsedTime, setElapsedTime] = useState(0);

    // Timer logic
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isSearching) {
            const startTime = Date.now();
            setElapsedTime(0);
            interval = setInterval(() => {
                setElapsedTime(Date.now() - startTime);
            }, 50); // Update frequently for smooth fractions
        }
        return () => clearInterval(interval);
    }, [isSearching]);

    // Notes editing state
    const [editingTitle, setEditingTitle] = useState('');
    const [editingBody, setEditingBody] = useState('');
    const [noteSearchQuery, setNoteSearchQuery] = useState('');

    // Sync editing state when selected note changes
    useEffect(() => {
        if (selectedNote) {
            setEditingTitle(selectedNote.title || '');
            setEditingBody(selectedNote.markdown || '');
        } else {
            setEditingTitle('');
            setEditingBody('');
        }
    }, [selectedNote]);

    // Auto-save with debounce
    const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'pending' | 'saving' | 'saved'>('idle');

    useEffect(() => {
        // Clear any existing timeout
        if (autoSaveTimeoutRef.current) {
            clearTimeout(autoSaveTimeoutRef.current);
        }

        // Don't auto-save if no note selected or content hasn't changed
        if (!selectedNote?.id) {
            setAutoSaveStatus('idle');
            return;
        }

        const hasChanges = editingTitle !== (selectedNote.title || '') ||
            editingBody !== (selectedNote.markdown || '');

        if (!hasChanges) {
            setAutoSaveStatus('idle');
            return;
        }

        setAutoSaveStatus('pending');

        // Auto-save after 1.5 seconds of no changes
        autoSaveTimeoutRef.current = setTimeout(() => {
            if (selectedNote?.id && onSaveNote) {
                setAutoSaveStatus('saving');
                onSaveNote(selectedNote.id, { title: editingTitle, body: editingBody });
                // Will be set to 'saved' after save completes
            }
        }, 1500);

        return () => {
            if (autoSaveTimeoutRef.current) {
                clearTimeout(autoSaveTimeoutRef.current);
            }
        };
    }, [editingTitle, editingBody, selectedNote, onSaveNote]);

    // Update auto-save status when save completes
    useEffect(() => {
        if (!isNoteSaving && autoSaveStatus === 'saving') {
            setAutoSaveStatus('saved');
            // Reset to idle after showing "saved" briefly
            const timer = setTimeout(() => setAutoSaveStatus('idle'), 2000);
            return () => clearTimeout(timer);
        }
    }, [isNoteSaving, autoSaveStatus]);

    // Focus textarea when editing a note
    useEffect(() => {
        if (activeTab === 'notes' && selectedNote && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [activeTab, selectedNote]);

    // Filter notes by search query
    const filteredNotes = useMemo(() => {
        if (!noteSearchQuery.trim()) return notes;
        const q = noteSearchQuery.toLowerCase();
        return notes.filter(n =>
            (n.title || '').toLowerCase().includes(q) ||
            (n.preview || '').toLowerCase().includes(q)
        );
    }, [notes, noteSearchQuery]);

    const handleSaveNote = useCallback(() => {
        if (!selectedNote?.id || !onSaveNote) return;
        onSaveNote(selectedNote.id, { title: editingTitle, body: editingBody });
    }, [selectedNote, editingTitle, editingBody, onSaveNote]);

    // Global Esc key handler - works even when no input is focused
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                // If editing a note, go back to list first
                if (activeTab === 'notes' && selectedNote) {
                    onBackToNotesList?.();
                } else {
                    onClose();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeTab, selectedNote, onBackToNotesList, onClose]);

    // Group results by file
    const fileGroups = useMemo(() => groupHitsByFile(results), [results]);

    // Toggle file expansion
    const toggleFileExpanded = useCallback((fileId: string) => {
        setExpandedFiles(prev => {
            const next = new Set(prev);
            if (next.has(fileId)) {
                next.delete(fileId);
            } else {
                next.add(fileId);
            }
            return next;
        });
    }, []);

    const renderCitation = useCallback((text: string) => {
        const parts = text.split(/(\[\s*\d+\s*\])/g);
        return parts.map((part, i) => {
            const match = part.match(/^\[\s*(\d+)\s*\]$/);
            if (match) {
                const index = parseInt(match[1], 10) - 1;
                const reference = results[index];
                if (reference) {
                    const { name } = getReferenceLabel(reference);
                    return (
                        <button
                            key={i}
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onOpen(reference);
                            }}
                            className="inline-flex items-center justify-center rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary hover:bg-primary/20 hover:underline mx-0.5 align-super cursor-pointer transition-colors"
                            title={name}
                        >
                            {match[1]}
                        </button>
                    );
                }
            }
            return part;
        });
    }, [results, onOpen]);

    const markdownComponents = useMemo(() => ({
        p: ({ children }: any) => (
            <p className="mb-2 last:mb-0">
                {React.Children.map(children, child => {
                    if (typeof child === 'string') {
                        return renderCitation(child);
                    }
                    return child;
                })}
            </p>
        ),
        li: ({ children }: any) => (
            <li>
                {React.Children.map(children, child => {
                    if (typeof child === 'string') {
                        return renderCitation(child);
                    }
                    return child;
                })}
            </li>
        ),
    }), [renderCitation]);

    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => {
            inputRef.current?.focus();
        }, 10);
        return () => {
            window.clearTimeout(timer);
        };
    }, [open]);

    if (!open) {
        return null;
    }

    const placeholder =
        mode === 'qa' ? 'Ask a question...' : 'Type to search...';

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4">
            {/* Invisible Backdrop to catch clicks */}
            <div
                className="fixed inset-0 bg-transparent"
                onClick={onClose}
            />

            <div className="relative flex w-full max-w-3xl gap-4 pointer-events-auto">
                {/* Main Palette */}
                <div className={cn(
                    "flex w-full flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl animate-in fade-in zoom-in-95 duration-200",
                    "ring-1 ring-border"
                )}>
                    {/* Header with Tabs - Draggable */}
                    <div
                        className="flex items-center justify-between border-b px-6 py-3"
                        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
                    >
                        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                            <button
                                type="button"
                                onClick={() => onTabChange?.('search')}
                                className={cn(
                                    "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors",
                                    activeTab === 'search'
                                        ? "bg-primary/10 text-primary"
                                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                                )}
                            >
                                <Search className="h-4 w-4" />
                                Search
                            </button>
                            <button
                                type="button"
                                onClick={() => onTabChange?.('notes')}
                                className={cn(
                                    "flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors",
                                    activeTab === 'notes'
                                        ? "bg-primary/10 text-primary"
                                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                                )}
                            >
                                <StickyNote className="h-4 w-4" />
                                Notes
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            className="rounded-full border bg-muted/50 px-3 py-1 text-[10px] font-bold text-muted-foreground hover:bg-destructive hover:text-destructive-foreground transition-colors"
                            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                        >
                            ESC TO CLOSE
                        </button>
                    </div>

                    {/* Search Tab Content */}
                    {activeTab === 'search' && (
                        <>
                            {/* Search Input Area */}
                            <div className="p-6 pb-2">
                                <div className="flex items-center gap-3 rounded-xl border bg-muted/30 px-4 py-3 focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary">
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={query}
                                        onChange={(event) => onChange(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                onSubmit(query.trim());
                                            }
                                            if (event.key === 'Escape') {
                                                event.preventDefault();
                                                onClose();
                                            }
                                        }}
                                        placeholder={placeholder}
                                        className="flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => onSubmit(query.trim())}
                                        disabled={!query.trim() || isSearching}
                                        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
                                    >
                                        {isSearching ? 'SEARCHING...' : 'SEARCH'}
                                    </button>
                                </div>
                            </div>

                            {/* Content Area */}
                            <div className="flex max-h-[60vh] flex-col overflow-y-auto px-6 pb-6 scrollbar-thin scrollbar-thumb-muted-foreground/20">

                                {/* Status & Metrics */}
                                <div className="mb-4 flex flex-col gap-2">
                                    <div className="flex items-center gap-3 min-h-[24px]">
                                        {isSearching && <Loader2 className="h-4 w-4 animate-spin text-primary" />}

                                        {/* Show file/chunk count when searching or complete */}
                                        {fileGroups.length > 0 && (
                                            <span className="text-xs text-muted-foreground">
                                                {fileGroups.length} file{fileGroups.length === 1 ? '' : 's'} · {results.length} chunk{results.length === 1 ? '' : 's'}
                                            </span>
                                        )}

                                        {statusMessage && !isSearching && fileGroups.length === 0 && (
                                            <span className="text-xs text-muted-foreground">{statusMessage}</span>
                                        )}

                                        {searchContext && !isSearching && searchContext.strategy && (
                                            <span className="ml-auto rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary uppercase">
                                                {searchContext.strategy.replace(/_/g, ' ')}
                                            </span>
                                        )}

                                        {/* Timer display */}
                                        {/* Timer display */}
                                        {elapsedTime > 0 && (
                                            <span className="text-xs text-muted-foreground font-mono ml-2">
                                                {(elapsedTime / 1000).toFixed(2)}s
                                            </span>
                                        )}
                                    </div>

                                    {/* Progressive search stage indicator */}
                                    {isSearching && searchStage && (
                                        <div className="flex items-center gap-2">
                                            <div className="flex gap-1">
                                                {['filename', 'summary', 'metadata', 'hybrid'].map((stage) => {
                                                    const stageOrder = ['filename', 'summary', 'metadata', 'hybrid'];
                                                    const currentIdx = stageOrder.indexOf(searchStage);
                                                    const stageIdx = stageOrder.indexOf(stage);
                                                    const isActive = stage === searchStage;
                                                    const isComplete = stageIdx < currentIdx;

                                                    return (
                                                        <div
                                                            key={stage}
                                                            className={cn(
                                                                "h-1 w-8 rounded-full transition-all duration-300",
                                                                isActive && "bg-primary animate-pulse",
                                                                isComplete && "bg-primary",
                                                                !isActive && !isComplete && "bg-muted"
                                                            )}
                                                        />
                                                    );
                                                })}
                                            </div>
                                            <span className="text-[10px] text-muted-foreground capitalize">
                                                {searchStage}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {/* QA Answer */}
                                {mode === 'qa' && qaAnswer && (
                                    <div className="mb-6 rounded-xl border bg-muted/30 p-4">
                                        <div className="prose prose-sm dark:prose-invert max-w-none">
                                            <ReactMarkdown components={markdownComponents}>{qaAnswer}</ReactMarkdown>
                                        </div>
                                        {/* Progressive Resume Button */}
                                        {needsUserDecision && (
                                            <div className="mt-4 flex items-center justify-between border-t border-border/50 pt-3">
                                                <span className="text-xs text-muted-foreground">
                                                    Found a likely answer. Search paused.
                                                </span>
                                                <button
                                                    onClick={onResumeSearch}
                                                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
                                                >
                                                    <Search className="h-3.5 w-3.5" />
                                                    Dig Deeper
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Results List - Grouped by File */}
                                {fileGroups.length > 0 && (() => {
                                    // Split into high-score and low-score groups
                                    const highScoreGroups = fileGroups.filter(g => g.bestScore >= LOW_SCORE_THRESHOLD);
                                    const lowScoreGroups = fileGroups.filter(g => g.bestScore < LOW_SCORE_THRESHOLD);

                                    return (
                                        <div className="space-y-3">
                                            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Results</h4>
                                            <div className="space-y-2">
                                                {highScoreGroups.map((group) => {
                                                    const isExpanded = expandedFiles.has(group.fileId);
                                                    const hasMultipleChunks = group.chunks.length > 1;
                                                    const primaryChunk = group.chunks[0];
                                                    const firstSeenMs = fileFirstSeenMs[group.fileId];

                                                    return (
                                                        <div
                                                            key={group.fileId}
                                                            className="rounded-lg border bg-card overflow-hidden transition-all hover:border-primary/50 hover:shadow-md"
                                                        >
                                                            {/* File Header */}
                                                            <div
                                                                className="group flex items-start gap-3 p-4 cursor-pointer"
                                                                onClick={() => hasMultipleChunks && toggleFileExpanded(group.fileId)}
                                                                onMouseEnter={() => setHoveredHit(primaryChunk)}
                                                                onMouseLeave={() => setHoveredHit(null)}
                                                            >
                                                                {/* Expand/Collapse Icon */}
                                                                <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center mt-0.5">
                                                                    {hasMultipleChunks ? (
                                                                        isExpanded ? (
                                                                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                                                        ) : (
                                                                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                                                        )
                                                                    ) : (
                                                                        <FileText className="h-4 w-4 text-muted-foreground" />
                                                                    )}
                                                                </div>

                                                                {/* File Info */}
                                                                <div className="flex-1 min-w-0">
                                                                    <div className="flex items-center justify-between gap-2">
                                                                        <div className="flex items-center gap-2 min-w-0">
                                                                            {hasMultipleChunks && <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                                                                            <span className="truncate font-medium text-sm text-foreground">
                                                                                {group.fileName}
                                                                            </span>
                                                                            {hasMultipleChunks && (
                                                                                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                                                                                    <Layers className="h-3 w-3" />
                                                                                    {group.chunks.length}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                        <div className="flex items-center gap-2 shrink-0">
                                                                            {typeof firstSeenMs === 'number' && (
                                                                                <span className="text-[10px] text-muted-foreground/60 font-mono">
                                                                                    {(firstSeenMs / 1000).toFixed(2)}s
                                                                                </span>
                                                                            )}
                                                                            <span className="text-[10px] text-muted-foreground font-mono">
                                                                                {group.bestScore.toFixed(2)}
                                                                            </span>
                                                                        </div>
                                                                    </div>

                                                                    {/* Show primary chunk snippet when not expanded */}
                                                                    {!isExpanded && primaryChunk.snippet && (
                                                                        <div className="mt-2">
                                                                            {(() => {
                                                                                const pageNum = getPageNumber(primaryChunk);
                                                                                return pageNum ? (
                                                                                    <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary mr-2 mb-1">
                                                                                        Page {pageNum}
                                                                                    </span>
                                                                                ) : null;
                                                                            })()}
                                                                            <p className="line-clamp-2 text-xs text-muted-foreground">
                                                                                {primaryChunk.snippet}
                                                                            </p>
                                                                        </div>
                                                                    )}

                                                                    {/* File Actions */}
                                                                    <div className="mt-2 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                                                                        <button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                onSelect(primaryChunk);
                                                                            }}
                                                                            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors"
                                                                        >
                                                                            <Eye className="h-3 w-3" />
                                                                            FOCUS
                                                                        </button>
                                                                        <button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                onOpen(primaryChunk);
                                                                            }}
                                                                            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
                                                                        >
                                                                            <ExternalLink className="h-3 w-3" />
                                                                            OPEN
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            </div>

                                                            {/* Expanded Chunks */}
                                                            {isExpanded && hasMultipleChunks && (
                                                                <div className="border-t bg-muted/20">
                                                                    {group.chunks.map((chunk, chunkIdx) => (
                                                                        <div
                                                                            key={chunk.chunkId ?? chunkIdx}
                                                                            className="group flex items-start gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                                                                            onMouseEnter={() => setHoveredHit(chunk)}
                                                                            onMouseLeave={() => setHoveredHit(null)}
                                                                        >
                                                                            {/* Chunk indicator */}
                                                                            <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center mt-0.5">
                                                                                <span className="text-[10px] font-mono text-muted-foreground">
                                                                                    #{chunkIdx + 1}
                                                                                </span>
                                                                            </div>

                                                                            {/* Chunk Content */}
                                                                            <div className="flex-1 min-w-0">
                                                                                <div className="flex items-center justify-between gap-2 mb-1">
                                                                                    <div className="flex items-center gap-2">
                                                                                        <span className="text-[10px] text-muted-foreground font-mono">
                                                                                            Chunk {chunk.chunkId?.slice(-8) || chunkIdx + 1}
                                                                                        </span>
                                                                                        {(() => {
                                                                                            const pageNum = getPageNumber(chunk);
                                                                                            return pageNum ? (
                                                                                                <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                                                                                                    P.{pageNum}
                                                                                                </span>
                                                                                            ) : null;
                                                                                        })()}
                                                                                    </div>
                                                                                    <span className="shrink-0 text-[10px] text-muted-foreground font-mono">
                                                                                        {chunk.score.toFixed(2)}
                                                                                    </span>
                                                                                </div>
                                                                                {chunk.snippet && (
                                                                                    <p className="line-clamp-2 text-xs text-muted-foreground">
                                                                                        {chunk.snippet}
                                                                                    </p>
                                                                                )}

                                                                                {/* Chunk Actions */}
                                                                                <div className="mt-2 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                                                                                    <button
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation();
                                                                                            onSelect(chunk);
                                                                                        }}
                                                                                        className="inline-flex items-center gap-1 rounded bg-secondary/80 px-2 py-1 text-[10px] font-medium text-secondary-foreground hover:bg-secondary transition-colors"
                                                                                    >
                                                                                        <Eye className="h-2.5 w-2.5" />
                                                                                        FOCUS
                                                                                    </button>
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}

                                                {/* Low score results - collapsed */}
                                                {lowScoreGroups.length > 0 && (
                                                    <details className="mt-4">
                                                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors py-2 flex items-center gap-2">
                                                            <ChevronRight className="h-3 w-3 details-open:rotate-90 transition-transform" />
                                                            {lowScoreGroups.length} low relevance result{lowScoreGroups.length === 1 ? '' : 's'}
                                                        </summary>
                                                        <div className="mt-2 space-y-2 opacity-60">
                                                            {lowScoreGroups.map((group) => {
                                                                const primaryChunk = group.chunks[0];
                                                                const firstSeenMs = fileFirstSeenMs[group.fileId];

                                                                return (
                                                                    <div
                                                                        key={group.fileId}
                                                                        className="rounded-lg border bg-card/50 p-3 transition-all hover:bg-card"
                                                                        onMouseEnter={() => setHoveredHit(primaryChunk)}
                                                                        onMouseLeave={() => setHoveredHit(null)}
                                                                    >
                                                                        <div className="flex items-center justify-between gap-2">
                                                                            <div className="flex items-center gap-2 min-w-0">
                                                                                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                                                                <span className="truncate text-xs text-foreground">
                                                                                    {group.fileName}
                                                                                </span>
                                                                            </div>
                                                                            <div className="flex items-center gap-2 shrink-0">
                                                                                {typeof firstSeenMs === 'number' && (
                                                                                    <span className="text-[9px] text-muted-foreground/50 font-mono">
                                                                                        {(firstSeenMs / 1000).toFixed(2)}s
                                                                                    </span>
                                                                                )}
                                                                                <span className="text-[9px] text-muted-foreground/70 font-mono">
                                                                                    {group.bestScore.toFixed(2)}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </details>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        </>
                    )}

                    {/* Notes Tab Content */}
                    {activeTab === 'notes' && (
                        <div className="flex flex-col max-h-[70vh] overflow-hidden">
                            {/* Notes Header */}
                            {!selectedNote ? (
                                <>
                                    <div className="flex items-center gap-3 px-6 py-4">
                                        <div className="flex-1 flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                                            <Search className="h-4 w-4 text-muted-foreground" />
                                            <input
                                                type="text"
                                                value={noteSearchQuery}
                                                onChange={(e) => setNoteSearchQuery(e.target.value)}
                                                placeholder="Search notes..."
                                                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Escape') {
                                                        e.preventDefault();
                                                        onClose();
                                                    }
                                                }}
                                            />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={onCreateNote}
                                            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                                        >
                                            <Plus className="h-4 w-4" />
                                            New
                                        </button>
                                    </div>

                                    {/* Notes List */}
                                    <div className="flex-1 overflow-y-auto px-6 pb-6">
                                        {isNotesLoading ? (
                                            <div className="flex items-center justify-center py-12">
                                                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                                            </div>
                                        ) : filteredNotes.length > 0 ? (
                                            <div className="space-y-2">
                                                {filteredNotes.map((note) => (
                                                    <button
                                                        key={note.id}
                                                        onClick={() => onSelectNote?.(note.id)}
                                                        className="w-full text-left rounded-lg border bg-card p-4 hover:border-primary/50 hover:shadow-md transition-all"
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="flex-1 min-w-0">
                                                                <h4 className={cn(
                                                                    "font-medium text-sm truncate",
                                                                    !note.title && "text-muted-foreground italic"
                                                                )}>
                                                                    {note.title || 'Untitled Note'}
                                                                </h4>
                                                                {note.preview && (
                                                                    <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                                                                        {note.preview}
                                                                    </p>
                                                                )}
                                                            </div>
                                                            <span className="text-[10px] text-muted-foreground shrink-0">
                                                                {new Date(note.updatedAt).toLocaleDateString()}
                                                            </span>
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                                                <StickyNote className="h-12 w-12 mb-3 opacity-30" />
                                                <p className="text-sm">No notes found</p>
                                                <button
                                                    onClick={onCreateNote}
                                                    className="mt-4 text-sm text-primary hover:underline"
                                                >
                                                    Create your first note
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </>
                            ) : (
                                /* Note Editor */
                                <div className="flex flex-col h-full">
                                    {/* Editor Header */}
                                    <div className="flex items-center gap-3 px-6 py-3 border-b">
                                        <button
                                            onClick={onBackToNotesList}
                                            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                            title="Back to notes"
                                        >
                                            <ArrowLeft className="h-4 w-4" />
                                        </button>
                                        <input
                                            type="text"
                                            value={editingTitle}
                                            onChange={(e) => setEditingTitle(e.target.value)}
                                            placeholder="Note title..."
                                            className="flex-1 bg-transparent text-lg font-medium outline-none placeholder:text-muted-foreground"
                                        />
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={handleSaveNote}
                                                disabled={isNoteSaving}
                                                className={cn(
                                                    "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                                                    isNoteSaving
                                                        ? "bg-muted text-muted-foreground"
                                                        : "bg-primary text-primary-foreground hover:bg-primary/90"
                                                )}
                                            >
                                                {isNoteSaving ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <Save className="h-4 w-4" />
                                                )}
                                                Save
                                            </button>
                                            <button
                                                onClick={() => selectedNote?.id && onDeleteNote?.(selectedNote.id)}
                                                className="p-2 rounded-lg text-destructive hover:bg-destructive/10 transition-colors"
                                                title="Delete note"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    </div>

                                    {/* Editor Body */}
                                    <div className="flex-1 min-h-0 px-6 py-4">
                                        <textarea
                                            ref={textareaRef}
                                            value={editingBody}
                                            onChange={(e) => setEditingBody(e.target.value)}
                                            placeholder="Start writing..."
                                            className="w-full h-full min-h-[300px] resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground leading-relaxed"
                                            onKeyDown={(e) => {
                                                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                                                    e.preventDefault();
                                                    handleSaveNote();
                                                }
                                                if (e.key === 'Escape') {
                                                    e.preventDefault();
                                                    onBackToNotesList?.();
                                                }
                                            }}
                                        />
                                    </div>

                                    {/* Editor Footer */}
                                    <div className="px-6 py-3 border-t text-xs text-muted-foreground flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <span>{editingBody.length} characters</span>
                                            {autoSaveStatus === 'pending' && (
                                                <span className="text-amber-500 flex items-center gap-1">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                                                    Unsaved
                                                </span>
                                            )}
                                            {autoSaveStatus === 'saving' && (
                                                <span className="text-primary flex items-center gap-1">
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                    Saving...
                                                </span>
                                            )}
                                            {autoSaveStatus === 'saved' && (
                                                <span className="text-emerald-500 flex items-center gap-1">
                                                    <Check className="h-3 w-3" />
                                                    Saved
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <span className="flex items-center gap-1">
                                                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">⌘S</kbd>
                                                Save
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">Esc</kbd>
                                                Back
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Preview Popup (Side Panel) */}
                {hoveredHit && (
                    <div className="hidden lg:block w-80 shrink-0 animate-in fade-in slide-in-from-left-4 duration-200">
                        <div className="sticky top-4 rounded-xl border bg-popover p-5 shadow-xl text-popover-foreground">
                            <div className="mb-4 flex items-center gap-2 text-muted-foreground">
                                <FileText className="h-5 w-5" />
                                <span className="text-xs font-semibold uppercase tracking-wider">Preview</span>
                            </div>

                            <h4 className="mb-2 font-semibold leading-tight break-words">
                                {String(hoveredHit.metadata?.name || hoveredHit.metadata?.file_name || 'Untitled')}
                            </h4>

                            <div className="mb-4 rounded bg-muted/50 p-2 text-[10px] font-mono text-muted-foreground break-all">
                                {String(hoveredHit.metadata?.path || hoveredHit.metadata?.file_path || hoveredHit.metadata?.full_path || '')}
                            </div>

                            <div className="prose prose-sm dark:prose-invert max-w-none">
                                <p className="text-sm text-muted-foreground leading-relaxed">
                                    {hoveredHit.summary || hoveredHit.snippet || "No preview content available."}
                                </p>
                            </div>

                            <div className="mt-6 pt-4 border-t flex gap-2">
                                <button
                                    onClick={() => onOpen(hoveredHit)}
                                    className="w-full rounded-lg bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                                >
                                    Open File
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div >
    );
}

