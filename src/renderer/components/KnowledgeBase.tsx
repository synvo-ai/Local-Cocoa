import { useState, CSSProperties } from 'react';
import { Sparkles, Folder, ArrowLeft, Zap } from 'lucide-react';
import { cn } from '../lib/utils';
import { RetrievalPanel } from './RetrievalPanel';
import { IndexedFilesPanel } from './IndexedFilesPanel';
import { StageProgressBar } from './StageProgressBar';
import { ScanWorkspace } from './ScanWorkspace';
import type {
    FolderRecord,
    IndexedFile,
    IndexResultSnapshot,
    IndexProgressUpdate,
    IndexingItem,
} from '../types';
import type { StagedIndexProgress } from '../../electron/backendClient';

interface KnowledgeBaseProps {
    folders: FolderRecord[];
    folderStats?: Map<string, { indexed: number; pending: number }>;
    files: IndexedFile[];
    snapshot: IndexResultSnapshot | null;
    isIndexing: boolean;
    indexProgress?: IndexProgressUpdate | null;
    
    // Staged indexing progress
    stageProgress?: StagedIndexProgress | null;
    onStartSemantic?: () => Promise<void>;
    onStopSemantic?: () => Promise<void>;
    onStartDeep?: () => Promise<void>;
    onStopDeep?: () => Promise<void>;

    // Folder actions
    onAddFolder: () => Promise<void>;
    onAddFile?: () => Promise<void>;
    onRemoveFolder: (id: string) => Promise<void>;
    onRescanFolder: (id: string, mode?: 'fast' | 'deep') => Promise<void>;
    onReindexFolder: (id: string, mode?: 'fast' | 'deep') => Promise<void>;
    indexingItems?: IndexingItem[];

    // File actions
    onSelectFile: (file: IndexedFile) => void;
    onOpenFile?: (file: IndexedFile) => void | Promise<void>;
    onAskAboutFile: (file: IndexedFile) => Promise<void>;
    
    // Data refresh
    onRefresh?: () => void | Promise<void>;
}

type View = 'files' | 'search' | 'scan';

export function KnowledgeBase({
    folders,
    folderStats,
    files,
    snapshot,
    isIndexing,
    indexProgress,
    stageProgress,
    onStartSemantic,
    onStopSemantic,
    onStartDeep,
    onStopDeep,
    onAddFolder,
    onAddFile,
    onRemoveFolder,
    onRescanFolder,
    onReindexFolder,
    indexingItems,
    onSelectFile,
    onOpenFile,
    onAskAboutFile,
    onRefresh
}: KnowledgeBaseProps) {
    const [activeView, setActiveView] = useState<View>('files');
    const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
    const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

    return (
        <div className="flex h-full flex-col bg-gradient-to-br from-background via-background to-muted/20">
            {/* Header Region - Draggable */}
            <div className="flex-none border-b border-border/50 bg-card/30 backdrop-blur-sm" style={dragStyle}>
                <div className="px-6 pt-8 pb-4">
                    {/* Title section with action buttons */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            {activeView === 'search' ? (
                                <>
                                    <button
                                        onClick={() => setActiveView('files')}
                                        className="h-10 w-10 rounded-xl bg-muted/50 hover:bg-muted flex items-center justify-center transition-colors"
                                        style={noDragStyle}
                                    >
                                        <ArrowLeft className="h-5 w-5 text-muted-foreground" />
                                    </button>
                                    <div>
                                        <h2 className="text-xl font-bold tracking-tight">Smart Search</h2>
                                        <p className="text-xs text-muted-foreground">AI-powered semantic search across your files</p>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                                        <Folder className="h-5 w-5 text-primary" />
                                    </div>
                                    <div>
                                        <h2 className="text-xl font-bold tracking-tight">Files</h2>
                                        <p className="text-xs text-muted-foreground">Manage your indexed files and folders</p>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Action buttons - show in files view */}
                        {activeView === 'files' && (
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setActiveView('scan')}
                                    className={cn(
                                        "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
                                        "bg-muted/50 text-foreground",
                                        "hover:bg-muted hover:scale-[1.02]",
                                        "active:scale-[0.98]"
                                    )}
                                    style={noDragStyle}
                                >
                                    <Zap className="h-4 w-4" />
                                    Scan
                                </button>
                                <button
                                    onClick={() => setActiveView('search')}
                                    className={cn(
                                        "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
                                        "bg-gradient-to-r from-primary to-primary/80 text-primary-foreground",
                                        "hover:shadow-lg hover:shadow-primary/25 hover:scale-[1.02]",
                                        "active:scale-[0.98]"
                                    )}
                                    style={noDragStyle}
                                >
                                    <Sparkles className="h-4 w-4" />
                                    Smart Search
                                </button>
                            </div>
                        )}
                        
                        {/* Back button for scan view */}
                        {activeView === 'scan' && (
                            <button
                                onClick={() => setActiveView('files')}
                                className={cn(
                                    "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
                                    "bg-muted/50 text-foreground",
                                    "hover:bg-muted hover:scale-[1.02]",
                                    "active:scale-[0.98]"
                                )}
                                style={noDragStyle}
                            >
                                <ArrowLeft className="h-4 w-4" />
                                Back to Files
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden">
                <div className="h-full w-full p-6">
                    {activeView === 'search' && (
                        <RetrievalPanel
                            files={files}
                            snapshot={snapshot}
                            isIndexing={isIndexing}
                            onSelectFile={onSelectFile}
                            onOpenFile={onOpenFile}
                            onAskAboutFile={onAskAboutFile}
                        />
                    )}

                    {activeView === 'files' && (
                        <div className="flex flex-col gap-4 h-full">
                            {/* Stage Progress Bar */}
                            {stageProgress && stageProgress.total > 0 && (
                                <StageProgressBar
                                    progress={stageProgress}
                                    onStartSemantic={onStartSemantic}
                                    onStopSemantic={onStopSemantic}
                                    onStartDeep={onStartDeep}
                                    onStopDeep={onStopDeep}
                                />
                            )}
                            
                            {/* Files Panel */}
                            <div className="flex-1 min-h-0 overflow-hidden">
                                <IndexedFilesPanel
                                    folders={folders}
                                    files={files}
                                    indexingItems={indexingItems}
                                    isIndexing={isIndexing}
                                    onAddFolder={onAddFolder}
                                    onAddFile={onAddFile}
                                    onRemoveFolder={onRemoveFolder}
                                    onReindexFolder={onReindexFolder}
                                    onSelectFile={onSelectFile}
                                    onOpenFile={onOpenFile}
                                    onRefresh={onRefresh}
                                />
                            </div>
                        </div>
                    )}

                    {activeView === 'scan' && (
                        <ScanWorkspace />
                    )}
                </div>
            </div>
        </div>
    );
}
