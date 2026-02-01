import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppLayout } from './layout/AppLayout';
import { Sidebar } from './layout/Sidebar';
import { RightPanel } from './layout/RightPanel';
import { ChatArea } from './chat/ChatArea';
import { KnowledgeBase } from './KnowledgeBase';
import { ExtensionsView } from './ExtensionsView';
import { ModelManagerModal } from './modals/ModelManagerModal';
import { SettingsPanel } from './SettingsPanel';
import { OnboardingGuide } from './onboarding/OnboardingGuide';
import { StartupLoading } from './StartupLoading';
import { MbtiAnalysis } from './MbtiAnalysis';
import { UserMemory } from './UserMemory';
import { useWorkspaceData } from '../hooks/useWorkspaceData';
import { useChatSession } from '../hooks/useChatSession';
import { useModelStatus } from '../hooks/useModelStatus';
import { useMbtiAnalysis } from '../hooks/useMbtiAnalysis';
import type {
    IndexedFile,
    SearchHit
} from '../types';

const LOCAL_MODEL_LABEL = 'local-llm';
const ONBOARDING_KEY = 'local-cocoa-onboarding-completed';

function isConnectorPath(pathValue: string | null | undefined): boolean {
    const normalised = (pathValue ?? '').replace(/\\/g, '/').toLowerCase();
    return normalised.includes('/.synvo_db/mail') || normalised.includes('/.synvo_db/notes');
}

function isActivitySummariesPath(pathValue: string | null | undefined): boolean {
    const normalised = (pathValue ?? '').replace(/\\/g, '/').toLowerCase();
    return normalised.includes('local-cocoa-activity-summaries');
}

export function MainAppView() {
    const [activeView, setActiveView] = useState<'chat' | 'knowledge' | 'models' | 'settings' | 'extensions' | 'scan' | 'mbti' | 'memory'>('chat');
    const [isModelModalOpen, setIsModelModalOpen] = useState(false);
    const [isOnboardingOpen, setIsOnboardingOpen] = useState(() => {
        return !localStorage.getItem(ONBOARDING_KEY);
    });
    const [selectedFile, setSelectedFile] = useState<IndexedFile | null>(null);
    const [selectedHit, setSelectedHit] = useState<SearchHit | null>(null);
    const [indexDrawerOpen, setIndexDrawerOpen] = useState(false);
    const [notification, setNotification] = useState<{ message: string; action?: { label: string; onClick: () => void } } | null>(null);

    const [rightPanelTabRequest, setRightPanelTabRequest] = useState<{ tab: 'preview' | 'progress'; nonce: number } | null>(null);

    const requestRightPanelTab = useCallback((tab: 'preview' | 'progress') => {
        setRightPanelTabRequest((prev) => ({ tab, nonce: (prev?.nonce ?? 0) + 1 }));
    }, []);

    const _isContextTooLargeError = useCallback((value: unknown) => {
        const message = (value instanceof Error ? value.message : String(value ?? '')).toLowerCase();
        return message.includes('exceeds the available context size') || message.includes('available context size');
    }, []);

    const _showContextTooLargeWarning = useCallback(() => {
        setNotification({
            message: 'This request is too large for the model context window. Try lowering Vision Performance (Max Resolution) or increasing Context Size in Models.',
            action: {
                label: 'Model Settings',
                onClick: () => setActiveView('models')
            }
        });
    }, []);

    const handleOnboardingComplete = useCallback(() => {
        localStorage.setItem(ONBOARDING_KEY, 'true');
        setIsOnboardingOpen(false);
    }, []);

    const handleOpenGuide = useCallback(() => {
        setIsOnboardingOpen(true);
    }, []);

    const {
        folders,
        files,
        indexingItems,
        isIndexing,
        snapshot,
        fileMap,
        refreshData,
        health,
        progress,
        stageProgress,
        backendStarting,
        startSemanticIndexing,
        stopSemanticIndexing,
        startDeepIndexing,
        stopDeepIndexing
    } = useWorkspaceData();

    const previousIsIndexingRef = useRef<boolean>(false);
    useEffect(() => {
        const prev = previousIsIndexingRef.current;
        if (!prev && isIndexing) {
            setIndexDrawerOpen(true);
            // If indexing starts while user is in File System, default to the progress tab.
            if (activeView === 'knowledge') {
                requestRightPanelTab('progress');
            }
        }
        previousIsIndexingRef.current = isIndexing;
    }, [activeView, isIndexing, requestRightPanelTab]);

    useEffect(() => {
        const notifyHandler = (event: Event) => {
            const detail = (event as CustomEvent).detail as { message?: string; action?: { label: string; onClick: () => void } } | undefined;
            if (!detail?.message) return;
            setNotification({ message: detail.message, action: detail.action });
        };
        const navigateHandler = (event: Event) => {
            const detail = (event as CustomEvent).detail as { view?: 'chat' | 'knowledge' | 'models' | 'settings' | 'extensions' | 'scan' | 'mbti' } | undefined;
            if (!detail?.view) return;
            setActiveView(detail.view);
        };

        window.addEventListener('synvo:notify', notifyHandler as EventListener);
        window.addEventListener('synvo:navigate', navigateHandler as EventListener);
        return () => {
            window.removeEventListener('synvo:notify', notifyHandler as EventListener);
            window.removeEventListener('synvo:navigate', navigateHandler as EventListener);
        };
    }, []);

    // Backend is ready when health check passes and we're no longer in startup phase
    const isBackendReady = !backendStarting && health && health.status !== 'degraded';

    const openExternalSafe = useCallback(async (url: string) => {
        try {
            await window.api?.openExternal?.(url);
        } catch (error) {
            console.warn('Failed to open external url:', url, error);
        }
    }, []);

    const renderNotificationMessage = useCallback((message: string) => {
        // Make URLs clickable inside the banner message.
        const urlRegex = /(https?:\/\/[^\s]+|ms-settings:[^\s]+|x-apple\.systempreferences:[^\s]+)/gi;
        const parts = message.split(urlRegex);
        return parts.map((part, idx) => {
            if (!part) return null;
            // NOTE: avoid using the global regex `.test()` here (it is stateful via `lastIndex`).
            const isUrl = /^(https?:\/\/[^\s]+|ms-settings:[^\s]+|x-apple\.systempreferences:[^\s]+)$/i.test(part);
            if (isUrl) {
                return (
                    <button
                        key={`link-${idx}`}
                        type="button"
                        className="underline hover:no-underline"
                        onClick={() => void openExternalSafe(part)}
                    >
                        {part}
                    </button>
                );
            }
            return <span key={`text-${idx}`}>{part}</span>;
        });
    }, [openExternalSafe]);

    const handleAddFolder = useCallback(async () => {
        const api = window.api;
        if (!api?.pickFolders || !api?.addFolder) return;
        try {
            const paths = await api.pickFolders();
            if (paths && paths.length > 0) {
                const addedFolderIds: string[] = [];
                for (const path of paths) {
                    const folder = await api.addFolder(path);
                    if (folder?.id) addedFolderIds.push(folder.id);
                }

                // Auto-start indexing after adding folders using fast staged indexing
                if (addedFolderIds.length > 0 && api.runStagedIndex) {
                    await api.runStagedIndex({
                        folders: addedFolderIds,
                    });
                }
                await refreshData();
            }
        } catch (error) {
            console.error('Failed to add folder', error);
        }
    }, [refreshData]);

    // Add individual files - uses 'manual' scan mode to prevent full folder scans and avoid lag
    const handleAddFile = useCallback(async () => {
        const api = window.api;
        if (!api?.pickFiles || !api?.addFolder || !api?.runStagedIndex) return;
        try {
            const filePaths = await api.pickFiles();
            if (!filePaths || filePaths.length === 0) return;

            // Group files by their parent directories
            const filesByParent = new Map<string, string[]>();
            for (const filePath of filePaths) {
                const parentDir = filePath.split('/').slice(0, -1).join('/');
                const existing = filesByParent.get(parentDir) || [];
                existing.push(filePath);
                filesByParent.set(parentDir, existing);
            }

            // Register each parent directory with 'manual' scan mode (won't trigger full folder scan)
            // Then index only the selected files using fast staged indexing
            for (const [parentDir, files] of filesByParent) {
                // Add folder with 'manual' mode - this prevents automatic folder scanning
                try {
                    await api.addFolder(parentDir, undefined, 'manual');
                } catch {
                    // Folder might already exist, that's fine
                }

                // Index only the specific files using fast staged indexing
                await api.runStagedIndex({
                    folders: [parentDir],
                    files: files,
                });
            }

            await refreshData();
        } catch (error) {
            console.error('Failed to add file', error);
        }
    }, [refreshData]);

    const handleRemoveFolder = useCallback(async (id: string) => {
        const api = window.api;
        if (!api?.removeFolder) return;
        try {
            await api.removeFolder(id);
            await refreshData();
        } catch (error) {
            console.error('Failed to remove folder', error);
        }
    }, [refreshData]);

    const handleRescanFolder = useCallback(async (id: string, mode?: 'fast' | 'deep') => {
        const api = window.api;
        if (!api?.runStagedIndex) return;
        try {
            // Use staged indexing for both fast and deep modes
            // For deep mode, enable deep stage first, then run staged index
            if (mode === 'deep') {
                await startDeepIndexing();
            }
            await api.runStagedIndex({ folders: [id] });
            // Fast scans can complete before the polling loop observes "running".
            // Force a refresh so the UI updates last-indexed / failed files immediately.
            await refreshData();
        } catch (error) {
            console.error('Failed to rescan folder', error);
            setNotification({ message: error instanceof Error ? error.message : 'Failed to rescan folder.' });
        }
    }, [refreshData, startDeepIndexing]);

    const handleReindexFolder = useCallback(async (id: string, mode?: 'fast' | 'deep') => {
        const api = window.api;
        if (!api?.runStagedIndex) return;
        try {
            // Use staged indexing for both fast and deep modes
            // For deep mode, enable deep stage first, then run staged index with reindex
            if (mode === 'deep') {
                await startDeepIndexing();
            }
            await api.runStagedIndex({ folders: [id], mode: 'reindex' });
            await refreshData();
        } catch (error) {
            console.error('Failed to reindex folder', error);
            setNotification({ message: error instanceof Error ? error.message : 'Failed to reindex folder.' });
        }
    }, [refreshData, startDeepIndexing]);

    const {
        sessions,
        currentSessionId,
        messages,
        agentContext,
        isAnswering,
        handleCreateSession,
        handleDeleteSession,
        handleSelectSession,
        handleResetConversation,
        handleSend,
        handleResume
    } = useChatSession();

    const handleResumeSearch = useCallback(async (mode?: any) => {
        if (currentSessionId && handleResume) {
            await handleResume(currentSessionId, mode);
        }
    }, [currentSessionId, handleResume]);

    const {
        modelsReady,
        activeModelId,
        availableModels,
        setActiveModel,
        addLocalModel,
        handleManualModelDownload,
        modelDownloadEvent
    } = useModelStatus();

    // Derived state
    const visibleFolders = useMemo(() => folders.filter((folder) => !isConnectorPath(folder.path) && !isActivitySummariesPath(folder.path)), [folders]);
    const visibleFiles = useMemo(() => files.filter((file) => !isConnectorPath(file.fullPath || file.path) && !isActivitySummariesPath(file.fullPath || file.path)), [files]);
    const selectedModel = activeModelId || LOCAL_MODEL_LABEL;
    const currentSession = sessions.find(s => s.id === currentSessionId);

    // Handlers
    const handleOpenFile = useCallback(async (file: IndexedFile) => {
        const api = window.api;
        if (!api?.openFile) return;
        try {
            await api.openFile(file.fullPath);
        } catch (error) {
            console.error('Failed to open file', error);
        }
    }, []);

    useEffect(() => {
        const api = window.api;
        if (!api?.onSpotlightOpenFile || !api?.onSpotlightFocusFile) return;

        const cleanupOpen = api.onSpotlightOpenFile((payload) => {
            // console.log('Spotlight open request:', payload);
            const file = fileMap.get(payload.fileId);
            if (file) {
                handleOpenFile(file);
            } else {
                api.getFile(payload.fileId).then((f) => {
                    if (f) {
                        handleOpenFile({ ...f, location: 'Unknown', fullPath: f.path } as IndexedFile);
                    }
                });
            }
        });

        const cleanupFocus = api.onSpotlightFocusFile((payload) => {
            // console.log('Spotlight focus request:', payload);
            const file = fileMap.get(payload.fileId);
            if (file) {
                setSelectedFile(file);
                setSelectedHit({ fileId: file.id, score: 1, metadata: file.metadata || {} });
            } else {
                api.getFile(payload.fileId).then((f) => {
                    if (f) {
                        const indexed = { ...f, location: 'Unknown', fullPath: f.path } as IndexedFile;
                        setSelectedFile(indexed);
                        setSelectedHit({ fileId: f.id, score: 1, metadata: f.metadata || {} });
                    }
                });
            }
        });

        return () => {
            cleanupOpen();
            cleanupFocus();
        };
    }, [fileMap, handleOpenFile]);

    const handleReferenceOpen = useCallback(
        async (reference: SearchHit) => {
            // console.log('Opening reference:', reference);

            let targetFileId = reference.fileId;

            // Try to recover fileId from metadata if missing
            if (!targetFileId && reference.metadata) {
                const path = (reference.metadata.path || reference.metadata.file_path || reference.metadata.full_path) as string;
                if (path) {
                    const found = files.find(f => f.path === path || f.fullPath === path);
                    if (found) {
                        targetFileId = found.id;
                        // console.log('Recovered fileId from path:', targetFileId);
                    }
                }
            }

            if (!targetFileId) {
                console.warn('Cannot open reference: missing fileId and could not recover from metadata', reference);
                return;
            }

            let file = fileMap.get(targetFileId);
            if (!file && window.api?.getFile) {
                try {
                    const fetchedFile = await window.api.getFile(targetFileId);
                    if (fetchedFile) {
                        file = {
                            ...fetchedFile,
                            location: 'Unknown',
                            fullPath: fetchedFile.path || fetchedFile.name,
                            kind: 'other'
                        } as IndexedFile;
                    }
                } catch (error) {
                    console.error('Failed to fetch file:', error);
                }
            }

            if (file) {
                setSelectedFile(file);
                setSelectedHit(reference);
                requestRightPanelTab('preview');
            } else {
                console.warn('File not found for id:', targetFileId);
            }
        },
        [fileMap, files, requestRightPanelTab]
    );

    const handleAskAboutFile = useCallback(
        async (file: IndexedFile) => {
            setActiveView('chat');
            await handleSend(`Summarise the file "${file.name}" found at ${file.fullPath}.`);
        },
        [handleSend]
    );

    const folderStats = useMemo(() => {
        const stats = new Map<string, { indexed: number; pending: number }>();
        folders.forEach((folder) => {
            stats.set(folder.id, { indexed: 0, pending: 0 });
        });

        files.forEach((file) => {
            const entry = stats.get(file.folderId) ?? { indexed: 0, pending: 0 };
            entry.indexed += 1;
            stats.set(file.folderId, entry);
        });

        indexingItems.forEach((item) => {
            const entry = stats.get(item.folderId);
            if (entry) {
                entry.pending += 1;
            }
        });

        return stats;
    }, [files, folders, indexingItems]);

    const handleViewSelect = (view: 'chat' | 'knowledge' | 'models' | 'settings' | 'extensions' | 'scan' | 'mbti' | 'memory') => {
        setActiveView(view);
    };

    // MBTI Analysis hook
    const {
        isAnalyzing,
        isGeneratingReport,
        progress: mbtiProgress,
        result: mbtiResult,
        error: mbtiError,
        filterProgress,
        embedProgress,
        startAnalysis: startMbtiAnalysis,
        startAnalysisWithFilter,
        stopAnalysis: stopMbtiAnalysis,
        resetAnalysis: resetMbtiAnalysis,
        setProgress: setMbtiProgress
    } = useMbtiAnalysis();

    const handleOpenIndexProgress = useCallback(() => {
        setIndexDrawerOpen(true);
        requestRightPanelTab('progress');
    }, [requestRightPanelTab]);

    // Local state to track skipped files from queue (for UI-only removal)
    const [skippedQueueFiles, setSkippedQueueFiles] = useState<Set<string>>(new Set());

    // Filter out skipped files from indexingItems
    const filteredIndexingItems = useMemo(() => {
        if (skippedQueueFiles.size === 0) return indexingItems;
        return indexingItems.filter(item => !skippedQueueFiles.has(item.filePath));
    }, [indexingItems, skippedQueueFiles]);

    // Clear skipped files when indexing completes or changes significantly
    useEffect(() => {
        if (!isIndexing && skippedQueueFiles.size > 0) {
            setSkippedQueueFiles(new Set());
        }
    }, [isIndexing, skippedQueueFiles.size]);

    const handlePauseIndexing = useCallback(async () => {
        const api = window.api;
        if (!api?.pauseIndexing) return;
        try {
            await api.pauseIndexing();
        } catch (err) {
            console.error('Failed to pause indexing:', err);
        }
    }, []);

    const handleResumeIndexing = useCallback(async () => {
        const api = window.api;
        if (!api?.resumeIndexing) return;
        try {
            await api.resumeIndexing();
        } catch (err) {
            console.error('Failed to resume indexing:', err);
        }
    }, []);

    const handleRemoveFromQueue = useCallback((filePath: string) => {
        // Add to skipped files set (UI-only, backend may still process)
        setSkippedQueueFiles(prev => {
            const next = new Set(prev);
            next.add(filePath);
            return next;
        });
    }, []);



    const statusMessage = backendStarting
        ? 'Starting backend services...'
        : (health?.message || 'Connecting to services...');

    return (
        <>
            {(!isBackendReady && !modelsReady) ? (
                <StartupLoading
                    onOpenModelManager={() => setIsModelModalOpen(true)}
                    statusMessage={statusMessage}
                    modelsReady={modelsReady}
                />
            ) : (
                <AppLayout
                    sidebar={
                        <Sidebar
                            sessions={sessions}
                            currentSessionId={currentSessionId}
                            onSelectSession={handleSelectSession}
                            onCreateSession={handleCreateSession}
                            onDeleteSession={handleDeleteSession}
                            activeView={activeView}
                            onSelectView={handleViewSelect}
                            onOpenIndexProgress={handleOpenIndexProgress}
                            isIndexing={isIndexing}
                            indexStatus={progress?.status ?? null}
                            onOpenGuide={handleOpenGuide}
                        />
                    }
                    rightPanel={
                        (selectedFile || selectedHit || indexDrawerOpen) ? (
                            <RightPanel
                                selectedFile={selectedFile}
                                selectedHit={selectedHit}
                                onClose={() => {
                                    setSelectedFile(null);
                                    setSelectedHit(null);
                                }}
                                onOpenFile={handleOpenFile}
                                indexingOpen={indexDrawerOpen}
                                isIndexing={isIndexing}
                                indexProgress={progress}
                                indexingItems={filteredIndexingItems}
                                stageProgress={stageProgress}
                                onCloseIndexing={() => setIndexDrawerOpen(false)}
                                tabRequest={rightPanelTabRequest}
                                onRemoveFromQueue={handleRemoveFromQueue}
                                onPauseIndexing={handlePauseIndexing}
                                onResumeIndexing={handleResumeIndexing}
                            />
                        ) : null
                    }
                >
                    {notification && (
                        <div
                            className="app-no-drag fixed bottom-4 right-4 z-50 flex max-w-[640px] items-start justify-between gap-3 rounded-md bg-destructive px-4 py-3 text-sm text-destructive-foreground shadow"
                            style={{ zIndex: 10000 }}
                        >
                            <div className="min-w-0 flex-1 break-words">{renderNotificationMessage(notification.message)}</div>
                            <div className="flex items-center gap-2">
                                {notification.action && (
                                    <button
                                        onClick={() => {
                                            notification.action?.onClick();
                                            setNotification(null);
                                        }}
                                        className="underline hover:no-underline"
                                    >
                                        {notification.action.label}
                                    </button>
                                )}
                                <button onClick={() => setNotification(null)} className="ml-2 opacity-80 hover:opacity-100">
                                    ✕
                                </button>
                            </div>
                        </div>
                    )}
                    {activeView === 'chat' && (
                        <ChatArea
                            messages={messages}
                            loading={isAnswering}
                            onSend={handleSend}
                            model={selectedModel}
                            availableModels={availableModels}
                            onModelChange={setActiveModel}
                            onAddLocalModel={addLocalModel}
                            onReferenceOpen={handleReferenceOpen}
                            agentContext={agentContext}
                            onResetConversation={handleResetConversation}
                            currentSessionId={currentSessionId}
                            title={currentSession?.title}
                            files={visibleFiles}
                            onResume={handleResumeSearch}
                        />
                    )}
                    {activeView === 'knowledge' && (
                        <KnowledgeBase
                            folders={visibleFolders}
                            folderStats={folderStats}
                            files={visibleFiles}
                            snapshot={snapshot}
                            isIndexing={isIndexing}
                            indexProgress={progress}
                            stageProgress={stageProgress}
                            onStartSemantic={startSemanticIndexing}
                            onStopSemantic={stopSemanticIndexing}
                            onStartDeep={startDeepIndexing}
                            onStopDeep={stopDeepIndexing}
                            onAddFolder={handleAddFolder}
                            onAddFile={handleAddFile}
                            onRemoveFolder={handleRemoveFolder}
                            onRescanFolder={handleRescanFolder}
                            onReindexFolder={handleReindexFolder}
                            indexingItems={indexingItems}
                            onSelectFile={(file) => {
                                setSelectedFile(file);
                                requestRightPanelTab('preview');
                            }}
                            onOpenFile={handleOpenFile}
                            onAskAboutFile={handleAskAboutFile}
                            onRefresh={refreshData}
                        />
                    )}
                    {activeView === 'extensions' && (
                        <div className="h-full overflow-hidden">
                            <ExtensionsView />
                        </div>
                    )}
                    {activeView === 'memory' && (
                        <UserMemory />
                    )}
                    {activeView === 'models' && (
                        <SettingsPanel initialTab="models" />
                    )}
                    {activeView === 'settings' && (
                        <SettingsPanel initialTab="general" />
                    )}
                    {activeView === 'mbti' && (
                        <MbtiAnalysis
                            isAnalyzing={isAnalyzing}
                            isGeneratingReport={isGeneratingReport}
                            progress={mbtiProgress}
                            result={mbtiResult}
                            error={mbtiError}
                            filterProgress={filterProgress}
                            embedProgress={embedProgress}
                            onStartAnalysis={startMbtiAnalysis}
                            onStartAnalysisWithFilter={startAnalysisWithFilter}
                            onStopAnalysis={stopMbtiAnalysis}
                            onResetAnalysis={resetMbtiAnalysis}
                            setProgress={setMbtiProgress}
                            files={visibleFiles}
                        />
                    )}



                    <OnboardingGuide
                        isOpen={isOnboardingOpen}
                        onClose={() => setIsOnboardingOpen(false)}
                        onComplete={handleOnboardingComplete}
                        onNavigate={handleViewSelect}
                        modelsReady={modelsReady}
                        onDownloadModels={handleManualModelDownload}
                        modelDownloadEvent={modelDownloadEvent}
                    />
                </AppLayout>
            )}
            <ModelManagerModal
                isOpen={isModelModalOpen && !isOnboardingOpen}
                onClose={() => {
                    if (modelsReady) {
                        setIsModelModalOpen(false);
                    }
                }}
            />
        </>
    );
}
