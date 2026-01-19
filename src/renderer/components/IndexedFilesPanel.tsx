/**
 * IndexedFilesPanel Component
 * 
 * Modern file browser with:
 * - Hierarchical folder tree (like macOS Finder)
 * - Beautiful file cards with type indicators
 * - Smooth animations and transitions
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
    Folder,
    FolderOpen,
    Plus,
    FileText,
    Trash2,
    ChevronDown,
    ChevronRight,
    ExternalLink,
    Search,
    HardDrive,
    Loader2,
    ArrowUp,
    Image as ImageIcon,
    Video,
    Music,
    FileCode,
    FileArchive,
    Layers,
    MoreHorizontal,
    Eye,
    Zap,
    AlertCircle,
    Clock,
    Shield,
    ShieldOff,
    Lock,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { FolderRecord, IndexedFile, IndexingItem, PrivacyLevel } from '../types';

// ============================================
// Helper Functions
// ============================================

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
        return `${diffDays}d ago`;
    } else if (diffDays < 30) {
        const weeks = Math.floor(diffDays / 7);
        return `${weeks}w ago`;
    } else {
        return date.toLocaleDateString();
    }
}

// ============================================
// Tree Node Type
// ============================================

interface TreeNode {
    id: string;
    name: string;
    path: string;
    isFolder: boolean;
    children: TreeNode[];
    folder?: FolderRecord;
    fileCount: number;
    indexedCount: number;
    totalSize: number;
}

// Build folder tree from flat folder list
function buildFolderTree(folders: FolderRecord[], filesByFolder: Map<string, IndexedFile[]>): TreeNode {
    const root: TreeNode = {
        id: 'root',
        name: 'All Files',
        path: '',
        isFolder: true,
        children: [],
        fileCount: 0,
        indexedCount: 0,
        totalSize: 0,
    };

    // Map to store all nodes by path for quick lookup
    const nodesByPath = new Map<string, TreeNode>();
    nodesByPath.set('', root);

    // Sort folders by path to ensure parents are processed first
    const sortedFolders = [...folders].sort((a, b) => a.path.localeCompare(b.path));

    // Helper to create intermediate directory nodes
    const ensureIntermediateNodes = (targetPath: string, parentPath: string): TreeNode => {
        // Get the relative path between parent and target
        const relativePath = parentPath ? targetPath.slice(parentPath.length + 1) : targetPath;
        const parts = relativePath.split('/');

        let currentPath = parentPath;
        let currentParent = nodesByPath.get(parentPath) || root;

        // Create intermediate nodes for each part except the last (which is the actual folder)
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const newPath = currentPath ? `${currentPath}/${part}` : part;

            let intermediateNode = nodesByPath.get(newPath);
            if (!intermediateNode) {
                intermediateNode = {
                    id: `virtual-${newPath}`,
                    name: part,
                    path: newPath,
                    isFolder: true,
                    children: [],
                    folder: undefined, // Virtual node, no actual folder record
                    fileCount: 0,
                    indexedCount: 0,
                    totalSize: 0,
                };
                nodesByPath.set(newPath, intermediateNode);
                currentParent.children.push(intermediateNode);
            }

            currentParent = intermediateNode;
            currentPath = newPath;
        }

        return currentParent;
    };

    for (const folder of sortedFolders) {
        const files = filesByFolder.get(folder.id) || [];
        const fileCount = files.length;
        const indexedCount = files.filter(f => f.indexStatus === 'indexed' || !f.indexStatus).length;
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);

        // Check if this folder is a child of any existing folder
        let parentPath = '';

        for (const existingFolder of sortedFolders) {
            if (existingFolder.id !== folder.id && folder.path.startsWith(existingFolder.path + '/')) {
                // Find the most specific parent
                if (existingFolder.path.length > parentPath.length) {
                    parentPath = existingFolder.path;
                }
            }
        }

        const node: TreeNode = {
            id: folder.id,
            name: folder.label || folder.path.split('/').pop() || folder.path,
            path: folder.path,
            isFolder: true,
            children: [],
            folder,
            fileCount,
            indexedCount,
            totalSize,
        };

        // Store node by path for quick lookup
        nodesByPath.set(folder.path, node);

        root.fileCount += fileCount;
        root.indexedCount += indexedCount;
        root.totalSize += totalSize;

        if (!parentPath) {
            root.children.push(node);
        } else {
            // Ensure all intermediate directories exist between parent and this folder
            const directParent = ensureIntermediateNodes(folder.path, parentPath);
            directParent.children.push(node);

            // Update file counts up the chain
            let current = directParent;
            while (current && current.id !== 'root') {
                current.fileCount += fileCount;
                current.indexedCount += indexedCount;
                current.totalSize += totalSize;
                // Find parent of current
                const parentOfCurrent = Array.from(nodesByPath.values()).find(n =>
                    n.children.includes(current)
                );
                current = parentOfCurrent!;
            }
        }
    }

    return root;
}

// ============================================
// Index Mode Types
// ============================================

type IndexMode = 'fast' | 'deep' | 'none' | 'error' | 'processing';

function getFileIndexMode(file: IndexedFile, processingFiles: Set<string>): IndexMode {
    if (processingFiles.has(file.fullPath)) return 'processing';

    // Prioritize new stage fields (fastStage, deepStage)
    // Deep stage > 0 means Deep index completed (except error/skipped)
    if (file.deepStage && file.deepStage > 0) return 'deep';

    // Fast stage > 0 means Fast index completed (except error)
    if (file.fastStage && file.fastStage > 0) return 'fast';

    // Legacy fallback (metadata checks)
    if (file.indexStatus === 'error') return 'error';
    if (file.indexStatus === 'pending') return 'none';

    const metadata = file.metadata as Record<string, unknown> | undefined;
    if (!metadata) return 'none';

    const chunkStrategy = metadata.chunk_strategy as string | undefined;
    if (chunkStrategy) {
        if (chunkStrategy.includes('_fine')) return 'deep';
        if (chunkStrategy.includes('_fast')) return 'fast';
    }

    const pdfVisionMode = metadata.pdf_vision_mode as string | undefined;
    if (pdfVisionMode === 'deep') return 'deep';
    if (pdfVisionMode === 'fast') return 'fast';

    if (chunkStrategy) return 'fast';

    return 'none';
}

// Status badge component with modern styling
function StatusBadge({ mode }: { mode: IndexMode }) {
    const config = {
        error: {
            icon: AlertCircle,
            label: 'Error',
            className: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
        },
        processing: {
            icon: Loader2,
            label: 'Indexing',
            className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
            animate: true,
        },
        deep: {
            icon: Eye,
            label: 'Indexed (Deep)',
            className: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
        },
        fast: {
            icon: Zap,
            label: 'Indexed',
            className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        },
        none: {
            icon: Clock,
            label: 'Pending',
            className: 'bg-muted text-muted-foreground border-muted-foreground/20',
        },
    }[mode];

    const Icon = config.icon;

    return (
        <span className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium",
            config.className
        )}>
            <Icon className={cn("h-3 w-3", config.animate && "animate-spin")} />
            <span>{config.label}</span>
        </span>
    );
}

// ============================================
// Dropdown Component
// ============================================

function ActionDropdown({
    trigger,
    options,
    onSelect,
    disabled,
}: {
    trigger: React.ReactNode;
    options: { label: string; value: string; icon?: React.ComponentType<{ className?: string }>; destructive?: boolean }[];
    onSelect: (value: string) => void;
    disabled?: boolean;
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
            const rect = buttonRef.current.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            setOpenUpward(spaceBelow < 150);
        }
        setIsOpen(!isOpen);
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                ref={buttonRef}
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    handleToggle();
                }}
                disabled={disabled}
                className="p-1.5 rounded-lg hover:bg-accent transition-colors disabled:opacity-50"
            >
                {trigger}
            </button>
            {isOpen && (
                <div className={cn(
                    "absolute right-0 z-50 min-w-[160px] rounded-xl border bg-popover p-1.5 shadow-lg",
                    openUpward ? "bottom-full mb-1" : "top-full mt-1"
                )}>
                    {options.map((option) => {
                        const Icon = option.icon;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSelect(option.value);
                                    setIsOpen(false);
                                }}
                                className={cn(
                                    "w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                                    option.destructive
                                        ? "text-destructive hover:bg-destructive/10"
                                        : "hover:bg-accent"
                                )}
                            >
                                {Icon && <Icon className="h-4 w-4" />}
                                {option.label}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ============================================
// File Type Config
// ============================================

const FILE_TYPE_CONFIG = {
    document: { icon: FileText, color: 'text-blue-500', bg: 'bg-blue-500/10' },
    image: { icon: ImageIcon, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    video: { icon: Video, color: 'text-purple-500', bg: 'bg-purple-500/10' },
    audio: { icon: Music, color: 'text-pink-500', bg: 'bg-pink-500/10' },
    code: { icon: FileCode, color: 'text-orange-500', bg: 'bg-orange-500/10' },
    presentation: { icon: Layers, color: 'text-amber-500', bg: 'bg-amber-500/10' },
    spreadsheet: { icon: Layers, color: 'text-green-500', bg: 'bg-green-500/10' },
    book: { icon: FileText, color: 'text-indigo-500', bg: 'bg-indigo-500/10' },
    archive: { icon: FileArchive, color: 'text-gray-500', bg: 'bg-gray-500/10' },
    other: { icon: FileText, color: 'text-gray-500', bg: 'bg-gray-500/10' },
} as const;

function getFileTypeConfig(kind: string) {
    return FILE_TYPE_CONFIG[kind as keyof typeof FILE_TYPE_CONFIG] || FILE_TYPE_CONFIG.other;
}

// ============================================
// Folder Tree Node Component
// ============================================

interface FolderTreeNodeProps {
    node: TreeNode;
    depth: number;
    isSelected: boolean;
    expandedNodes: Set<string>;
    onSelect: (node: TreeNode) => void;
    onToggle: (nodeId: string) => void;
    onRemove?: (folderId: string) => void;
    onIndexAll?: (folderId: string, mode: 'fast' | 'deep') => void;
    onTogglePrivacy?: (folderId: string, currentLevel: PrivacyLevel) => void;
}

function FolderTreeNode({
    node,
    depth,
    isSelected,
    expandedNodes,
    onSelect,
    onToggle,
    onRemove,
    onIndexAll,
    onTogglePrivacy,
}: FolderTreeNodeProps) {
    const [confirming, setConfirming] = useState(false);
    const isExpanded = expandedNodes.has(node.id);
    const hasChildren = node.children.length > 0;
    const isRoot = node.id === 'root';
    const isPrivate = node.folder?.privacyLevel === 'private';

    // Custom folder icon colors based on depth
    const folderColors = [
        'text-amber-600 dark:text-amber-500', // Root level
        'text-blue-500 dark:text-blue-400',
        'text-emerald-500 dark:text-emerald-400',
        'text-violet-500 dark:text-violet-400',
    ];
    const folderColor = folderColors[Math.min(depth, folderColors.length - 1)];

    return (
        <div>
            <div
                onClick={() => {
                    onSelect(node);
                    if (hasChildren && !isRoot) {
                        onToggle(node.id);
                    }
                }}
                className={cn(
                    "group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition-all duration-150",
                    isSelected
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-accent/50 text-foreground"
                )}
                style={{ paddingLeft: `${8 + depth * 16}px` }}
            >
                {/* Expand/collapse arrow */}
                {hasChildren ? (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggle(node.id);
                        }}
                        className="p-0.5 hover:bg-accent rounded transition-colors"
                    >
                        {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                    </button>
                ) : (
                    <span className="w-4" />
                )}

                {/* Folder icon */}
                <div className="shrink-0">
                    {isRoot ? (
                        <HardDrive className={cn("h-4 w-4", isSelected ? "text-primary" : "text-muted-foreground")} />
                    ) : isExpanded ? (
                        <FolderOpen className={cn("h-4 w-4", folderColor)} />
                    ) : (
                        <Folder className={cn("h-4 w-4", folderColor)} />
                    )}
                </div>

                {/* Folder name */}
                <span className={cn(
                    "text-sm font-medium truncate flex-1",
                    isSelected && "text-primary"
                )}>
                    {node.name}
                </span>
                
                {/* Private badge - more visible */}
                {isPrivate && !isRoot && (
                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-[9px] font-medium">
                        <Lock className="h-2 w-2" />
                    </span>
                )}

                {/* File count badge */}
                {node.fileCount > 0 && (
                    <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                        {node.fileCount}
                    </span>
                )}

                {/* Actions (only for non-root folders) */}
                {!isRoot && node.folder && (
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                        {confirming ? (
                            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                                <button
                                    onClick={() => { onRemove?.(node.folder!.id); setConfirming(false); }}
                                    className="px-1.5 py-0.5 text-[10px] rounded bg-destructive text-destructive-foreground"
                                >
                                    Remove
                                </button>
                                <button
                                    onClick={() => setConfirming(false)}
                                    className="px-1.5 py-0.5 text-[10px] rounded border"
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <ActionDropdown
                                trigger={<MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />}
                                options={[
                                    { label: 'Fast Index All', value: 'fast', icon: Zap },
                                    { label: 'Deep Index All', value: 'deep', icon: Eye },
                                    { 
                                        label: node.folder?.privacyLevel === 'private' ? 'Make Normal' : 'Make Private', 
                                        value: 'toggle-privacy', 
                                        icon: node.folder?.privacyLevel === 'private' ? ShieldOff : Shield 
                                    },
                                    { label: 'Remove Folder', value: 'remove', icon: Trash2, destructive: true },
                                ]}
                                onSelect={(value) => {
                                    if (value === 'remove') setConfirming(true);
                                    else if ((value === 'fast' || value === 'deep') && node.folder) {
                                        onIndexAll?.(node.folder.id, value);
                                    } else if (value === 'toggle-privacy' && node.folder) {
                                        onTogglePrivacy?.(node.folder.id, node.folder.privacyLevel || 'normal');
                                    }
                                }}
                            />
                        )}
                    </div>
                )}
            </div>

            {/* Children */}
            {hasChildren && isExpanded && (
                <div>
                    {node.children.map(child => (
                        <FolderTreeNode
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                            isSelected={isSelected && child.id === child.id}
                            expandedNodes={expandedNodes}
                            onSelect={onSelect}
                            onToggle={onToggle}
                            onRemove={onRemove}
                            onIndexAll={onIndexAll}
                            onTogglePrivacy={onTogglePrivacy}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ============================================
// File Row Component
// ============================================

interface FileRowProps {
    file: IndexedFile;
    mode: IndexMode;
    onSelect: () => void;
    onOpen: () => void;
    onIndex: (mode: 'fast' | 'deep') => void;
    onTogglePrivacy?: (fileId: string, currentLevel: PrivacyLevel) => void;
}

function FileRow({ file, mode, onSelect, onOpen, onIndex, onTogglePrivacy }: FileRowProps) {
    const typeConfig = getFileTypeConfig(file.kind || 'other');
    const Icon = typeConfig.icon;
    const isProcessing = mode === 'processing';
    const isFast = mode === 'fast';
    const isPrivate = file.privacyLevel === 'private';

    return (
        <div
            onClick={onSelect}
            onDoubleClick={onOpen}
            className={cn(
                "group flex items-center gap-4 px-4 py-3 border-b border-border/30 transition-all duration-150 cursor-pointer",
                mode === 'error'
                    ? "bg-destructive/5"
                    : "hover:bg-accent/40"
            )}
        >
            {/* File icon - simple style */}
            <div className="shrink-0">
                <Icon className={cn("h-5 w-5", typeConfig.color)} />
            </div>

            {/* File name - takes most space */}
            <div className="flex-1 min-w-0 flex items-center gap-2">
                <p className="text-sm truncate">{file.name}</p>
                {isPrivate && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-[10px] font-medium shrink-0">
                        <Lock className="h-2.5 w-2.5" />
                        Private
                    </span>
                )}
            </div>

            {/* Status badge */}
            <div className="w-32 shrink-0">
                <StatusBadge mode={mode} />
            </div>

            {/* Size */}
            <span className="text-sm text-muted-foreground w-24 text-right shrink-0">
                {formatBytes(file.size)}
            </span>

            {/* Actions - show on hover */}
            <div className="w-8 shrink-0 flex justify-end">
                <ActionDropdown
                    trigger={
                        <div className="p-1 rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity">
                            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                        </div>
                    }
                    options={[
                        { label: 'Open File', value: 'open', icon: ExternalLink },
                        ...(isProcessing ? [] : [
                            { label: 'Fast Index', value: 'fast', icon: Zap },
                            // Show "Upgrade to Deep" for fast-indexed files, "Deep Index" otherwise
                            ...(isFast
                                ? [{ label: 'Upgrade to Deep', value: 'deep', icon: ArrowUp }]
                                : [{ label: 'Deep Index', value: 'deep', icon: Eye }]
                            ),
                        ]),
                        { 
                            label: isPrivate ? 'Make Normal' : 'Make Private', 
                            value: 'toggle-privacy', 
                            icon: isPrivate ? ShieldOff : Shield 
                        },
                    ]}
                    onSelect={(value) => {
                        if (value === 'open') onOpen();
                        else if (value === 'fast') onIndex('fast');
                        else if (value === 'deep') onIndex('deep');
                        else if (value === 'toggle-privacy') {
                            onTogglePrivacy?.(file.id, file.privacyLevel || 'normal');
                        }
                    }}
                />
            </div>
        </div>
    );
}

// ============================================
// Breadcrumb Component
// ============================================

interface BreadcrumbProps {
    node: TreeNode | null;
    onNavigate: (node: TreeNode | null) => void;
    rootNode: TreeNode;
}

function Breadcrumb({ node, onNavigate, rootNode }: BreadcrumbProps) {
    // Build path from root to current node
    const buildPath = (current: TreeNode | null): TreeNode[] => {
        if (!current || current.id === 'root') return [rootNode];

        const path: TreeNode[] = [rootNode];

        // Find path from root to current node
        const findPath = (searchNode: TreeNode, target: TreeNode, currentPath: TreeNode[]): TreeNode[] | null => {
            if (searchNode.id === target.id) {
                return [...currentPath, searchNode];
            }
            for (const child of searchNode.children) {
                const result = findPath(child, target, [...currentPath, searchNode]);
                if (result) return result;
            }
            return null;
        };

        const foundPath = findPath(rootNode, current, []);
        return foundPath || path;
    };

    const pathNodes = buildPath(node);

    return (
        <div className="flex items-center gap-1 text-sm">
            {pathNodes.map((pathNode, index) => (
                <div key={pathNode.id} className="flex items-center gap-1">
                    {index > 0 && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <button
                        onClick={() => onNavigate(pathNode)}
                        className={cn(
                            "hover:text-primary transition-colors",
                            index === pathNodes.length - 1
                                ? "font-semibold text-foreground"
                                : "text-muted-foreground"
                        )}
                    >
                        {pathNode.name}
                    </button>
                </div>
            ))}
        </div>
    );
}

// ============================================
// Main Component
// ============================================

interface IndexedFilesPanelProps {
    folders: FolderRecord[];
    files: IndexedFile[];
    indexingItems?: IndexingItem[];
    isIndexing?: boolean;
    onAddFolder: () => Promise<void>;
    onAddFile?: () => Promise<void>;
    onRemoveFolder: (folderId: string) => Promise<void>;
    onReindexFolder: (folderId: string, mode?: 'fast' | 'deep') => Promise<void>;
    onSelectFile?: (file: IndexedFile) => void;
    onOpenFile?: (file: IndexedFile) => void | Promise<void>;
    onDeleteFile?: (fileId: string) => Promise<void>;
    onRefresh?: () => void | Promise<void>;
    className?: string;
}

type FilterType = 'all' | 'pdfs' | 'images' | 'docs';

export function IndexedFilesPanel({
    folders,
    files,
    indexingItems = [],
    isIndexing,
    onAddFolder,
    onAddFile,
    onRemoveFolder,
    onReindexFolder,
    onSelectFile,
    onOpenFile,
    onRefresh,
    className,
}: IndexedFilesPanelProps) {
    const [isAddingFolder, setIsAddingFolder] = useState(false);
    const [isAddingFile, setIsAddingFile] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['root']));
    const [filterType, setFilterType] = useState<FilterType>('all');
    const [processingFiles, setProcessingFiles] = useState<Set<string>>(new Set());

    // Track processing files
    useEffect(() => {
        const processingPaths: string[] = [];
        for (const item of indexingItems) {
            if (item.status === 'processing' || item.status === 'pending') {
                processingPaths.push(item.filePath);
            }
        }
        setProcessingFiles(prev => {
            const prevPaths = Array.from(prev).sort().join(',');
            const newPaths = processingPaths.sort().join(',');
            if (prevPaths === newPaths) return prev;
            return new Set(processingPaths);
        });
    }, [indexingItems]);

    // Group files by folder
    const filesByFolder = useMemo(() => {
        const map = new Map<string, IndexedFile[]>();
        for (const file of files) {
            const existing = map.get(file.folderId) || [];
            existing.push(file);
            map.set(file.folderId, existing);
        }
        return map;
    }, [files]);

    // Build folder tree
    const folderTree = useMemo(() => {
        return buildFolderTree(folders, filesByFolder);
    }, [folders, filesByFolder]);

    // Filter files based on selected node
    const displayedFiles = useMemo(() => {
        let result: IndexedFile[];

        if (!selectedNode || selectedNode.id === 'root') {
            result = files;
        } else if (selectedNode.folder) {
            // Get files from this folder and all child folders
            const folderIds = new Set<string>();
            const collectFolderIds = (node: TreeNode) => {
                if (node.folder) {
                    folderIds.add(node.folder.id);
                }
                node.children.forEach(collectFolderIds);
            };
            collectFolderIds(selectedNode);
            result = files.filter(f => folderIds.has(f.folderId));
        } else {
            result = files;
        }

        // Apply filter type
        if (filterType !== 'all') {
            result = result.filter(f => {
                const ext = f.extension?.toLowerCase();
                const kind = f.kind?.toLowerCase();
                switch (filterType) {
                    case 'pdfs': return ext === 'pdf';
                    case 'images': return kind === 'image';
                    case 'docs': return ['docx', 'doc', 'txt', 'rtf'].includes(ext || '');
                    default: return true;
                }
            });
        }

        // Apply search
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            result = result.filter(f =>
                f.name.toLowerCase().includes(query) ||
                f.fullPath.toLowerCase().includes(query)
            );
        }

        return result;
    }, [files, selectedNode, filterType, searchQuery]);

    // Stats
    const totalFiles = files.length;
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    const handleAddFolder = async () => {
        setIsAddingFolder(true);
        try {
            await onAddFolder();
        } finally {
            setIsAddingFolder(false);
        }
    };

    const handleAddFile = async () => {
        if (!onAddFile) return;
        setIsAddingFile(true);
        try {
            await onAddFile();
        } finally {
            setIsAddingFile(false);
        }
    };

    const handleToggleNode = useCallback((nodeId: string) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(nodeId)) {
                next.delete(nodeId);
            } else {
                next.add(nodeId);
            }
            return next;
        });
    }, []);

    const handleIndexFile = useCallback(async (filePath: string, mode: 'fast' | 'deep') => {
        const api = window.api;
        if (!api?.runIndex || !api?.runStagedIndex) return;

        setProcessingFiles(prev => new Set(prev).add(filePath));

        try {
            if (mode === 'fast') {
                await api.runStagedIndex({
                    files: [filePath],
                    mode: 'reindex',
                });
            } else {
                await api.runIndex({
                    mode: 'reindex',
                    files: [filePath],
                    indexing_mode: 'deep',
                });
            }
        } catch (error) {
            console.error('Failed to index file:', error);
        } finally {
            setProcessingFiles(prev => {
                const next = new Set(prev);
                next.delete(filePath);
                return next;
            });
        }
    }, []);

    const handleOpenFile = useCallback(async (file: IndexedFile) => {
        if (onOpenFile) {
            await onOpenFile(file);
        } else {
            const api = window.api;
            if (api?.openFile) {
                await api.openFile(file.fullPath);
            }
        }
    }, [onOpenFile]);
    
    // Privacy toggle for files
    const handleToggleFilePrivacy = useCallback(async (fileId: string, currentLevel: PrivacyLevel) => {
        const api = window.api;
        if (!api?.setFilePrivacy) return;
        
        const newLevel: PrivacyLevel = currentLevel === 'normal' ? 'private' : 'normal';
        try {
            await api.setFilePrivacy(fileId, newLevel);
            // Refresh data to reflect privacy change
            onRefresh?.();
        } catch (error) {
            console.error('Failed to toggle file privacy:', error);
        }
    }, [onRefresh]);
    
    // Privacy toggle for folders (with cascade to all files)
    const handleToggleFolderPrivacy = useCallback(async (folderId: string, currentLevel: PrivacyLevel) => {
        const api = window.api;
        if (!api?.setFolderPrivacy) return;
        
        const newLevel: PrivacyLevel = currentLevel === 'normal' ? 'private' : 'normal';
        try {
            await api.setFolderPrivacy(folderId, newLevel, true); // true = apply to all files
            // Refresh data to reflect privacy change
            onRefresh?.();
        } catch (error) {
            console.error('Failed to toggle folder privacy:', error);
        }
    }, [onRefresh]);

    // Initialize root as selected
    useEffect(() => {
        if (!selectedNode && folderTree) {
            setSelectedNode(folderTree);
        }
    }, [selectedNode, folderTree]);

    // Expand root by default
    useEffect(() => {
        setExpandedNodes(prev => new Set([...prev, 'root']));
    }, []);

    return (
        <div className={cn("flex h-full gap-4", className)}>
            {/* Left sidebar - Folder tree */}
            <div className="w-60 shrink-0 flex flex-col rounded-2xl border bg-card/50 backdrop-blur-sm">
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2.5 border-b">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">File System</h3>
                </div>

                {/* Folder tree */}
                <div className="flex-1 overflow-y-auto py-2">
                    {folders.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center px-4">
                            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mb-3">
                                <Folder className="h-6 w-6 text-primary/60" />
                            </div>
                            <p className="text-sm font-medium mb-1">No folders yet</p>
                            <p className="text-xs text-muted-foreground mb-4">
                                Add a folder to start indexing
                            </p>
                        </div>
                    ) : (
                        <FolderTreeNode
                            node={folderTree}
                            depth={0}
                            isSelected={selectedNode?.id === folderTree.id}
                            expandedNodes={expandedNodes}
                            onSelect={setSelectedNode}
                            onToggle={handleToggleNode}
                            onRemove={onRemoveFolder}
                            onIndexAll={(folderId, mode) => onReindexFolder(folderId, mode)}
                            onTogglePrivacy={handleToggleFolderPrivacy}
                        />
                    )}
                </div>

                {/* Action buttons footer */}
                <div className="px-3 py-3 border-t space-y-2">
                    {/* Add Folder Button - Primary */}
                    <button
                        onClick={handleAddFolder}
                        disabled={isAddingFolder}
                        className={cn(
                            "w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
                            "bg-gradient-to-r from-primary to-primary/80 text-primary-foreground",
                            "hover:shadow-md hover:shadow-primary/20 hover:scale-[1.02]",
                            "active:scale-[0.98]",
                            "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none"
                        )}
                    >
                        {isAddingFolder ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Folder className="h-4 w-4" />
                        )}
                        Add Folder
                    </button>

                    {/* Add File Button - Secondary */}
                    {onAddFile && (
                        <button
                            onClick={handleAddFile}
                            disabled={isAddingFile}
                            className={cn(
                                "w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200",
                                "bg-muted/50 text-foreground border border-border/50",
                                "hover:bg-muted hover:border-border",
                                "active:scale-[0.98]",
                                "disabled:opacity-50 disabled:cursor-not-allowed"
                            )}
                        >
                            {isAddingFile ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <FileText className="h-4 w-4" />
                            )}
                            Add File
                        </button>
                    )}

                    {/* Stats */}
                    {folders.length > 0 && (
                        <div className="text-[10px] text-muted-foreground text-center pt-1">
                            {totalFiles} files · {formatBytes(totalSize)}
                        </div>
                    )}
                </div>
            </div>

            {/* Main content - File browser */}
            <div className="flex-1 flex flex-col min-w-0 rounded-2xl border bg-card/50 backdrop-blur-sm overflow-hidden">
                {/* Header with breadcrumb and search */}
                <div className="flex items-center justify-between gap-4 px-5 py-4 border-b">
                    {/* Breadcrumb navigation */}
                    <Breadcrumb
                        node={selectedNode}
                        onNavigate={setSelectedNode}
                        rootNode={folderTree}
                    />

                    {/* Search */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                            type="text"
                            placeholder="Search"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-52 pl-9 pr-3 py-2 text-sm rounded-xl border bg-background outline-none focus:ring-2 focus:ring-primary/20"
                        />
                    </div>
                </div>

                {/* Filter tabs */}
                <div className="flex items-center px-5 py-3 border-b bg-muted/10">
                    <div className="flex items-center gap-2">
                        {[
                            { id: 'all', label: 'All' },
                            { id: 'pdfs', label: 'PDFs' },
                            { id: 'images', label: 'Images' },
                            { id: 'docs', label: 'Docs' },
                        ].map(filter => (
                            <button
                                key={filter.id}
                                onClick={() => setFilterType(filter.id as FilterType)}
                                className={cn(
                                    "px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-200 border",
                                    filterType === filter.id
                                        ? "bg-primary text-primary-foreground border-primary shadow-sm"
                                        : "bg-background text-muted-foreground border-border hover:text-foreground hover:border-foreground/30"
                                )}
                            >
                                {filter.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Table header */}
                {displayedFiles.length > 0 && (
                    <div className="flex items-center gap-4 px-4 py-2 border-b bg-muted/20 text-xs font-medium text-muted-foreground">
                        <div className="w-5 shrink-0" /> {/* Icon space */}
                        <div className="flex-1">Name</div>
                        <div className="w-32 shrink-0">Status</div>
                        <div className="w-24 text-right shrink-0">Size</div>
                        <div className="w-8 shrink-0" /> {/* Actions space */}
                    </div>
                )}

                {/* File list */}
                <div className="flex-1 overflow-y-auto">
                    {displayedFiles.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center p-8">
                            <div className="h-16 w-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                                <FileText className="h-8 w-8 text-muted-foreground/50" />
                            </div>
                            <p className="text-sm font-medium mb-1">No files found</p>
                            <p className="text-xs text-muted-foreground">
                                {searchQuery ? 'Try a different search term' : 'Add files to get started'}
                            </p>
                        </div>
                    ) : (
                        <div>
                            {displayedFiles.map(file => (
                                <FileRow
                                    key={file.id}
                                    file={file}
                                    mode={getFileIndexMode(file, processingFiles)}
                                    onSelect={() => onSelectFile?.(file)}
                                    onOpen={() => handleOpenFile(file)}
                                    onIndex={(mode) => handleIndexFile(file.fullPath, mode)}
                                    onTogglePrivacy={handleToggleFilePrivacy}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
