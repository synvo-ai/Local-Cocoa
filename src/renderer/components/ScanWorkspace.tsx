/**
 * Enhanced ScanWorkspace Component
 * 
 * Features:
 * - Scope selection with smart recommendations
 * - Configurable exclusions
 * - File type filtering (Code type excluded)
 * - Folder tree view with pruning
 * - Enhanced progress UI with stages
 * - Origin/source labels
 */

import { useState, useEffect, useCallback, useMemo, useRef, CSSProperties } from 'react';
import {
    FileText,
    Image,
    Video,
    Music,
    Archive,
    File,
    Folder,
    FolderOpen,
    Clock,
    HardDrive,
    Play,
    Square,
    RefreshCw,
    ExternalLink,
    ChevronRight,
    ChevronDown,
    Filter,
    SortAsc,
    SortDesc,
    Check,
    Cloud,
    Download,
    Edit3,
    Globe,
    BookOpen,
    AlertCircle,
    X,
    FileBarChart,
    CheckSquare,
    Square as SquareIcon,
    Loader2,
    ArrowUp,
    Search,
} from 'lucide-react';
import { YearInReviewModal } from './YearInReviewModal';
import { cn } from '../lib/utils';
import type {
    FileKind,
    ScannedFile,
    ScanProgress,
    ScanScope,
    FolderNode,
    FileOrigin,
    IndexedFile,
} from '../types';

// ============================================
// Index Status Types
// ============================================

type IndexStatus = 'not_indexed' | 'fast' | 'deep' | 'pending' | 'error';

interface _ScannedFileWithStatus extends ScannedFile {
    indexStatus?: IndexStatus;
    indexedFileId?: string;
}

// ============================================
// Time Range Options
// ============================================

type TimeRange = '24h' | '1w' | '1m' | '3m' | '6m' | 'year2025' | 'all' | 'custom';

interface TimeRangeOption {
    id: TimeRange;
    label: string;
    year?: number; // For year-based options
    days?: number | null; // For relative options
}

const TIME_RANGES: TimeRangeOption[] = [
    { id: '24h', label: 'Last 24h', days: 1 },
    { id: '1w', label: 'Last Week', days: 7 },
    { id: '1m', label: 'Last Month', days: 30 },
    { id: '3m', label: 'Last 3 Months', days: 90 },
    { id: '6m', label: 'Last 6 Months', days: 180 },
    { id: 'year2025', label: 'Year 2025', year: 2025 },
    { id: 'all', label: 'All Time', days: null },
    { id: 'custom', label: 'Custom' },
];

// Session storage key for persisting time range selection
const TIME_RANGE_KEY = 'synvo-scan-time-range';

// Helper to get the "size" of a time range in days (for comparison)
// Returns Infinity for 'all', null for 'custom' (needs special handling), or number of days
function getTimeRangeDays(rangeId: TimeRange, customFrom?: string, customTo?: string): number | null {
    const range = TIME_RANGES.find(t => t.id === rangeId);
    if (!range) return null;

    if (rangeId === 'all') return Infinity;
    if (rangeId === 'custom' && customFrom) {
        const from = new Date(customFrom).getTime();
        const to = customTo ? new Date(customTo).getTime() : Date.now();
        return Math.ceil((to - from) / (24 * 60 * 60 * 1000));
    }
    if (range.year) {
        // Year range is roughly 365 days, but treat it specially
        return 365;
    }
    return range.days ?? null;
}

// Check if the selected time range exceeds the scanned time range
function isSelectedRangeExceedingScanned(
    selectedRange: TimeRange,
    scannedRange: TimeRange | null,
    selectedCustomFrom?: string,
    selectedCustomTo?: string,
    scannedCustomFrom?: string,
    scannedCustomTo?: string
): boolean {
    if (!scannedRange) return false; // No scan yet
    if (selectedRange === scannedRange) {
        // Same range type, check custom dates if applicable
        if (selectedRange === 'custom') {
            const selectedFrom = selectedCustomFrom ? new Date(selectedCustomFrom).getTime() : Date.now();
            const scannedFrom = scannedCustomFrom ? new Date(scannedCustomFrom).getTime() : Date.now();
            const selectedTo = selectedCustomTo ? new Date(selectedCustomTo).getTime() : Date.now();
            const scannedTo = scannedCustomTo ? new Date(scannedCustomTo).getTime() : Date.now();
            // Exceeds if selected range starts earlier or ends later
            return selectedFrom < scannedFrom || selectedTo > scannedTo;
        }
        return false;
    }

    // Special case: year2025 vs relative ranges
    // If scanned with year2025, selecting relative ranges might exceed if they go beyond 2025
    if (scannedRange === 'year2025') {
        // Only allow filtering within year 2025
        if (selectedRange === 'all') return true;
        if (selectedRange === 'custom') {
            const from = selectedCustomFrom ? new Date(selectedCustomFrom) : new Date();
            const to = selectedCustomTo ? new Date(selectedCustomTo) : new Date();
            return from.getFullYear() < 2025 || to.getFullYear() > 2025;
        }
        // Relative ranges like 'last week' - check if current date minus days goes before 2025
        const range = TIME_RANGES.find(t => t.id === selectedRange);
        if (range?.days) {
            const cutoff = new Date(Date.now() - range.days * 24 * 60 * 60 * 1000);
            // If cutoff is before 2025 or current date is after 2025, it exceeds
            return cutoff.getFullYear() < 2025;
        }
        return false;
    }

    // If scanned with 'all', nothing can exceed it
    if (scannedRange === 'all') return false;

    // Compare days for relative ranges
    const selectedDays = getTimeRangeDays(selectedRange, selectedCustomFrom, selectedCustomTo);
    const scannedDays = getTimeRangeDays(scannedRange, scannedCustomFrom, scannedCustomTo);

    if (selectedDays === null || scannedDays === null) return true; // Can't compare, assume exceeds

    return selectedDays > scannedDays;
}

// ============================================
// File Categories (Code type REMOVED)
// ============================================

interface FileCategory {
    id: FileKind | 'all';
    label: string;
    icon: React.ComponentType<{ className?: string }>;
}

// Code type intentionally excluded
const FILE_CATEGORIES: FileCategory[] = [
    { id: 'all', label: 'All Files', icon: Folder },
    { id: 'document', label: 'Documents', icon: FileText },
    { id: 'image', label: 'Images', icon: Image },
    { id: 'video', label: 'Videos', icon: Video },
    { id: 'audio', label: 'Audio', icon: Music },
    { id: 'archive', label: 'Archives', icon: Archive },
    { id: 'book', label: 'Books', icon: BookOpen },
    { id: 'other', label: 'Other', icon: File },
];

// ============================================
// Sort Options
// ============================================

type SortField = 'modifiedAt' | 'size' | 'name';
type SortOrder = 'asc' | 'desc';

// ============================================
// Helper Functions
// ============================================

function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        if (diffHours === 0) {
            const diffMins = Math.floor(diffMs / (1000 * 60));
            return diffMins <= 1 ? 'Just now' : `${diffMins}m ago`;
        }
        return `${diffHours}h ago`;
    } else if (diffDays === 1) {
        return 'Yesterday';
    } else if (diffDays < 7) {
        return `${diffDays} days ago`;
    } else if (diffDays < 30) {
        const weeks = Math.floor(diffDays / 7);
        return `${weeks}w ago`;
    } else if (diffDays < 365) {
        const months = Math.floor(diffDays / 30);
        return `${months}mo ago`;
    } else {
        return date.toLocaleDateString();
    }
}

function getFileIcon(kind: FileKind): React.ComponentType<{ className?: string }> {
    const category = FILE_CATEGORIES.find(c => c.id === kind);
    return category?.icon ?? File;
}

function getOriginIcon(origin: FileOrigin): React.ComponentType<{ className?: string }> {
    switch (origin) {
        case 'downloaded': return Download;
        case 'synced': return Cloud;
        case 'created_here': return Edit3;
        default: return Globe;
    }
}

function getOriginLabel(origin: FileOrigin): string {
    switch (origin) {
        case 'downloaded': return 'Downloaded';
        case 'synced': return 'Synced';
        case 'created_here': return 'Created';
        default: return 'Unknown';
    }
}

function getOriginColor(origin: FileOrigin): string {
    switch (origin) {
        case 'downloaded': return 'text-blue-500 bg-blue-500/10';
        case 'synced': return 'text-purple-500 bg-purple-500/10';
        case 'created_here': return 'text-green-500 bg-green-500/10';
        default: return 'text-gray-500 bg-gray-500/10';
    }
}

// ============================================
// Index Status Badge
// ============================================

function IndexStatusBadge({ status }: { status: IndexStatus }) {
    switch (status) {
        case 'fast':
            return (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                    Fast
                </span>
            );
        case 'deep':
            return (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
                    Deep
                </span>
            );
        case 'pending':
            return (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 animate-pulse">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    Indexing
                </span>
            );
        case 'error':
            return (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-destructive/10 text-destructive">
                    Error
                </span>
            );
        default:
            return null;
    }
}

// ============================================
// Index Dropdown Button
// ============================================

interface IndexDropdownProps {
    label: string;
    options: { label: string; value: string }[];
    onSelect: (value: string) => void;
    disabled?: boolean;
    variant?: 'default' | 'small';
    className?: string;
}

function IndexDropdown({
    label,
    options,
    onSelect,
    disabled,
    variant = 'default',
    className,
}: IndexDropdownProps) {
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
            const rect = buttonRef.current.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            setOpenUpward(spaceBelow < 100);
        }
        setIsOpen(!isOpen);
    };

    return (
        <div className={cn("relative", className)} ref={dropdownRef}>
            <button
                ref={buttonRef}
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    handleToggle();
                }}
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
                    "absolute right-0 z-50 min-w-[120px] rounded-md border bg-popover p-1 shadow-md",
                    openUpward ? "bottom-full mb-1" : "top-full mt-1"
                )}>
                    {options.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
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

// ============================================
// Sub-Components
// ============================================

interface ScopeSummaryProps {
    scope: ScanScope;
    onNavigateToSettings?: () => void;
}

function ScopeSummary({ scope, onNavigateToSettings }: ScopeSummaryProps) {
    const handleNavigateToSettings = () => {
        // Dispatch navigation event to main app
        const event = new CustomEvent('synvo:navigate', { detail: { view: 'settings' } });
        window.dispatchEvent(event);
        // Also dispatch a settings tab event for the scan tab
        setTimeout(() => {
            const tabEvent = new CustomEvent('synvo:settings-tab', { detail: { tab: 'scan' } });
            window.dispatchEvent(tabEvent);
        }, 100);
        onNavigateToSettings?.();
    };

    if (scope.directories.length === 0) {
        return (
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-dashed bg-muted/30">
                <AlertCircle className="h-4 w-4 text-amber-500" />
                <span className="text-sm text-muted-foreground">No folders configured.</span>
                <button
                    onClick={handleNavigateToSettings}
                    className="text-sm text-primary hover:underline"
                >
                    Configure in Settings →
                </button>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Folder className="h-4 w-4" />
                <span>Scanning:</span>
            </div>
            {scope.directories.slice(0, 4).map((dir) => (
                <span
                    key={dir.path}
                    className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium",
                        dir.isCloudSync
                            ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                            : "bg-primary/10 text-primary"
                    )}
                >
                    {dir.isCloudSync ? <Cloud className="h-3 w-3" /> : <Folder className="h-3 w-3" />}
                    {dir.label}
                </span>
            ))}
            {scope.directories.length > 4 && (
                <span className="text-xs text-muted-foreground">
                    +{scope.directories.length - 4} more
                </span>
            )}
            <button
                onClick={handleNavigateToSettings}
                className="text-xs text-primary hover:underline ml-auto"
            >
                Edit
            </button>
        </div>
    );
}

interface FolderTreeNodeProps {
    node: FolderNode;
    level: number;
    onOpenFile: (file: ScannedFile) => void;
    selectedKind: FileKind | 'all';
}

function FolderTreeNode({ node, level, onOpenFile, selectedKind }: FolderTreeNodeProps) {
    const [isExpanded, setIsExpanded] = useState(level < 2);

    // Filter files by selected kind
    const visibleFiles = selectedKind === 'all'
        ? node.files
        : node.files.filter(f => f.kind === selectedKind);

    // Filter children that have visible files
    const visibleChildren = node.children.filter(child => {
        if (selectedKind === 'all') return child.totalFileCount > 0;
        // Need to check recursively - simplified: just show if totalFileCount > 0
        return child.totalFileCount > 0;
    });

    const hasContent = visibleFiles.length > 0 || visibleChildren.length > 0;
    if (!hasContent) return null;

    return (
        <div className="select-none">
            {/* Folder header */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/50 transition-colors"
                style={{ paddingLeft: `${8 + level * 16}px` }}
            >
                <ChevronRight className={cn(
                    "h-3.5 w-3.5 text-muted-foreground transition-transform flex-shrink-0",
                    isExpanded && "rotate-90"
                )} />
                {isExpanded ? (
                    <FolderOpen className="h-4 w-4 text-primary flex-shrink-0" />
                ) : (
                    <Folder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                )}
                <span className="text-sm font-medium truncate flex-1 text-left">{node.name}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] text-muted-foreground">
                        {node.totalFileCount} file{node.totalFileCount !== 1 ? 's' : ''}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">
                        {formatRelativeTime(node.latestModified)}
                    </span>
                </div>
            </button>

            {/* Expanded content */}
            {isExpanded && (
                <div className="ml-2">
                    {/* Child folders */}
                    {visibleChildren.map((child) => (
                        <FolderTreeNode
                            key={child.path}
                            node={child}
                            level={level + 1}
                            onOpenFile={onOpenFile}
                            selectedKind={selectedKind}
                        />
                    ))}

                    {/* Files */}
                    {visibleFiles.map((file) => {
                        const Icon = getFileIcon(file.kind);
                        const OriginIcon = getOriginIcon(file.origin || 'unknown');

                        return (
                            <div
                                key={file.path}
                                className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/50 transition-colors"
                                style={{ paddingLeft: `${24 + level * 16}px` }}
                            >
                                <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                <span className="text-sm truncate flex-1">{file.name}</span>

                                {/* Origin badge */}
                                {file.origin && file.origin !== 'unknown' && (
                                    <span className={cn(
                                        "flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium",
                                        getOriginColor(file.origin)
                                    )}>
                                        <OriginIcon className="h-2.5 w-2.5" />
                                        {getOriginLabel(file.origin)}
                                    </span>
                                )}

                                <span className="text-[10px] text-muted-foreground">{formatSize(file.size)}</span>
                                <span className="text-[10px] text-muted-foreground/60">{formatRelativeTime(file.modifiedAt)}</span>

                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onOpenFile(file);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-all"
                                >
                                    <ExternalLink className="h-3 w-3" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ============================================
// Main Component
// ============================================

interface ScanWorkspaceProps {
    className?: string;
}

// Session storage keys for persisting scan results
const SCAN_RESULTS_KEY = 'synvo-scan-results';
const SCAN_PROGRESS_KEY = 'synvo-scan-progress';

export function ScanWorkspace({ className }: ScanWorkspaceProps) {
    // Scope state (loaded from settings)
    const [scope, setScope] = useState<ScanScope>({
        mode: 'smart',
        directories: [],
        useRecommendedExclusions: true,
        customExclusions: [],
    });

    // Filter state - persist time range selection
    const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>(() => {
        try {
            const saved = sessionStorage.getItem(TIME_RANGE_KEY);
            if (saved && ['24h', '1w', '1m', '3m', '6m', 'year2025', 'all', 'custom'].includes(saved)) {
                return saved as TimeRange;
            }
        } catch { /* ignore */ }
        return '1w';
    });
    const [customDateFrom, setCustomDateFrom] = useState<string>('');
    const [customDateTo, setCustomDateTo] = useState<string>('');
    const [showCustomPicker, setShowCustomPicker] = useState(false);

    // Track what time range was used for the last scan
    const [scannedTimeRange, setScannedTimeRange] = useState<TimeRange | null>(null);
    const [scannedCustomDates, setScannedCustomDates] = useState<{ from: string; to: string } | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<FileKind | 'all'>('all');
    const [sortField, setSortField] = useState<SortField>('modifiedAt');
    const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

    // Scan state - load from sessionStorage if available
    const [scanProgress, setScanProgress] = useState<ScanProgress>(() => {
        try {
            const saved = sessionStorage.getItem(SCAN_PROGRESS_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                // Only restore if it was a completed scan
                if (parsed.status === 'completed') {
                    return parsed;
                }
            }
        } catch { /* ignore */ }
        return {
            status: 'idle',
            scannedCount: 0,
            matchedCount: 0,
            skippedCount: 0,
        };
    });
    const [scannedFiles, setScannedFiles] = useState<ScannedFile[]>(() => {
        try {
            const saved = sessionStorage.getItem(SCAN_RESULTS_KEY);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch { /* ignore */ }
        return [];
    });
    const [_folderTree, setFolderTree] = useState<FolderNode[]>([]);
    const [scanStartTime, setScanStartTime] = useState<number | null>(null);
    const [cancelFn, setCancelFn] = useState<(() => void) | null>(null);

    // Path ticker for progress display
    const [currentPathDisplay, setCurrentPathDisplay] = useState<string>('');
    const _pathTickerRef = useRef<NodeJS.Timeout | null>(null);

    // Buffer for files during scanning - reduces React re-renders
    const filesBufferRef = useRef<ScannedFile[]>([]);
    const lastFlushTimeRef = useRef<number>(0);
    const flushIntervalMs = 500; // Flush buffer every 500ms for smoother UI

    // Dismiss completed banner
    const [showCompletedBanner, setShowCompletedBanner] = useState(true);

    // Year report modal state
    const [showYearReport, setShowYearReport] = useState(false);
    const [reportYear, setReportYear] = useState<number>(new Date().getFullYear());
    const [hasViewedReport, setHasViewedReport] = useState(() => {
        try {
            return sessionStorage.getItem('synvo-viewed-2025-report') === 'true';
        } catch { return false; }
    });

    // Index status tracking
    const [indexedFilesMap, setIndexedFilesMap] = useState<Map<string, IndexedFile>>(new Map());
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
    const [indexingFiles, setIndexingFiles] = useState<Set<string>>(new Set());
    const [statusFilter, setStatusFilter] = useState<'all' | 'not_indexed' | 'indexed'>('all');
    const [searchQuery, setSearchQuery] = useState('');

    // Check if selected time range exceeds scanned range
    const isExceedingScanRange = useMemo(() => {
        return isSelectedRangeExceedingScanned(
            selectedTimeRange,
            scannedTimeRange,
            customDateFrom,
            customDateTo,
            scannedCustomDates?.from,
            scannedCustomDates?.to
        );
    }, [selectedTimeRange, scannedTimeRange, customDateFrom, customDateTo, scannedCustomDates]);

    // Check if Year 2025 report is valid (only if scanned with year2025 or all)
    const isYear2025ReportValid = useMemo(() => {
        return scannedTimeRange === 'year2025' || scannedTimeRange === 'all';
    }, [scannedTimeRange]);

    // Pagination for performance - only render visible files
    const ITEMS_PER_PAGE = 100;
    const [displayLimit, setDisplayLimit] = useState(ITEMS_PER_PAGE);

    // Save scan results to sessionStorage ONLY when scan completes (not during scanning)
    // This avoids performance issues from serializing 15k+ files on every batch
    useEffect(() => {
        if (scanProgress.status === 'completed' && scannedFiles.length > 0) {
            try {
                sessionStorage.setItem(SCAN_RESULTS_KEY, JSON.stringify(scannedFiles));
                sessionStorage.setItem(SCAN_PROGRESS_KEY, JSON.stringify(scanProgress));
            } catch { /* ignore quota errors */ }
        }
    }, [scanProgress.status, scannedFiles]);

    // Persist time range selection
    useEffect(() => {
        try {
            sessionStorage.setItem(TIME_RANGE_KEY, selectedTimeRange);
        } catch { /* ignore */ }
    }, [selectedTimeRange]);

    // Load indexed files to check status (paginated, max 500 per request)
    const loadIndexedFiles = useCallback(async () => {
        const api = window.api;
        if (!api?.listFiles) return;

        try {
            const map = new Map<string, IndexedFile>();
            let offset = 0;
            const limit = 500;
            let hasMore = true;

            while (hasMore) {
                const response = await api.listFiles(limit, offset);
                for (const file of response.files) {
                    const fullPath = (file as any).fullPath || file.path;
                    map.set(fullPath, file as IndexedFile);
                }
                offset += response.files.length;
                hasMore = response.files.length === limit && offset < response.total;
            }

            setIndexedFilesMap(map);
        } catch (error) {
            console.error('Failed to load indexed files:', error);
        }
    }, []);

    // Load indexed files on mount and after scan completes
    useEffect(() => {
        loadIndexedFiles();
    }, [loadIndexedFiles]);

    // Reload indexed files when scan completes
    useEffect(() => {
        if (scanProgress.status === 'completed') {
            loadIndexedFiles();
        }
    }, [scanProgress.status, loadIndexedFiles]);

    // Get index status for a file
    const getIndexStatus = useCallback((filePath: string): IndexStatus => {
        if (indexingFiles.has(filePath)) {
            return 'pending';
        }

        const indexed = indexedFilesMap.get(filePath);
        if (!indexed) {
            return 'not_indexed';
        }

        if (indexed.indexStatus === 'error') {
            return 'error';
        }

        // Check chunk_strategy to determine fast/deep
        const metadata = indexed.metadata as Record<string, unknown> | undefined;
        if (metadata?.chunk_strategy) {
            const strategy = metadata.chunk_strategy as string;
            if (strategy.includes('_fine')) return 'deep';
            if (strategy.includes('_fast')) return 'fast';
        }

        // Fallback to pdf_vision_mode
        if (metadata?.pdf_vision_mode === 'deep') return 'deep';
        if (metadata?.pdf_vision_mode === 'fast') return 'fast';

        return 'fast'; // Default to fast if indexed
    }, [indexedFilesMap, indexingFiles]);

    // Index a single file
    const handleIndexFile = useCallback(async (filePath: string, mode: 'fast' | 'deep') => {
        const api = window.api;
        if (!api?.runIndex || !api?.addFolder || !api?.runStagedIndex) return;

        setIndexingFiles(prev => new Set(prev).add(filePath));

        try {
            // Get the parent directory of the file
            const parentDir = filePath.replace(/[\\/]/g, '/').split('/').slice(0, -1).join('/');

            // First, ensure the parent folder is registered with 'manual' scan mode
            // This prevents the folder from being scanned during startup/poll refresh
            try {
                await api.addFolder(parentDir, undefined, 'manual');
            } catch (folderError) {
                // Folder might already exist, that's fine
                console.log('Folder may already exist:', folderError);
            }

            // Use staged API for both fast and deep modes
            // For deep mode, enable deep stage first, then run staged index
            if (mode === 'deep' && (api as any).startDeepIndexing) {
                await (api as any).startDeepIndexing();
            }
            await api.runStagedIndex({
                folders: [parentDir],
                files: [filePath],
                mode: 'reindex', // Always use reindex to reset file stage
            });
            // Reload indexed files after indexing
            await loadIndexedFiles();
        } catch (error) {
            console.error('Failed to index file:', error);
        } finally {
            setIndexingFiles(prev => {
                const next = new Set(prev);
                next.delete(filePath);
                return next;
            });
        }
    }, [loadIndexedFiles]);

    // Index multiple selected files
    const handleIndexSelected = useCallback(async (mode: 'fast' | 'deep') => {
        const api = window.api;
        if (!api?.runIndex || !api?.addFolder || !api?.runStagedIndex || selectedFiles.size === 0) return;

        const filePaths = Array.from(selectedFiles);

        // Mark all as indexing
        setIndexingFiles(prev => {
            const next = new Set(prev);
            filePaths.forEach(p => next.add(p));
            return next;
        });

        try {
            // Get unique parent directories
            const parentDirs = [...new Set(filePaths.map(fp => fp.replace(/[\\/]/g, '/').split('/').slice(0, -1).join('/')))];

            // Ensure all parent folders are registered with 'manual' scan mode
            // This prevents folders from being scanned during startup/poll refresh
            for (const dir of parentDirs) {
                try {
                    await api.addFolder(dir, undefined, 'manual');
                } catch (folderError) {
                    // Folder might already exist, that's fine
                    console.log('Folder may already exist:', folderError);
                }
            }

            // Use staged API for both fast and deep modes
            // For deep mode, enable deep stage first, then run staged index
            if (mode === 'deep' && (api as any).startDeepIndexing) {
                await (api as any).startDeepIndexing();
            }
            await api.runStagedIndex({
                folders: parentDirs,
                files: filePaths,
            });
            // Reload indexed files and clear selection
            await loadIndexedFiles();
            setSelectedFiles(new Set());
        } catch (error) {
            console.error('Failed to index files:', error);
        } finally {
            setIndexingFiles(prev => {
                const next = new Set(prev);
                filePaths.forEach(p => next.delete(p));
                return next;
            });
        }
    }, [selectedFiles, loadIndexedFiles]);

    // Toggle file selection
    const toggleFileSelection = useCallback((filePath: string) => {
        setSelectedFiles(prev => {
            const next = new Set(prev);
            if (next.has(filePath)) {
                next.delete(filePath);
            } else {
                next.add(filePath);
            }
            return next;
        });
    }, []);

    // Load settings on mount
    useEffect(() => {
        const loadSettings = async () => {
            const api = window.api;
            if (!api?.getScanSettings) return;

            try {
                const settings = await api.getScanSettings();
                if (settings?.scope) {
                    setScope(settings.scope);
                }
            } catch (error) {
                console.error('Failed to load scan settings:', error);
            }
        };

        loadSettings();

        // Re-load when settings might have changed (e.g., returning from Settings)
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                loadSettings();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    // Calculate category counts (only from supported types, Code excluded)
    const categoryCounts = useMemo(() => {
        const counts: Record<string, number> = { all: 0 };
        for (const category of FILE_CATEGORIES) {
            if (category.id !== 'all') {
                counts[category.id] = 0;
            }
        }

        for (const file of scannedFiles) {
            // Skip code files entirely
            if (file.kind === 'code') continue;

            counts.all++;
            if (counts[file.kind] !== undefined) {
                counts[file.kind]++;
            }
        }

        return counts;
    }, [scannedFiles]);

    // Calculate category sizes
    const categorySizes = useMemo(() => {
        const sizes: Record<string, number> = { all: 0 };
        for (const category of FILE_CATEGORIES) {
            if (category.id !== 'all') {
                sizes[category.id] = 0;
            }
        }

        for (const file of scannedFiles) {
            if (file.kind === 'code') continue;

            sizes.all += file.size;
            if (sizes[file.kind] !== undefined) {
                sizes[file.kind] += file.size;
            }
        }

        return sizes;
    }, [scannedFiles]);

    // Filter and sort files (excluding code)
    const filteredFiles = useMemo(() => {
        // Start with all non-code files
        let files = scannedFiles.filter(f => f.kind !== 'code');

        // Apply category filter
        if (selectedCategory !== 'all') {
            files = files.filter(f => f.kind === selectedCategory);
        }

        // Apply status filter
        if (statusFilter !== 'all') {
            files = files.filter(f => {
                const status = getIndexStatus(f.path);
                if (statusFilter === 'not_indexed') {
                    return status === 'not_indexed' || status === 'error';
                } else {
                    return status === 'fast' || status === 'deep' || status === 'pending';
                }
            });
        }

        // Apply search query filter
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            files = files.filter(f => 
                f.name.toLowerCase().includes(query) ||
                f.path.toLowerCase().includes(query)
            );
        }

        // Apply time range filter (client-side filtering)
        // Only filter if selected range is within or equal to scanned range
        // If selected range exceeds scanned range, skip filtering (show all scanned files)
        const exceedsScannedRange = isSelectedRangeExceedingScanned(
            selectedTimeRange,
            scannedTimeRange,
            customDateFrom,
            customDateTo,
            scannedCustomDates?.from,
            scannedCustomDates?.to
        );

        if (!exceedsScannedRange) {
            const timeRange = TIME_RANGES.find(t => t.id === selectedTimeRange);
            if (timeRange) {
                if (selectedTimeRange === 'custom' && customDateFrom) {
                    // Custom date range
                    const fromDate = new Date(customDateFrom).getTime();
                    const toDate = customDateTo
                        ? new Date(customDateTo + 'T23:59:59').getTime()
                        : Date.now();
                    files = files.filter(f => {
                        const fileTime = new Date(f.modifiedAt).getTime();
                        return fileTime >= fromDate && fileTime <= toDate;
                    });
                } else if (timeRange.year) {
                    // Year-based filter (e.g., Year 2025)
                    const yearStart = new Date(timeRange.year, 0, 1).getTime();
                    const yearEnd = new Date(timeRange.year, 11, 31, 23, 59, 59).getTime();
                    files = files.filter(f => {
                        const fileTime = new Date(f.modifiedAt).getTime();
                        return fileTime >= yearStart && fileTime <= yearEnd;
                    });
                } else if (timeRange.days) {
                    // Relative days filter (Last 24h, Last Week, etc.)
                    const cutoffTime = Date.now() - (timeRange.days * 24 * 60 * 60 * 1000);
                    files = files.filter(f => {
                        const fileTime = new Date(f.modifiedAt).getTime();
                        return fileTime >= cutoffTime;
                    });
                }
                // 'all' time range: no filtering needed
            }
        }
        // If exceeds scanned range, show all scanned files (no time filtering)

        // Sort
        const sorted = [...files].sort((a, b) => {
            let comparison = 0;
            switch (sortField) {
                case 'modifiedAt':
                    comparison = new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
                    break;
                case 'size':
                    comparison = a.size - b.size;
                    break;
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
            }
            return sortOrder === 'asc' ? comparison : -comparison;
        });

        return sorted;
    }, [scannedFiles, selectedCategory, sortField, sortOrder, statusFilter, searchQuery, getIndexStatus, selectedTimeRange, customDateFrom, customDateTo, scannedTimeRange, scannedCustomDates]);

    // Paginated files for rendering - only show up to displayLimit
    const displayedFiles = useMemo(() => {
        return filteredFiles.slice(0, displayLimit);
    }, [filteredFiles, displayLimit]);

    const hasMoreFiles = filteredFiles.length > displayLimit;

    // Select/deselect all visible files - must be after filteredFiles is defined
    const toggleSelectAll = useCallback(() => {
        if (selectedFiles.size === filteredFiles.length && filteredFiles.length > 0) {
            setSelectedFiles(new Set());
        } else {
            setSelectedFiles(new Set(filteredFiles.map(f => f.path)));
        }
    }, [filteredFiles, selectedFiles.size]);

    // Reset display limit when category changes
    useEffect(() => {
        setDisplayLimit(ITEMS_PER_PAGE);
    }, [selectedCategory]);

    // Load more handler
    const loadMoreFiles = useCallback(() => {
        setDisplayLimit(prev => prev + ITEMS_PER_PAGE);
    }, []);

    // Build folder tree when files or filter changes
    useEffect(() => {
        const buildTree = async () => {
            if (scannedFiles.length === 0) {
                setFolderTree([]);
                return;
            }

            const api = window.api;
            if (!api?.buildFolderTree) return;

            try {
                const rootPaths = scope.directories.map(d => d.path);
                const filterKind = selectedCategory === 'all' ? undefined : selectedCategory;
                const tree = await api.buildFolderTree({
                    files: scannedFiles.filter(f => f.kind !== 'code'),
                    rootPaths,
                    filterKind,
                });
                setFolderTree(tree);
            } catch (error) {
                console.error('Failed to build folder tree:', error);
            }
        };

        buildTree();
    }, [scannedFiles, scope.directories, selectedCategory]);

    // Start scan
    const startScan = useCallback(async () => {
        if (scope.directories.length === 0) {
            return;
        }

        const timeRange = TIME_RANGES.find(t => t.id === selectedTimeRange);
        if (!timeRange) return;

        // Calculate date range for the scan
        let daysBack: number | null = null;
        let dateFrom: string | null = null;
        let dateTo: string | null = null;

        if (timeRange.year) {
            // Year-based option - filter files from Jan 1 to Dec 31 of that year
            const yearStart = new Date(timeRange.year, 0, 1);
            const yearEnd = new Date(timeRange.year, 11, 31, 23, 59, 59);
            dateFrom = yearStart.toISOString();
            dateTo = yearEnd.toISOString();
        } else if (selectedTimeRange === 'custom' && customDateFrom) {
            // Custom date range
            dateFrom = new Date(customDateFrom).toISOString();
            dateTo = customDateTo
                ? new Date(customDateTo + 'T23:59:59').toISOString()
                : new Date().toISOString();
        } else if (timeRange.days) {
            // Relative days option (Last 24h, Last Week, etc.)
            daysBack = timeRange.days;
        }
        // else: all time (null for both)

        setScanProgress({
            status: 'scanning',
            scannedCount: 0,
            matchedCount: 0,
            skippedCount: 0,
            startedAt: new Date().toISOString(),
        });
        setShowCompletedBanner(true); // Reset banner visibility for new scan
        // Clear cached results when starting new scan
        sessionStorage.removeItem(SCAN_RESULTS_KEY);
        sessionStorage.removeItem(SCAN_PROGRESS_KEY);
        setScannedFiles([]);
        setFolderTree([]);
        setScanStartTime(Date.now());

        // Save the time range used for this scan
        setScannedTimeRange(selectedTimeRange);
        setScannedCustomDates(
            selectedTimeRange === 'custom' && customDateFrom
                ? { from: customDateFrom, to: customDateTo || new Date().toISOString().split('T')[0] }
                : null
        );
        setCurrentPathDisplay('');
        // Clear the files buffer
        filesBufferRef.current = [];
        lastFlushTimeRef.current = Date.now();

        const api = window.api;
        if (!api?.scanFiles) {
            setScanProgress(prev => ({
                ...prev,
                status: 'error',
                error: 'Scan API not available',
            }));
            return;
        }

        try {
            const cancel = api.scanFiles({
                daysBack,
                dateFrom,
                dateTo,
                directories: scope.directories.map(d => d.path),
                useRecommendedExclusions: scope.useRecommendedExclusions,
                customExclusions: scope.customExclusions,
                onProgress: (progress) => {
                    setScanProgress(progress);
                    if (progress.currentPath) {
                        setCurrentPathDisplay(progress.currentPath);
                    }
                },
                onFiles: (files) => {
                    // Buffer incoming files to reduce React re-renders
                    const filteredFiles = files.filter(f => f.kind !== 'code');
                    filesBufferRef.current.push(...filteredFiles);

                    const now = Date.now();
                    if (now - lastFlushTimeRef.current >= flushIntervalMs) {
                        // Flush buffer to state
                        const bufferedFiles = filesBufferRef.current;
                        filesBufferRef.current = [];
                        lastFlushTimeRef.current = now;
                        setScannedFiles(prev => [...prev, ...bufferedFiles]);
                    }
                },
                onComplete: (result) => {
                    const files = result.files.filter(f => f.kind !== 'code');
                    setScannedFiles(files);
                    setFolderTree(result.folderTree);
                    setScanProgress(prev => ({
                        ...prev,
                        status: result.partial ? 'cancelled' : 'completed',
                        completedAt: new Date().toISOString(),
                    }));
                    setCancelFn(null);
                },
                onError: (error) => {
                    setScanProgress(prev => ({
                        ...prev,
                        status: 'error',
                        error,
                    }));
                    setCancelFn(null);
                },
            });
            setCancelFn(() => cancel);
        } catch (error) {
            console.error('Scan failed:', error);
            setScanProgress(prev => ({
                ...prev,
                status: 'error',
                error: error instanceof Error ? error.message : 'Scan failed',
            }));
        }
    }, [scope, selectedTimeRange]);

    // Cancel scan
    const cancelScan = useCallback(() => {
        // Immediately update UI to show cancelling
        setScanProgress(prev => ({
            ...prev,
            status: 'cancelled',
        }));

        if (cancelFn) {
            cancelFn();
            setCancelFn(null);
        }
        window.api?.cancelScan?.();
    }, [cancelFn]);

    // Open file
    const handleOpenFile = useCallback(async (file: ScannedFile) => {
        const api = window.api;
        if (api?.openFile) {
            try {
                await api.openFile(file.path);
            } catch (error) {
                console.error('Failed to open file:', error);
            }
        }
    }, []);

    // Note: 'cancelled' is not considered scanning so button switches to "Start Scan" immediately
    const isScanning = scanProgress.status === 'scanning' ||
        scanProgress.status === 'planning' ||
        scanProgress.status === 'building';

    // Real-time scan duration with timer
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    useEffect(() => {
        if (!isScanning || !scanStartTime) {
            return;
        }

        // Update immediately
        setElapsedSeconds(Math.floor((Date.now() - scanStartTime) / 1000));

        // Then update every second
        const interval = setInterval(() => {
            setElapsedSeconds(Math.floor((Date.now() - scanStartTime) / 1000));
        }, 1000);

        return () => clearInterval(interval);
    }, [isScanning, scanStartTime]);

    // Reset elapsed when starting new scan
    useEffect(() => {
        if (scanStartTime) {
            setElapsedSeconds(0);
        }
    }, [scanStartTime]);

    const scanDuration = useMemo(() => {
        if (!scanStartTime) return null;

        // Use elapsedSeconds for real-time updates during scanning
        const seconds = isScanning ? elapsedSeconds : Math.floor((Date.now() - scanStartTime) / 1000);

        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
    }, [scanStartTime, isScanning, elapsedSeconds]);

    const dragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

    return (
        <div className={cn("flex h-full flex-col gap-4", className)} style={dragStyle}>
            {/* Scope Summary with Rescan button */}
            <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                    <ScopeSummary scope={scope} />
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    {isScanning ? (
                        <button
                            onClick={cancelScan}
                            className="flex items-center gap-2 rounded-lg border border-destructive bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 transition-colors"
                        >
                            <Square className="h-4 w-4" />
                            Stop
                        </button>
                    ) : (
                        <button
                            onClick={startScan}
                            disabled={scope.directories.length === 0}
                            className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {scanProgress.status === 'completed' ? (
                                <>
                                    <RefreshCw className="h-4 w-4" />
                                    Rescan
                                </>
                            ) : (
                                <>
                                    <Play className="h-4 w-4" />
                                    Start Scan
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>

            {/* Time Range Selector */}
            <div className="flex flex-wrap items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground mr-2">Time Range:</span>
                {TIME_RANGES.map((range) => (
                    range.id === 'year2025' ? (
                        <button
                            key={range.id}
                            onClick={() => {
                                setSelectedTimeRange(range.id);
                                setShowCustomPicker(false);
                            }}
                            className={cn(
                                "relative px-3 py-1.5 text-xs font-bold rounded-full transition-all overflow-hidden",
                                selectedTimeRange === 'year2025'
                                    ? "text-white shadow-lg shadow-purple-500/30"
                                    : "text-white/90 hover:shadow-lg hover:shadow-purple-500/20"
                            )}
                            style={{
                                background: 'linear-gradient(90deg, #f472b6, #c084fc, #60a5fa, #34d399, #fbbf24, #f472b6)',
                                backgroundSize: '200% 100%',
                                animation: 'shimmer 3s linear infinite',
                            }}
                        >
                            <span className="relative z-10">✨ {range.label}</span>
                        </button>
                    ) : (
                        <button
                            key={range.id}
                            onClick={() => {
                                setSelectedTimeRange(range.id);
                                if (range.id === 'custom') {
                                    setShowCustomPicker(true);
                                } else {
                                    setShowCustomPicker(false);
                                }
                            }}
                            className={cn(
                                "px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
                                selectedTimeRange === range.id
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                            )}
                        >
                            {range.label}
                        </button>
                    )
                ))}
            </div>

            {/* Custom Date Range Picker */}
            {showCustomPicker && selectedTimeRange === 'custom' && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-muted/30">
                    <span className="text-xs text-muted-foreground">From:</span>
                    <input
                        type="date"
                        value={customDateFrom}
                        onChange={(e) => setCustomDateFrom(e.target.value)}
                        className="px-2 py-1 text-xs rounded border bg-background outline-none focus:ring-1 focus:ring-primary"
                    />
                    <span className="text-xs text-muted-foreground">To:</span>
                    <input
                        type="date"
                        value={customDateTo}
                        onChange={(e) => setCustomDateTo(e.target.value)}
                        max={new Date().toISOString().split('T')[0]}
                        className="px-2 py-1 text-xs rounded border bg-background outline-none focus:ring-1 focus:ring-primary"
                    />
                    {!customDateFrom && (
                        <span className="text-xs text-amber-600">Please select a start date</span>
                    )}
                </div>
            )}

            {/* Main Content */}
            <div className="flex flex-1 gap-4 min-h-0">
                {/* Sidebar - Categories */}
                <div className="w-56 flex-shrink-0 rounded-lg border bg-card p-3 overflow-y-auto">
                    <div className="flex items-center gap-2 mb-3 px-2">
                        <Filter className="h-4 w-4 text-muted-foreground" />
                        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            File Types
                        </span>
                    </div>
                    <div className="space-y-1">
                        {FILE_CATEGORIES.map((category) => {
                            const Icon = category.icon;
                            const count = categoryCounts[category.id] || 0;
                            const size = categorySizes[category.id] || 0;
                            const isSelected = selectedCategory === category.id;

                            return (
                                <button
                                    key={category.id}
                                    onClick={() => setSelectedCategory(category.id)}
                                    className={cn(
                                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-left",
                                        isSelected
                                            ? "bg-primary/10 text-primary border border-primary/20"
                                            : "hover:bg-muted/50 text-foreground"
                                    )}
                                >
                                    <Icon className={cn("h-4 w-4 flex-shrink-0", isSelected ? "text-primary" : "text-muted-foreground")} />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium truncate">{category.label}</div>
                                        {count > 0 && (
                                            <div className="text-[10px] text-muted-foreground">
                                                {count} files · {formatSize(size)}
                                            </div>
                                        )}
                                    </div>
                                    {count > 0 && (
                                        <span className={cn(
                                            "text-xs font-medium px-1.5 py-0.5 rounded-full",
                                            isSelected ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                                        )}>
                                            {count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Results Area */}
                <div className="flex-1 flex flex-col min-w-0 rounded-lg border bg-card overflow-hidden">
                    {/* Progress Section */}
                    {isScanning && (
                        <div className="border-b bg-primary/5 p-4 space-y-3">
                            {/* Stage and counters */}
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="relative h-10 w-10">
                                        {/* Background ring */}
                                        <div className="absolute inset-0 rounded-full border-4 border-primary/20" />
                                        {/* Spinning arc */}
                                        <svg className="absolute inset-0 h-10 w-10 -rotate-90 animate-spin" viewBox="0 0 40 40" style={{ animationDuration: '1.5s' }}>
                                            <circle
                                                cx="20"
                                                cy="20"
                                                r="16"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="4"
                                                className="text-primary"
                                                strokeDasharray="50 50"
                                                strokeLinecap="round"
                                            />
                                        </svg>
                                        {/* Center icon */}
                                        <div className="absolute inset-0 flex items-center justify-center">
                                            <HardDrive className="h-4 w-4 text-primary" />
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium">Scanning...</p>
                                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                            <span>{scanProgress.scannedCount.toLocaleString()} scanned</span>
                                            <span className="text-primary font-medium">{scanProgress.matchedCount.toLocaleString()} matched</span>
                                            <span className="text-muted-foreground/60">{scanProgress.skippedCount.toLocaleString()} skipped</span>
                                        </div>
                                    </div>
                                </div>
                                {scanDuration && (
                                    <span className="text-xs text-muted-foreground font-mono">{scanDuration}</span>
                                )}
                            </div>

                            {/* Path ticker */}
                            {currentPathDisplay && (
                                <div className="overflow-hidden">
                                    <p className="text-[10px] text-muted-foreground truncate font-mono">
                                        {currentPathDisplay}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Completed Summary - hide when showing incomplete data warning */}
                    {scanProgress.status === 'completed' && filteredFiles.length > 0 && showCompletedBanner && !isExceedingScanRange && (
                        <div className="border-b bg-emerald-500/5 p-4">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
                                        <Check className="h-5 w-5 text-emerald-500" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                                            Scan Complete
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Found {categoryCounts.all} files · {formatSize(categorySizes.all)} total
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    {scanDuration && (
                                        <span className="text-xs text-muted-foreground font-mono">
                                            Completed in {scanDuration}
                                        </span>
                                    )}
                                    {/* Generate Report Button - only show for Year 2025 AND if scanned with year2025 or all */}
                                    {selectedTimeRange === 'year2025' && isYear2025ReportValid && (
                                        <button
                                            onClick={() => {
                                                setReportYear(2025);
                                                setShowYearReport(true);
                                                setHasViewedReport(true);
                                                // eslint-disable-next-line no-empty
                                                try { sessionStorage.setItem('synvo-viewed-2025-report', 'true'); } catch { }
                                            }}
                                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white text-xs font-bold shadow-md hover:shadow-lg transition-all"
                                            style={{
                                                background: 'linear-gradient(90deg, #f472b6, #c084fc, #60a5fa, #34d399, #fbbf24, #f472b6)',
                                                backgroundSize: '200% 100%',
                                                animation: 'shimmer 3s linear infinite',
                                            }}
                                        >
                                            <FileBarChart className="h-3.5 w-3.5" />
                                            {hasViewedReport ? 'View Your 2025 Report' : 'Get Your 2025 Report'}
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setShowCompletedBanner(false)}
                                        className="p-1 rounded-md hover:bg-emerald-500/10 text-muted-foreground hover:text-foreground transition-colors"
                                        title="Dismiss"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Warning banner when selected time range exceeds scanned range */}
                    {scanProgress.status === 'completed' && isExceedingScanRange && scannedTimeRange && (
                        <div className="border-b bg-amber-500/10 px-4 py-3">
                            <div className="flex items-center gap-3">
                                <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                                <p className="text-xs text-amber-700 dark:text-amber-400">
                                    <span className="font-medium">Incomplete data:</span>{' '}
                                    You scanned with &quot;{TIME_RANGES.find(t => t.id === scannedTimeRange)?.label}&quot;.
                                    To view files for &quot;{TIME_RANGES.find(t => t.id === selectedTimeRange)?.label}&quot;, please rescan.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Sort Controls - show when there are files */}
                    {filteredFiles.length > 0 && (
                        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30 gap-3">
                            <div className="flex items-center gap-3">
                                {/* Select All Checkbox */}
                                <button
                                    onClick={toggleSelectAll}
                                    className="p-1 rounded hover:bg-muted transition-colors"
                                    title={selectedFiles.size === filteredFiles.length ? "Deselect all" : "Select all"}
                                >
                                    {selectedFiles.size === filteredFiles.length && filteredFiles.length > 0 ? (
                                        <CheckSquare className="h-4 w-4 text-primary" />
                                    ) : selectedFiles.size > 0 ? (
                                        <CheckSquare className="h-4 w-4 text-primary/50" />
                                    ) : (
                                        <SquareIcon className="h-4 w-4 text-muted-foreground" />
                                    )}
                                </button>
                                <span className="text-xs text-muted-foreground">
                                    {selectedFiles.size > 0
                                        ? `${selectedFiles.size} selected`
                                        : `${filteredFiles.length} ${filteredFiles.length === 1 ? 'file' : 'files'}`}
                                    {isScanning && ' (scanning...)'}
                                </span>

                                {/* Batch Index Button */}
                                {selectedFiles.size > 0 && (
                                    <IndexDropdown
                                        label={`Index ${selectedFiles.size} files`}
                                        options={[
                                            { label: 'Fast Index', value: 'fast' },
                                            { label: 'Deep Index', value: 'deep' },
                                        ]}
                                        onSelect={(mode) => handleIndexSelected(mode as 'fast' | 'deep')}
                                        variant="small"
                                    />
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                {/* Search */}
                                <div className="relative">
                                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                                    <input
                                        type="text"
                                        placeholder="Search files..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="w-40 pl-7 pr-2 py-1 text-xs bg-background border rounded outline-none focus:ring-1 focus:ring-primary"
                                    />
                                    {searchQuery && (
                                        <button
                                            onClick={() => setSearchQuery('')}
                                            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
                                        >
                                            <X className="h-3 w-3 text-muted-foreground" />
                                        </button>
                                    )}
                                </div>
                                {/* Status Filter */}
                                <select
                                    value={statusFilter}
                                    onChange={(e) => setStatusFilter(e.target.value as 'all' | 'not_indexed' | 'indexed')}
                                    className="text-xs bg-background border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-primary"
                                >
                                    <option value="all">All Status</option>
                                    <option value="not_indexed">Not Indexed</option>
                                    <option value="indexed">Indexed</option>
                                </select>
                                <span className="text-xs text-muted-foreground">Sort:</span>
                                <select
                                    value={sortField}
                                    onChange={(e) => setSortField(e.target.value as SortField)}
                                    className="text-xs bg-background border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-primary"
                                >
                                    <option value="modifiedAt">Modified</option>
                                    <option value="size">Size</option>
                                    <option value="name">Name</option>
                                </select>
                                <button
                                    onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                                    className="p-1 rounded hover:bg-muted transition-colors"
                                >
                                    {sortOrder === 'asc' ? (
                                        <SortAsc className="h-3.5 w-3.5 text-muted-foreground" />
                                    ) : (
                                        <SortDesc className="h-3.5 w-3.5 text-muted-foreground" />
                                    )}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Results: File List (shown during and after scanning) */}
                    <div className="flex-1 overflow-y-auto p-2">
                        {scanProgress.status === 'idle' ? (
                            selectedTimeRange === 'year2025' ? (
                                <div className="flex flex-col items-center justify-center h-full text-center p-8">
                                    <div
                                        className="h-20 w-20 rounded-full flex items-center justify-center mb-4 shadow-lg"
                                        style={{
                                            background: 'linear-gradient(135deg, #f472b6, #c084fc, #60a5fa, #34d399)',
                                        }}
                                    >
                                        <span className="text-3xl">✨</span>
                                    </div>
                                    <p className="text-lg font-semibold bg-gradient-to-r from-pink-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent mb-2">
                                        Unwrap Your 2025 Story
                                    </p>
                                    <p className="text-sm text-muted-foreground mb-4">
                                        Scan your files to discover your year in review
                                    </p>
                                    <p className="text-xs text-muted-foreground/60">
                                        🎁 Personalized insights · 📊 Activity heatmap · 🏆 Fun facts
                                    </p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full text-center p-8">
                                    <div className="h-16 w-16 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                                        <HardDrive className="h-8 w-8 text-muted-foreground/50" />
                                    </div>
                                    <p className="text-sm text-muted-foreground mb-2">
                                        {scope.directories.length === 0
                                            ? 'Select folders to scan above'
                                            : 'Click "Start Scan" to begin'}
                                    </p>
                                    <p className="text-xs text-muted-foreground/70">
                                        {scope.directories.length > 0 &&
                                            `Ready to scan ${scope.directories.length} folder${scope.directories.length !== 1 ? 's' : ''}`
                                        }
                                    </p>
                                </div>
                            )
                        ) : scanProgress.status === 'error' ? (
                            <div className="flex flex-col items-center justify-center h-full text-center p-8">
                                <div className="h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
                                    <AlertCircle className="h-8 w-8 text-destructive" />
                                </div>
                                <p className="text-sm font-medium text-destructive mb-2">Scan Failed</p>
                                <p className="text-xs text-muted-foreground">
                                    {scanProgress.error || 'An unknown error occurred'}
                                </p>
                            </div>
                        ) : filteredFiles.length > 0 ? (
                            // Show file list during and after scanning - PAGINATED for performance
                            <div key={`files-${selectedCategory}-${statusFilter}`} className="space-y-1">
                                {displayedFiles.map((file) => {
                                    const FileIcon = getFileIcon(file.kind);
                                    const status = getIndexStatus(file.path);
                                    const isSelected = selectedFiles.has(file.path);
                                    const isIndexing = indexingFiles.has(file.path);
                                    const isIndexed = status === 'fast' || status === 'deep';

                                    return (
                                        <div
                                            key={file.path}
                                            className={cn(
                                                "w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors text-left group",
                                                isSelected && "bg-primary/5 border border-primary/20"
                                            )}
                                        >
                                            {/* Checkbox */}
                                            <button
                                                onClick={() => toggleFileSelection(file.path)}
                                                className="p-0.5 rounded hover:bg-muted transition-colors shrink-0"
                                            >
                                                {isSelected ? (
                                                    <CheckSquare className="h-4 w-4 text-primary" />
                                                ) : (
                                                    <SquareIcon className="h-4 w-4 text-muted-foreground" />
                                                )}
                                            </button>

                                            {/* File Icon */}
                                            <button
                                                onClick={() => handleOpenFile(file)}
                                                className="h-8 w-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 hover:bg-muted transition-colors"
                                            >
                                                <FileIcon className="h-4 w-4 text-muted-foreground" />
                                            </button>

                                            {/* File Info */}
                                            <button
                                                onClick={() => handleOpenFile(file)}
                                                className="flex-1 min-w-0 text-left"
                                            >
                                                <p className="text-sm font-medium truncate">{file.name}</p>
                                                <p className="text-xs text-muted-foreground truncate">
                                                    {file.parentPath || file.path}
                                                </p>
                                            </button>

                                            {/* File Meta and Actions */}
                                            <div className="flex items-center gap-2 shrink-0">
                                                <span className="text-xs text-muted-foreground hidden sm:inline">
                                                    {formatSize(file.size)}
                                                </span>
                                                <span className="text-xs text-muted-foreground hidden sm:inline">
                                                    {formatRelativeTime(file.modifiedAt)}
                                                </span>

                                                {/* Index Status Badge */}
                                                <IndexStatusBadge status={status} />

                                                {/* Deep Index button for Fast indexed files */}
                                                {status === 'fast' && !isIndexing && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleIndexFile(file.path, 'deep');
                                                        }}
                                                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-400 dark:hover:bg-violet-900/50 transition-colors"
                                                        title="Deep Index index"
                                                    >
                                                        <ArrowUp className="h-3 w-3" />
                                                        Deep
                                                    </button>
                                                )}

                                                {/* Index/Reindex Dropdown */}
                                                {!isIndexing && (
                                                    <IndexDropdown
                                                        label={isIndexed ? 'Reindex' : 'Index'}
                                                        options={[
                                                            { label: 'Fast', value: 'fast' },
                                                            { label: 'Deep', value: 'deep' },
                                                        ]}
                                                        onSelect={(mode) => handleIndexFile(file.path, mode as 'fast' | 'deep')}
                                                        variant="small"
                                                    />
                                                )}

                                                {/* Open File */}
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleOpenFile(file);
                                                    }}
                                                    className="p-1 rounded hover:bg-muted transition-colors opacity-0 group-hover:opacity-100"
                                                >
                                                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                                {/* Load More Button */}
                                {hasMoreFiles && (
                                    <button
                                        onClick={loadMoreFiles}
                                        className="w-full py-3 text-sm text-primary hover:bg-muted/50 rounded-lg transition-colors flex items-center justify-center gap-2"
                                    >
                                        <span>Load more ({filteredFiles.length - displayLimit} remaining)</span>
                                    </button>
                                )}
                            </div>
                        ) : scanProgress.status === 'completed' ? (
                            <div className="flex flex-col items-center justify-center h-full text-center p-8">
                                <div className="h-16 w-16 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                                    <Folder className="h-8 w-8 text-muted-foreground/50" />
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    No files found matching your criteria
                                </p>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>

            {/* Year In Review Modal */}
            <YearInReviewModal
                isOpen={showYearReport}
                onClose={() => setShowYearReport(false)}
                files={scannedFiles}
                year={reportYear}
            />
        </div>
    );
}
