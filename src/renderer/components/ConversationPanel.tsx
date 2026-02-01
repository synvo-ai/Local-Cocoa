import { FormEvent, useMemo, useState, useRef, useEffect, useCallback, CSSProperties } from 'react';
import { Send, RefreshCw, FileText, Layers, ChevronDown, Zap, BookOpen, MessageCircle, Eye } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { SearchHit, ConversationMessage, IndexedFile, ModelAssetStatus } from '../types';
import { LoadingDots } from './LoadingDots';
import { AgentProcess } from './AgentProcess';
import { ThinkingProcess } from './ThinkingProcess';
import { useSkin } from './skin-provider';
import { cn } from '../lib/utils';
import cocoaMascot from '../assets/cocoa-mascot.png';
import cocoaBranchLeft from '../assets/cocoa-branch-left.png';
import cocoaBranchRight from '../assets/cocoa-branch-right.png';
import localCocoaLogo from '../assets/local_cocoa_logo_full.png';

export type SearchMode = 'auto' | 'knowledge' | 'direct';

const SEARCH_MODE_CONFIG = {
    auto: {
        label: 'Auto',
        description: 'AI decides when to search files',
        icon: Zap,
    },
    knowledge: {
        label: 'Knowledge',
        description: 'Always search your files',
        icon: BookOpen,
    },
    direct: {
        label: 'Direct',
        description: 'Chat without file search',
        icon: MessageCircle,
    },
} as const;

export interface AgentContext {
    original?: string;
    rewritten?: string | null;
    variants?: string[];
    latencyMs?: number | null;
    status?: 'idle' | 'pending' | 'ok' | 'error';
}

interface ConversationPanelProps {
    messages: ConversationMessage[];
    loading: boolean;
    onSend: (text: string, mode?: SearchMode, useVisionForAnswer?: boolean) => Promise<void>;
    model: string;
    availableModels?: ModelAssetStatus[];
    onModelChange?: (modelId: string) => void;
    onAddLocalModel?: () => void;
    title?: string;
    subtitle?: string;
    className?: string;
    onPreviewReference?: (reference: SearchHit) => void;
    onResetConversation?: () => void;
    agentContext?: AgentContext | null;
    files?: IndexedFile[];
    onResume?: (mode?: SearchMode) => Promise<void>;
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

function ReferenceItem({ reference, index, onPreview }: { reference: SearchHit, index: number, onPreview: (ref: SearchHit) => void }) {
    const [expanded, setExpanded] = useState(false);
    const { name, location } = getReferenceLabel(reference);
    const snippet = reference.snippet || reference.summary;
    const isClickable = !!(reference.fileId || location);

    // Chunk analysis info
    const hasAnswer = reference.hasAnswer;
    const analysisComment = reference.analysisComment;
    const _confidence = reference.analysisConfidence ?? 0;

    // Determine if this chunk was analyzed (hasAnswer is defined means it was analyzed)
    const wasAnalyzed = hasAnswer !== undefined;

    // Check if comment indicates no relevant information
    const commentUpper = analysisComment?.toUpperCase() ?? '';
    const noAnswerPatterns = [
        'NO_ANSWER',
        'NO ANSWER',
        'DOES NOT PROVIDE',
        'DOES NOT CONTAIN',
        "DOESN'T PROVIDE",
        "DOESN'T CONTAIN",
        'NOT PROVIDE SPECIFIC',
        'NOT CONTAIN SPECIFIC',
        'NO SPECIFIC',
        'NO RELEVANT',
        'NOT RELEVANT',
        'CANNOT ANSWER',
        "CAN'T ANSWER",
        'NO INFORMATION',
        'NOT MENTIONED',
        "DOESN'T MENTION",
        'DOES NOT MENTION',
    ];
    const containsNoAnswer = noAnswerPatterns.some(pattern => commentUpper.includes(pattern));
    const isRelevant = hasAnswer === true && !containsNoAnswer;

    // Extract page information from metadata
    const metadata = reference.metadata ?? {};
    const pageStart = metadata.page_start ?? metadata.page_number ?? null;
    const pageEnd = metadata.page_end ?? null;
    const pageNumbers = metadata.page_numbers as number[] | undefined;

    // Format page display
    let pageDisplay = '';
    if (pageStart) {
        if (pageEnd && pageEnd !== pageStart) {
            pageDisplay = `Page ${pageStart}-${pageEnd}`;
        } else {
            pageDisplay = `Page ${pageStart}`;
        }
    } else if (pageNumbers && pageNumbers.length > 0) {
        if (pageNumbers.length === 1) {
            pageDisplay = `Page ${pageNumbers[0]}`;
        } else {
            pageDisplay = `Page ${pageNumbers[0]}-${pageNumbers[pageNumbers.length - 1]}`;
        }
    }

    // Confidence badge color
    const getConfidenceBadge = () => {
        if (!wasAnalyzed) return null;

        if (!isRelevant) {
            return (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">
                    Not relevant
                </span>
            );
        }

        return (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                Relevant
            </span>
        );
    };

    return (
        <div className={cn(
            "group rounded-lg border text-left transition-all duration-300 hover:shadow-sm",
            wasAnalyzed && isRelevant
                ? "bg-card border-green-200 dark:border-green-800/50 animate-in fade-in-50 duration-300"
                : wasAnalyzed && !isRelevant
                    ? "bg-red-50/30 dark:bg-red-900/5 border-red-200 dark:border-red-800/30 opacity-70 animate-in fade-in-50 duration-300"
                    : "bg-card border-muted"
        )}>
            <button
                onClick={() => isClickable && onPreview(reference)}
                className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 rounded-t-lg transition-colors",
                    isClickable ? "hover:bg-accent/50 cursor-pointer" : "cursor-default opacity-80"
                )}
            >
                <div className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold",
                    wasAnalyzed && isRelevant
                        ? "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400"
                        : wasAnalyzed && !isRelevant
                            ? "bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400"
                            : "bg-muted text-muted-foreground"
                )}>
                    {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <p className="truncate text-xs font-medium text-foreground">{name}</p>
                        {getConfidenceBadge()}
                    </div>
                    <div className="flex items-center gap-2">
                        {location && <p className="truncate text-[10px] text-muted-foreground">{location}</p>}
                        {pageDisplay && (
                            <>
                                {location && <span className="text-[10px] text-muted-foreground">•</span>}
                                <p className="text-[10px] text-muted-foreground font-medium">{pageDisplay}</p>
                            </>
                        )}
                        {reference.score > 0 && (
                            <>
                                {(location || pageDisplay) && <span className="text-[10px] text-muted-foreground">•</span>}
                                <p className="text-[10px] text-muted-foreground font-mono">{reference.score.toFixed(2)}</p>
                            </>
                        )}
                    </div>
                </div>
                {isClickable && (
                    <FileText className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
            </button>

            {/* LLM Analysis Comment */}
            {analysisComment && (
                <div className={cn(
                    "border-t px-3 py-2",
                    isRelevant
                        ? "border-green-200 dark:border-green-800/30 bg-green-50/50 dark:bg-green-900/10"
                        : "border-red-200 dark:border-red-800/30 bg-red-50/50 dark:bg-red-900/10"
                )}>
                    <p className={cn(
                        "text-[10px] leading-relaxed",
                        isRelevant
                            ? "text-green-700 dark:text-green-400"
                            : "text-red-600 dark:text-red-400"
                    )}>
                        <span className="font-medium">AI Analysis: </span>
                        {analysisComment}
                    </p>
                </div>
            )}

            {/* Original Snippet */}
            {snippet && (
                <div
                    className="border-t bg-muted/20 px-3 py-2 cursor-pointer hover:bg-muted/30"
                    onClick={() => setExpanded(!expanded)}
                    title="Click to expand/collapse"
                >
                    <p className={cn(
                        "text-[10px] text-muted-foreground font-mono leading-relaxed",
                        expanded ? "" : "line-clamp-3"
                    )}>
                        {snippet}
                    </p>
                </div>
            )}
        </div>
    );
}

function RecalledContext({ references, onPreview, isComplete, analysisProgress }: {
    references: SearchHit[],
    onPreview: (ref: SearchHit) => void,
    isComplete: boolean,
    analysisProgress?: {
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
}) {
    // Start collapsed, expand when we have references and are still processing
    const [isExpanded, setIsExpanded] = useState(false);
    const [showNotRelevant, setShowNotRelevant] = useState(false);
    const [hasExpandedOnce, setHasExpandedOnce] = useState(false);

    // Check if analysis is in progress
    const isAnalyzing = analysisProgress && !analysisProgress.isComplete;

    // Auto-expand when we have references and processing isn't complete (only once)
    useEffect(() => {
        if (references.length > 0 && !isComplete && !hasExpandedOnce) {
            setIsExpanded(true);
            setHasExpandedOnce(true);
        }
    }, [references.length, isComplete, hasExpandedOnce]);

    if (!references || references.length === 0) return null;

    // Helper to check if a reference is truly relevant (has answer and no negative patterns)
    // NOTE: Patterns are split into two categories:
    // 1. Explicit markers (NO_ANSWER, NO ANSWER) - checked globally (LLM's explicit signal)
    // 2. Contextual phrases - checked only in first sentence to avoid false positives
    const isTrulyRelevant = (r: SearchHit) => {
        if (r.hasAnswer !== true) return false;
        const comment = r.analysisComment?.toUpperCase() ?? '';

        // Explicit markers - check globally (LLM's clear signal)
        const explicitMarkers = ['NO_ANSWER', 'NO ANSWER'];
        if (explicitMarkers.some(marker => comment.includes(marker))) {
            return false;
        }

        // Contextual patterns - only check in first sentence to avoid false positives
        const firstSentence = comment.split(/[.?!]\s/)[0] || comment;
        const contextualPatterns = [
            'DOES NOT PROVIDE', 'DOES NOT CONTAIN',
            "DOESN'T PROVIDE", "DOESN'T CONTAIN", 'NOT PROVIDE SPECIFIC',
            'NOT CONTAIN SPECIFIC', 'NO SPECIFIC', 'NO RELEVANT', 'NOT RELEVANT',
            'CANNOT ANSWER', "CAN'T ANSWER", 'NO INFORMATION', 'NOT MENTIONED',
            "DOESN'T MENTION", 'DOES NOT MENTION'
        ];
        return !contextualPatterns.some(pattern => firstSentence.includes(pattern));
    };

    // Calculate stats for analyzed chunks
    const analyzedRefs = references.filter(r => r.hasAnswer !== undefined);
    const relevantRefs = references.filter(isTrulyRelevant);
    const notRelevantRefs = analyzedRefs.filter(r => !isTrulyRelevant(r));
    const hasAnalysis = analyzedRefs.length > 0;

    // Sort relevant references by confidence
    const sortedRelevantRefs = [...relevantRefs].sort((a, b) => {
        return (b.analysisConfidence ?? 0) - (a.analysisConfidence ?? 0);
    });

    // Sort not relevant references by confidence as well
    const sortedNotRelevantRefs = [...notRelevantRefs].sort((a, b) => {
        return (b.analysisConfidence ?? 0) - (a.analysisConfidence ?? 0);
    });

    // For references without analysis, keep original order
    const unanalyzedRefs = references.filter(r => r.hasAnswer === undefined);

    return (
        <div className="rounded-lg border bg-card overflow-hidden mb-4 transition-all duration-300 ease-in-out">
            <div className="flex items-center justify-between bg-card px-4 py-3 border-b border-transparent data-[expanded=true]:border-border" data-expanded={isExpanded}>
                <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-primary/30 bg-primary/5 text-primary">
                        <Layers className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col items-start flex-1">
                        <span className="text-sm font-medium">Recalled Context</span>
                        {isAnalyzing ? (
                            <div className="flex flex-col gap-1 w-full max-w-[320px]">
                                {analysisProgress.isPreparing ? (
                                    // Preparing state - waiting for first chunk
                                    <>
                                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                                            Starting analysis of {analysisProgress.totalCount} sources...
                                        </span>
                                        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                                            <div className="h-full rounded-full bg-primary/50 animate-pulse w-[10%]" />
                                        </div>
                                    </>
                                ) : (
                                    // Active analysis - show progress and current file
                                    <>
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-muted-foreground">
                                                Analyzed {analysisProgress.processedCount}/{analysisProgress.totalCount}
                                            </span>
                                            {analysisProgress.highQualityCount > 0 && (
                                                <span className="text-[10px] text-green-600 dark:text-green-400">
                                                    {analysisProgress.highQualityCount} relevant
                                                </span>
                                            )}
                                        </div>
                                        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                                            <div
                                                className="h-full rounded-full transition-all duration-200 ease-out bg-primary"
                                                style={{
                                                    width: `${(analysisProgress.processedCount / analysisProgress.totalCount) * 100}%`
                                                }}
                                            />
                                        </div>
                                        {analysisProgress.currentFiles && analysisProgress.currentFiles.length > 0 && (
                                            <span className="text-[10px] text-muted-foreground/70 truncate flex items-center gap-1">
                                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                                                {analysisProgress.currentFiles[0]}
                                            </span>
                                        )}
                                    </>
                                )}
                            </div>
                        ) : hasAnalysis ? (
                            <span className="text-xs text-muted-foreground">
                                <span className="text-green-600 dark:text-green-400 font-medium">{relevantRefs.length} relevant</span>
                                {' / '}
                                {references.length} sources
                            </span>
                        ) : !isComplete ? (
                            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                                Found {references.length} sources, preparing analysis...
                            </span>
                        ) : (
                            <span className="text-xs text-muted-foreground">
                                {references.length} sources referenced
                            </span>
                        )}
                    </div>
                </div>
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="text-xs font-medium text-primary hover:underline focus:outline-none"
                >
                    {isExpanded ? 'Hide details' : 'Show details'}
                </button>
            </div>

            {isExpanded && (
                <div className="bg-background p-4 animate-in slide-in-from-top-2 duration-200">
                    {/* Relevant sources */}
                    {sortedRelevantRefs.length > 0 && (
                        <div className="grid gap-2 sm:grid-cols-1">
                            {sortedRelevantRefs.map((reference, idx) => (
                                <ReferenceItem
                                    key={`relevant-${reference.fileId}-${idx}`}
                                    reference={reference}
                                    index={references.indexOf(reference)}
                                    onPreview={onPreview}
                                />
                            ))}
                        </div>
                    )}

                    {/* Unanalyzed sources (show normally) */}
                    {unanalyzedRefs.length > 0 && (
                        <div className={cn("grid gap-2 sm:grid-cols-1", sortedRelevantRefs.length > 0 && "mt-2")}>
                            {unanalyzedRefs.map((reference, idx) => (
                                <ReferenceItem
                                    key={`unanalyzed-${reference.fileId}-${idx}`}
                                    reference={reference}
                                    index={references.indexOf(reference)}
                                    onPreview={onPreview}
                                />
                            ))}
                        </div>
                    )}

                    {/* Collapsible not-relevant section */}
                    {notRelevantRefs.length > 0 && (
                        <div className={cn(
                            "mt-3 rounded-lg border border-dashed transition-all duration-200",
                            showNotRelevant
                                ? "border-muted-foreground/30 bg-muted/20"
                                : "border-muted-foreground/20 hover:border-muted-foreground/30 bg-muted/10"
                        )}>
                            <button
                                onClick={() => setShowNotRelevant(!showNotRelevant)}
                                className="w-full flex items-center justify-between px-3 py-2.5 text-left group"
                            >
                                <div className="flex items-center gap-2">
                                    <div className={cn(
                                        "flex h-5 w-5 items-center justify-center rounded transition-transform duration-200",
                                        showNotRelevant ? "rotate-90" : ""
                                    )}>
                                        <svg
                                            className="h-3 w-3 text-muted-foreground"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                        >
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                        </svg>
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                        <span className="font-medium">{notRelevantRefs.length}</span>
                                        {' '}other source{notRelevantRefs.length !== 1 ? 's' : ''} not directly relevant
                                    </span>
                                </div>
                                <span className="text-[10px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {showNotRelevant ? 'Click to collapse' : 'Click to expand'}
                                </span>
                            </button>

                            {showNotRelevant && (
                                <div className="px-3 pb-3 pt-1 grid gap-2 sm:grid-cols-1 animate-in slide-in-from-top-2 duration-200">
                                    {sortedNotRelevantRefs.map((reference, idx) => (
                                        <ReferenceItem
                                            key={`not-relevant-${reference.fileId}-${idx}`}
                                            reference={reference}
                                            index={references.indexOf(reference)}
                                            onPreview={onPreview}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Empty state when no relevant sources */}
                    {sortedRelevantRefs.length === 0 && unanalyzedRefs.length === 0 && notRelevantRefs.length > 0 && !showNotRelevant && (
                        <div className="text-center py-2 text-xs text-muted-foreground">
                            No directly relevant sources found. Expand above to see all retrieved sources.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export function ConversationPanel({
    messages,
    loading,
    onSend,
    model: _model,
    availableModels: _availableModels,
    onModelChange: _onModelChange,
    onAddLocalModel: _onAddLocalModel,
    title = 'Ask your workspace',
    subtitle,
    className,
    onPreviewReference,
    onResetConversation,
    agentContext,
    files = [],
    onResume
}: ConversationPanelProps) {
    const [input, setInput] = useState('');
    const [suggestionQuery, setSuggestionQuery] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searchMode, setSearchMode] = useState<SearchMode>('knowledge');
    const [isModeDropdownOpen, setIsModeDropdownOpen] = useState(false);
    const [useVisionForAnswer, setUseVisionForAnswer] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const modeDropdownRef = useRef<HTMLDivElement>(null);
    // Track IME composition state to prevent accidental sends during Chinese/Japanese input
    const isComposingRef = useRef(false);
    const { skin } = useSkin();
    const isCocoaSkin = skin === 'local-cocoa';

    const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
    const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

    // Close mode dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (modeDropdownRef.current && !modeDropdownRef.current.contains(event.target as Node)) {
                setIsModeDropdownOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const filteredFiles = useMemo(() => {
        if (suggestionQuery === null) return [];
        const query = suggestionQuery.toLowerCase();
        return files.filter(f => f.name.toLowerCase().includes(query)).slice(0, 5);
    }, [files, suggestionQuery]);

    const DEFAULT_SUGGESTIONS = [
        'What file formats can I index?',
        'How do I add documents to my workspace?',
        'What can you help me with?',
        'Show me how to search my files'
    ];
    const [quickSuggestions, setQuickSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);
    const [hasIndexedFiles, setHasIndexedFiles] = useState(false);
    const [isRefreshingSuggestions, setIsRefreshingSuggestions] = useState(false);

    const fetchSuggestions = useCallback(async () => {
        try {
            setIsRefreshingSuggestions(true);
            if (!window.api?.getLocalKey) {
                console.warn('[ConversationPanel] window.api not available yet');
                return;
            }
            const key = await window.api.getLocalKey();
            if (key) {
                // Check if user has any indexed files
                const summaryRes = await fetch('http://127.0.0.1:8890/index/summary', {
                    headers: { 'X-API-Key': key }
                });
                const summary = await summaryRes.json();
                const fileCount = summary?.files_indexed ?? 0;
                setHasIndexedFiles(fileCount > 0);

                if (fileCount > 0) {
                    // User has files - fetch suggestions from their documents
                    const res = await fetch('http://127.0.0.1:8890/suggestions?limit=4', {
                        headers: { 'X-API-Key': key }
                    });
                    const data = await res.json();
                    // Use document-based suggestions, or empty if none available
                    setQuickSuggestions(Array.isArray(data) && data.length > 0 ? data : []);
                } else {
                    // No files - show default onboarding suggestions
                    setQuickSuggestions(DEFAULT_SUGGESTIONS);
                }
            }
        } catch (err) {
            console.error("Failed to fetch suggestions:", err);
        } finally {
            setIsRefreshingSuggestions(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fetchSuggestions();
    }, [fetchSuggestions]);
    const trimmedInput = input.trim();
    const hasInput = trimmedInput.length > 0;
    const hasMessages = messages.length > 0;

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    }, [input]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, loading]);

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (!trimmedInput || loading) return;
        setInput('');
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }
        await onSend(trimmedInput, searchMode, useVisionForAnswer);
    }

    function renderMessageText(text: string, references?: SearchHit[]) {
        // Process reference citations [1], [2], etc.
        // Also handles comma-separated formats like [11, 18, 29] by normalizing them first
        const processReferences = (content: string) => {
            if (!references || references.length === 0) {
                return content;
            }

            // First, normalize comma-separated citations like [11, 18, 29] to [11][18][29]
            const normalizedContent = content.replace(
                /\[\s*(\d+(?:\s*,\s*\d+)+)\s*\]/g,
                (match, nums) => {
                    const numbers = nums.split(/\s*,\s*/);
                    return numbers.map((n: string) => `[${n.trim()}]`).join('');
                }
            );

            const parts = normalizedContent.split(/(\[\s*\d+\s*\])/g);
            return parts.map((part, i) => {
                const match = part.match(/^\[\s*(\d+)\s*\]$/);
                if (match) {
                    const citationNumber = parseInt(match[1], 10);
                    // Find reference by metadata.index (global citation index from backend)
                    // This is critical for multi-path retrieval where indices span multiple rounds
                    const reference = references.find(r => r.metadata?.index === citationNumber);
                    if (reference) {
                        const { location } = getReferenceLabel(reference);
                        const isClickable = !!(reference.fileId || location);

                        if (!isClickable) {
                            return <span key={i} className="text-muted-foreground text-[10px] mx-0.5">{match[0]}</span>;
                        }

                        return (
                            <button
                                key={i}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onPreviewReference?.(reference);
                                }}
                                className="inline-flex items-center justify-center rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary hover:bg-primary/20 hover:underline mx-0.5 align-super cursor-pointer transition-colors"
                                title={getReferenceLabel(reference).name}
                            >
                                {match[1]}
                            </button>
                        );
                    }
                }
                return part;
            });
        };

        return (
            <div className="markdown-content text-sm leading-relaxed">
                <ReactMarkdown
                    components={{
                        // Customize paragraph to handle reference citations
                        p: ({ children }) => {
                            if (typeof children === 'string') {
                                return <p>{processReferences(children)}</p>;
                            }
                            // Handle array of children
                            const processed = Array.isArray(children)
                                ? children.map((child, _idx) =>
                                    typeof child === 'string' ? processReferences(child) : child
                                )
                                : children;
                            return <p>{processed}</p>;
                        },
                        // Style code blocks
                        code: ({ className, children, ...props }) => {
                            const isInline = !className;
                            if (isInline) {
                                return (
                                    <code
                                        className={cn(
                                            "px-1 py-0.5 rounded text-sm",
                                            isCocoaSkin
                                                ? "bg-[#c9a87c]/20 text-[#5c4a2a]"
                                                : "bg-muted text-foreground"
                                        )}
                                        {...props}
                                    >
                                        {children}
                                    </code>
                                );
                            }
                            return (
                                <code className={cn(className, "block overflow-x-auto")} {...props}>
                                    {children}
                                </code>
                            );
                        },
                        // Style pre blocks
                        pre: ({ children }) => (
                            <pre className={cn(
                                "p-3 rounded-lg overflow-x-auto text-sm",
                                isCocoaSkin
                                    ? "bg-[#2a1f14] text-[#e8d4bc]"
                                    : "bg-muted"
                            )}>
                                {children}
                            </pre>
                        ),
                        // Style links
                        a: ({ href, children }) => (
                            <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={cn(
                                    "underline",
                                    isCocoaSkin ? "text-[#8b6914] hover:text-[#5c4a2a]" : "text-primary hover:text-primary/80"
                                )}
                            >
                                {children}
                            </a>
                        ),
                        // Style lists
                        ul: ({ children }) => <ul className="list-disc pl-4 space-y-1">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal pl-4 space-y-1">{children}</ol>,
                        li: ({ children }) => {
                            const processed = Array.isArray(children)
                                ? children.map((child, _idx) =>
                                    typeof child === 'string' ? processReferences(child) : child
                                )
                                : typeof children === 'string' ? processReferences(children) : children;
                            return <li className="leading-relaxed">{processed}</li>;
                        },
                        // Style blockquotes
                        blockquote: ({ children }) => (
                            <blockquote className={cn(
                                "border-l-4 pl-4 italic",
                                isCocoaSkin ? "border-[#c9a87c] text-[#5c4a2a]/80" : "border-muted-foreground/30 text-muted-foreground"
                            )}>
                                {children}
                            </blockquote>
                        ),
                    }}
                >
                    {text}
                </ReactMarkdown>
            </div>
        );
    }

    return (
        <div className={cn(
            "flex h-full flex-col relative",
            isCocoaSkin ? "cocoa-main-bg" : "bg-background",
            className
        )}>
            {/* Decorative elements for Local Cocoa skin */}
            {isCocoaSkin && (
                <>
                    <div className="cocoa-decor-left">
                        <img src={cocoaBranchLeft} alt="" aria-hidden="true" />
                    </div>
                    <div className="cocoa-decor-right">
                        <img src={cocoaBranchRight} alt="" aria-hidden="true" />
                    </div>
                </>
            )}

            <div className={cn(
                "flex items-center justify-between border-b px-6 py-3 pt-8 relative z-10",
                isCocoaSkin && "cocoa-header-glass border-[#c9a87c]/30"
            )} style={dragStyle}>
                <div>
                    <h2 className={cn(
                        "text-sm font-semibold",
                        isCocoaSkin && "cocoa-heading text-[#5c4a2a] dark:text-[#e8d4bc]"
                    )}>{title}</h2>
                    {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
                </div>
                <div className="flex items-center gap-3" style={noDragStyle}>
                    {agentContext?.latencyMs ? (
                        <span className="text-[10px] text-muted-foreground">
                            {agentContext.latencyMs}ms
                        </span>
                    ) : null}

                    {onResetConversation ? (
                        <button
                            type="button"
                            onClick={() => {
                                setInput('');
                                onResetConversation();
                            }}
                            disabled={!hasMessages && !hasInput}
                            className={cn(
                                "rounded-md p-1.5 transition-colors disabled:opacity-50",
                                isCocoaSkin
                                    ? "text-[#8b6914] hover:bg-[#c9a87c]/20 hover:text-[#5c4a2a]"
                                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                            title="New Chat"
                        >
                            <RefreshCw className="h-4 w-4" />
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6 relative z-10">
                {messages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center text-center max-w-2xl mx-auto">
                        {/* Mascot or logo */}
                        {isCocoaSkin ? (
                            <div className="mb-6">
                                <img
                                    src={cocoaMascot}
                                    alt="Cocoa Mascot"
                                    className="cocoa-mascot h-16 w-16 object-contain"
                                />
                            </div>
                        ) : (
                            <div className="mb-6">
                                <img
                                    src={localCocoaLogo}
                                    alt="Local Cocoa"
                                    className="h-12 w-auto object-contain opacity-80"
                                />
                            </div>
                        )}
                        <h3 className={cn(
                            "text-lg font-medium mb-2",
                            isCocoaSkin && "cocoa-heading text-[#5c4a2a] dark:text-[#e8d4bc]"
                        )}>How can I help you today?</h3>
                        <p className={cn(
                            "text-sm mb-8",
                            isCocoaSkin ? "text-[#8b6914] dark:text-[#c9a87c]" : "text-muted-foreground"
                        )}>
                            I can help you search, analyze, and summarize your workspace documents.
                        </p>
                        <div className="relative w-full">
                            {hasIndexedFiles && (
                                <button
                                    onClick={fetchSuggestions}
                                    disabled={isRefreshingSuggestions}
                                    className={cn(
                                        "absolute -top-6 right-0 p-1 rounded-md transition-colors opacity-40 hover:opacity-100",
                                        isCocoaSkin
                                            ? "text-[#8b6914] hover:bg-[#c9a87c]/20"
                                            : "text-muted-foreground hover:bg-accent"
                                    )}
                                    title="Refresh suggestions"
                                >
                                    <RefreshCw className={cn("h-3.5 w-3.5", isRefreshingSuggestions && "animate-spin")} />
                                </button>
                            )}
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 w-full">
                                {quickSuggestions.map((prompt) => (
                                    <button
                                        key={prompt}
                                        onClick={() => setInput(prompt)}
                                        className={cn(
                                            "rounded-lg border px-4 py-3 text-left text-sm transition-colors",
                                            isCocoaSkin
                                                ? "cocoa-suggestion-card border-[#c9a87c] text-[#5c4a2a] dark:text-[#e8d4bc]"
                                                : "bg-card hover:bg-accent hover:text-accent-foreground"
                                        )}
                                    >
                                        {prompt}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                ) : (
                    messages.map((message, index) => {
                        const messageKey = `${message.timestamp}-${index}`;
                        const isUser = message.role === 'user';

                        return (
                            <div key={messageKey} className={cn("flex", isUser ? "justify-end" : "justify-start")}>
                                <div className={cn("max-w-[85%] space-y-2", isUser ? "items-end" : "items-start")}>

                                    {!isUser && message.steps && message.steps.length > 0 && (
                                        <div className="ml-1 mb-2">
                                            <AgentProcess
                                                steps={message.steps}
                                                isComplete={message.meta !== 'Thinking...'}
                                                autoHide={true}
                                                onFileClick={(file) => {
                                                    if (onPreviewReference && file.fileId) {
                                                        onPreviewReference({
                                                            fileId: file.fileId,
                                                            score: file.score || 0,
                                                            metadata: { name: file.label }
                                                        });
                                                    }
                                                }}
                                            />
                                        </div>
                                    )}


                                    {!isUser && message.thinkingSteps && message.thinkingSteps.length > 0 && (
                                        <div className="ml-1 mb-3">
                                            <ThinkingProcess
                                                steps={message.thinkingSteps}
                                                isComplete={!message.meta || message.meta === undefined}
                                                needsUserDecision={message.needsUserDecision}
                                                decisionMessage={message.decisionMessage}
                                                onResume={() => onResume?.(searchMode)}
                                                onHitClick={(hit) => {
                                                    if (onPreviewReference) {
                                                        onPreviewReference({
                                                            fileId: hit.fileId,
                                                            score: hit.score,
                                                            summary: hit.summary,
                                                            snippet: hit.snippet,
                                                            metadata: hit.metadata || {},
                                                            chunkId: hit.chunkId,
                                                        });
                                                    }
                                                }}
                                            />
                                        </div>
                                    )}

                                    {/* Show RecalledContext only when there are no thinking steps (they already show the same info) */}
                                    {!isUser && (!message.thinkingSteps || message.thinkingSteps.length === 0) && message.references && message.references.length > 0 && (
                                        <div className="ml-1 mb-3">
                                            <RecalledContext
                                                references={message.references}
                                                onPreview={(ref) => onPreviewReference?.(ref)}
                                                isComplete={!message.analysisProgress || message.analysisProgress.isComplete}
                                                analysisProgress={message.analysisProgress}
                                            />
                                        </div>
                                    )}

                                    <div
                                        className={cn(
                                            "rounded-2xl px-5 py-3.5 text-sm leading-relaxed shadow-sm",
                                            isUser
                                                ? "bg-primary text-primary-foreground"
                                                : "bg-muted/50 text-foreground border"
                                        )}
                                    >
                                        {!isUser && !message.text && message.meta ? (
                                            <div className="flex items-center gap-2 py-1">
                                                <LoadingDots label={message.meta} />
                                            </div>
                                        ) : (
                                            renderMessageText(message.text, message.references)
                                        )}
                                    </div>

                                    {!isUser && message.meta && message.text && (
                                        <div className="ml-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                                            {message.meta === 'Thinking...' ? (
                                                <span className="flex items-center gap-1 text-primary">
                                                    <LoadingDots label="Thinking" />
                                                </span>
                                            ) : (
                                                <span>{message.meta}</span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
                {loading && messages[messages.length - 1]?.role === 'user' && (
                    <div className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl bg-muted/50 px-5 py-3.5 border">
                            <LoadingDots label="Thinking" />
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            <div className={cn(
                "border-t p-4 relative z-10",
                isCocoaSkin ? "bg-gradient-to-t from-[#b8956f]/30 to-transparent border-[#c9a87c]/30" : "bg-background"
            )}>
                <form onSubmit={handleSubmit} className="relative mx-auto max-w-4xl">
                    {suggestionQuery !== null && filteredFiles.length > 0 && (
                        <div className={cn(
                            "absolute bottom-full left-0 mb-2 w-64 rounded-lg border p-1 shadow-md",
                            isCocoaSkin ? "bg-[#f5e6d3] border-[#c9a87c]" : "bg-popover"
                        )}>
                            {filteredFiles.map((file, index) => (
                                <button
                                    key={file.id}
                                    type="button"
                                    onClick={() => {
                                        const lastAt = input.lastIndexOf('@');
                                        const nameToInsert = file.name.includes(' ') ? `"${file.name}"` : file.name;
                                        const newValue = input.slice(0, lastAt) + `@${nameToInsert} ` + input.slice(lastAt + 1 + suggestionQuery.length);
                                        setInput(newValue);
                                        setSuggestionQuery(null);
                                        textareaRef.current?.focus();
                                    }}
                                    className={cn(
                                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm",
                                        isCocoaSkin
                                            ? index === selectedIndex
                                                ? "bg-[#c9a87c]/30 text-[#5c4a2a]"
                                                : "text-[#5c4a2a] hover:bg-[#c9a87c]/20"
                                            : index === selectedIndex
                                                ? "bg-accent text-accent-foreground"
                                                : "text-popover-foreground hover:bg-accent/50"
                                    )}
                                >
                                    <FileText className="h-3.5 w-3.5 opacity-70" />
                                    <span className="truncate">{file.name}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    <textarea
                        ref={textareaRef}
                        rows={1}
                        className={cn(
                            "w-full resize-none rounded-xl border py-3.5 pl-4 pr-12 text-sm focus:outline-none overflow-y-auto no-scrollbar",
                            isCocoaSkin
                                ? "cocoa-chat-input bg-white/70 dark:bg-[#2a1f14]/80 border-[#c9a87c] placeholder:text-[#8b6914]/60 focus:border-[#b8956f] focus:ring-1 focus:ring-[#b8956f]/50"
                                : "bg-muted/30 placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                        )}
                        placeholder="Message..."
                        value={input}
                        onChange={(e) => {
                            const newValue = e.target.value;
                            setInput(newValue);

                            const lastAt = newValue.lastIndexOf('@');
                            if (lastAt !== -1) {
                                const textAfterAt = newValue.slice(lastAt + 1);
                                // Only show suggestions if there are no spaces after @ (simple heuristic)
                                if (!textAfterAt.includes(' ')) {
                                    setSuggestionQuery(textAfterAt);
                                    setSelectedIndex(0);
                                    return;
                                }
                            }
                            setSuggestionQuery(null);
                        }}
                        onKeyDown={(e) => {
                            if (suggestionQuery !== null && filteredFiles.length > 0) {
                                if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredFiles.length - 1));
                                    return;
                                }
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setSelectedIndex(prev => (prev < filteredFiles.length - 1 ? prev + 1 : 0));
                                    return;
                                }
                                if (e.key === 'Enter' || e.key === 'Tab') {
                                    e.preventDefault();
                                    const file = filteredFiles[selectedIndex];
                                    if (file) {
                                        const lastAt = input.lastIndexOf('@');
                                        // We assume suggestionQuery is valid here
                                        const queryLen = suggestionQuery?.length || 0;
                                        const nameToInsert = file.name.includes(' ') ? `"${file.name}"` : file.name;
                                        const newValue = input.slice(0, lastAt) + `@${nameToInsert} ` + input.slice(lastAt + 1 + queryLen);
                                        setInput(newValue);
                                        setSuggestionQuery(null);
                                    }
                                    return;
                                }
                                if (e.key === 'Escape') {
                                    setSuggestionQuery(null);
                                    return;
                                }
                            }

                            // Only send on Enter if not composing (IME) and not holding Shift
                            if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
                                e.preventDefault();
                                handleSubmit(e);
                            }
                        }}
                        onCompositionStart={() => { isComposingRef.current = true; }}
                        onCompositionEnd={() => { isComposingRef.current = false; }}
                        style={{ minHeight: '48px', maxHeight: '200px' }}
                    />
                    <button
                        type="submit"
                        disabled={!hasInput || loading}
                        className={cn(
                            "absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 transition-colors",
                            isCocoaSkin
                                ? hasInput && !loading
                                    ? "cocoa-send-btn"
                                    : "bg-[#c9a87c]/30 text-[#8b6914]/50 cursor-not-allowed"
                                : hasInput && !loading
                                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                    : "bg-muted text-muted-foreground opacity-50 cursor-not-allowed"
                        )}
                    >
                        <Send className="h-4 w-4" />
                    </button>
                </form>

                {/* Search Mode Selector and Vision Toggle */}
                <div className="mx-auto max-w-4xl mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        {/* Vision Toggle */}
                        <button
                            type="button"
                            onClick={() => setUseVisionForAnswer(!useVisionForAnswer)}
                            title={useVisionForAnswer 
                                ? "Vision Mode: ON - Using VLM to analyze page images" 
                                : "Vision Mode: OFF - Using extracted text chunks"}
                            className={cn(
                                "flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium transition-all",
                                useVisionForAnswer
                                    ? isCocoaSkin
                                        ? "bg-[#8b6914] text-white border border-[#8b6914]"
                                        : "bg-primary text-primary-foreground border border-primary"
                                    : isCocoaSkin
                                        ? "text-[#8b6914]/80 hover:bg-[#c9a87c]/20 border border-transparent hover:border-[#c9a87c]/40"
                                        : "text-muted-foreground hover:bg-muted/50 border border-transparent hover:border-border"
                            )}
                        >
                            <Eye className="h-3 w-3" />
                            <span>Vision</span>
                        </button>

                        {/* Search Mode Selector */}
                        <div className="relative" ref={modeDropdownRef}>
                            <button
                                type="button"
                                onClick={() => setIsModeDropdownOpen(!isModeDropdownOpen)}
                                className={cn(
                                    "flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium transition-all",
                                    isCocoaSkin
                                        ? "text-[#8b6914]/80 hover:bg-[#c9a87c]/20 border border-transparent hover:border-[#c9a87c]/40"
                                        : "text-muted-foreground hover:bg-muted/50 border border-transparent hover:border-border"
                                )}
                            >
                            {(() => {
                                const config = SEARCH_MODE_CONFIG[searchMode];
                                const Icon = config.icon;
                                return (
                                    <>
                                        <Icon className="h-3 w-3" />
                                        <span>{config.label}</span>
                                        <ChevronDown className={cn(
                                            "h-3 w-3 transition-transform",
                                            isModeDropdownOpen && "rotate-180"
                                        )} />
                                    </>
                                );
                            })()}
                        </button>

                        {/* Dropdown Menu */}
                        {isModeDropdownOpen && (
                            <div className={cn(
                                "absolute bottom-full left-0 mb-1 w-48 rounded-lg border shadow-lg py-1 z-50",
                                isCocoaSkin
                                    ? "bg-[#f5e6d3] border-[#c9a87c]/50 shadow-[#8b6914]/10"
                                    : "bg-popover border-border"
                            )}>
                                {(Object.keys(SEARCH_MODE_CONFIG) as SearchMode[]).map((mode) => {
                                    const config = SEARCH_MODE_CONFIG[mode];
                                    const Icon = config.icon;
                                    const isActive = searchMode === mode;

                                    return (
                                        <button
                                            key={mode}
                                            type="button"
                                            onClick={() => {
                                                setSearchMode(mode);
                                                setIsModeDropdownOpen(false);
                                            }}
                                            className={cn(
                                                "w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors",
                                                isCocoaSkin
                                                    ? isActive
                                                        ? "bg-[#c9a87c]/30 text-[#5c4a2a]"
                                                        : "text-[#5c4a2a] hover:bg-[#c9a87c]/20"
                                                    : isActive
                                                        ? "bg-accent text-accent-foreground"
                                                        : "text-popover-foreground hover:bg-accent/50"
                                            )}
                                        >
                                            <Icon className={cn(
                                                "h-4 w-4 mt-0.5 flex-shrink-0",
                                                isActive
                                                    ? isCocoaSkin ? "text-[#8b6914]" : "text-primary"
                                                    : "opacity-60"
                                            )} />
                                            <div className="flex-1 min-w-0">
                                                <div className={cn(
                                                    "text-xs font-medium",
                                                    isActive && (isCocoaSkin ? "text-[#5c4a2a]" : "text-foreground")
                                                )}>
                                                    {config.label}
                                                </div>
                                                <div className={cn(
                                                    "text-[10px] mt-0.5 leading-tight",
                                                    isCocoaSkin ? "text-[#8b6914]/70" : "text-muted-foreground"
                                                )}>
                                                    {config.description}
                                                </div>
                                            </div>
                                            {isActive && (
                                                <div className={cn(
                                                    "h-1.5 w-1.5 rounded-full mt-1.5",
                                                    isCocoaSkin ? "bg-[#8b6914]" : "bg-primary"
                                                )} />
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        </div>
                    </div>

                    <div className={cn(
                        "text-[10px]",
                        isCocoaSkin ? "text-[#8b6914]/70" : "text-muted-foreground"
                    )}>
                        AI can make mistakes. Check important info.
                    </div>
                </div>
            </div>
        </div>
    );
}
