import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchHit, NoteSummary, NoteContent } from '../types';
import { QuickSearchPalette } from './QuickSearchPalette';
import { useModelConfig } from '../hooks/useModelConfig';

type PaletteTab = 'search' | 'notes';

const RESULT_LIMIT = 20;

type SpotlightFilePayload = { fileId: string };
type SpotlightMode = 'rag' | 'qa';

// Search stage labels for UI display
const STAGE_LABELS: Record<string, string> = {
    filename: 'Searching filenames...',
    summary: 'Searching summaries...',
    metadata: 'Searching metadata...',
    hybrid: 'Deep semantic search...',
    complete: 'Search complete'
};

export function QuickSearchShell() {
    const { config } = useModelConfig();
    const [mode, setMode] = useState<SpotlightMode>('rag');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchHit[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [qaAnswer, setQaAnswer] = useState<string | null>(null);
    const [qaMeta, setQaMeta] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>('File search mode · type to search indexed files.');
    const [searchContext, setSearchContext] = useState<{ rewritten?: string | null; strategy?: string | null; latencyMs?: number | null; variants?: string[] } | null>(null);
    const [currentSearchStage, setCurrentSearchStage] = useState<string | null>(null);
    // Track when each file was first seen (fileId -> latencyMs)
    const [fileFirstSeenMs, setFileFirstSeenMs] = useState<Record<string, number>>({});
    const pendingRequestIdRef = useRef(0);

    const cancelStreamRef = useRef<(() => void) | null>(null);

    // Progressive search state
    const [needsUserDecision, setNeedsUserDecision] = useState(false);
    const [resumeToken, setResumeToken] = useState<string | null>(null);

    // Tab state
    const [activeTab, setActiveTab] = useState<PaletteTab>('search');

    // Notes state
    const [notes, setNotes] = useState<NoteSummary[]>([]);
    const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
    const [selectedNote, setSelectedNote] = useState<NoteContent | null>(null);
    const [isNotesLoading, setIsNotesLoading] = useState(false);
    const [isNoteSaving, setIsNoteSaving] = useState(false);

    useEffect(() => {
        document.body.classList.add('spotlight-shell');
        return () => {
            document.body.classList.remove('spotlight-shell');
        };
    }, []);

    // Listen for tab switch commands from main process (for tray menu)
    useEffect(() => {
        const api = window.api;
        if (!api?.onSpotlightTabSwitch) return;

        const cleanup = api.onSpotlightTabSwitch((payload) => {
            if (payload?.tab) {
                setActiveTab(payload.tab);
            }
        });

        return cleanup;
    }, []);

    // Load notes when switching to notes tab
    const loadNotes = useCallback(async () => {
        const api = window.api;
        if (!api?.listNotes) return;

        setIsNotesLoading(true);
        try {
            const notesList = await api.listNotes();
            setNotes(notesList);
        } catch (error) {
            console.error('Failed to load notes:', error);
        } finally {
            setIsNotesLoading(false);
        }
    }, []);

    useEffect(() => {
        if (activeTab === 'notes') {
            void loadNotes();
        }
    }, [activeTab, loadNotes]);

    // Load selected note content
    const handleSelectNote = useCallback(async (noteId: string) => {
        const api = window.api;
        if (!api?.getNote) return;

        setSelectedNoteId(noteId);
        setIsNotesLoading(true);
        try {
            const note = await api.getNote(noteId);
            setSelectedNote(note);
        } catch (error) {
            console.error('Failed to load note:', error);
        } finally {
            setIsNotesLoading(false);
        }
    }, []);

    // Notify other windows that notes have changed
    const notifyNotesChanged = useCallback(() => {
        window.api?.notifyNotesChanged?.();
    }, []);

    // Create new note (don't notify - will notify when exiting edit mode)
    const handleCreateNote = useCallback(async () => {
        const api = window.api;
        if (!api?.createNote) return;

        try {
            const now = new Date();
            const defaultTitle = `${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            const newNote = await api.createNote({ title: defaultTitle, body: '' });
            await loadNotes();
            await handleSelectNote(newNote.id);
            // Don't notify here - will notify when exiting edit mode
        } catch (error) {
            console.error('Failed to create note:', error);
        }
    }, [loadNotes, handleSelectNote]);

    // Save note (without notifying - notification happens on exit)
    const handleSaveNote = useCallback(async (noteId: string, payload: { title: string; body: string }) => {
        const api = window.api;
        if (!api?.updateNote) return;

        setIsNoteSaving(true);
        try {
            const updated = await api.updateNote(noteId, payload);
            setSelectedNote(updated);
            await loadNotes();
            // Don't notify here - will notify when exiting edit mode
        } catch (error) {
            console.error('Failed to save note:', error);
        } finally {
            setIsNoteSaving(false);
        }
    }, [loadNotes]);

    // Delete note
    const handleDeleteNote = useCallback(async (noteId: string) => {
        const api = window.api;
        if (!api?.deleteNote) return;

        try {
            await api.deleteNote(noteId);
            setSelectedNoteId(null);
            setSelectedNote(null);
            await loadNotes();
            notifyNotesChanged();
        } catch (error) {
            console.error('Failed to delete note:', error);
        }
    }, [loadNotes, notifyNotesChanged]);

    // Back to notes list - notify other windows to refresh (for indexing)
    const handleBackToNotesList = useCallback(() => {
        setSelectedNoteId(null);
        setSelectedNote(null);
        // Notify when exiting edit mode so main window can refresh and re-index
        notifyNotesChanged();
    }, [notifyNotesChanged]);

    const runQuery = useCallback(
        async (value: string, modeOverride?: SpotlightMode, resumeTokenArg?: string) => {
            const currentMode = modeOverride ?? mode;
            const requestId = ++pendingRequestIdRef.current;
            const trimmed = value.trim();

            // Cancel any ongoing stream
            if (cancelStreamRef.current) {
                cancelStreamRef.current();
                cancelStreamRef.current = null;
            }

            if (!trimmed) {
                setIsSearching(false);
                setResults([]);
                setQaAnswer(null);
                setQaMeta(null);
                setSearchContext(null);
                setFileFirstSeenMs({});
                setStatusMessage(
                    currentMode === 'qa'
                        ? 'Agent QA mode · ask a question about your local files.'
                        : 'File search mode · type to search indexed files.'
                );
                return;
            }

            const api = window.api;
            if (!api) {
                console.warn('Desktop bridge unavailable.');
                setStatusMessage('Desktop bridge unavailable.');
                setIsSearching(false);
                return;
            }

            if (currentMode === 'rag' && !api.searchStream && !api.search) {
                console.warn('Quick search bridge unavailable.');
                setStatusMessage('Search bridge unavailable.');
                setIsSearching(false);
                return;
            }

            if (currentMode === 'qa' && !api.askStream) {
                console.warn('QA bridge unavailable.');
                setStatusMessage('QA bridge unavailable.');
                setIsSearching(false);
                return;
            }

            setIsSearching(true);
            if (currentMode === 'rag') {
                setQaAnswer(null);
                setQaMeta(null);
                setSearchContext(null);
                setCurrentSearchStage(null);
                setFileFirstSeenMs({});
                setNeedsUserDecision(false);
                setResumeToken(null);
            } else {
                // QA Mode initialization
                if (!resumeTokenArg) {
                    setQaAnswer('');
                    setResults([]);
                    setQaMeta(null);
                    setSearchContext(null);
                    setCurrentSearchStage(null);
                }
                setNeedsUserDecision(false);
                setResumeToken(null);
            }

            try {
                if (currentMode === 'rag') {
                    // Use streaming search for progressive results
                    if (api.searchStream) {
                        let buffer = '';
                        let accumulatedHits: SearchHit[] = [];
                        let latestStage = '';
                        // Track file first seen times locally
                        const fileTimings: Record<string, number> = {};

                        const cancel = api.searchStream(trimmed, RESULT_LIMIT, {
                            onData: (chunk) => {
                                if (pendingRequestIdRef.current !== requestId) return;
                                buffer += chunk;
                                const lines = buffer.split('\n');
                                buffer = lines.pop() || '';

                                for (const line of lines) {
                                    if (!line.trim()) continue;
                                    try {
                                        const msg = JSON.parse(line);
                                        const stage = msg.stage as string;
                                        const hits = msg.hits as SearchHit[];
                                        const done = msg.done as boolean;
                                        const stageLatencyMs = msg.latencyMs as number;
                                        latestStage = stage;

                                        if (hits && hits.length > 0) {
                                            // Record first seen time for each new file
                                            for (const hit of hits) {
                                                if (!fileTimings[hit.fileId]) {
                                                    fileTimings[hit.fileId] = stageLatencyMs;
                                                }
                                            }
                                            // Update file timings state
                                            setFileFirstSeenMs({ ...fileTimings });

                                            // Merge new hits with accumulated hits
                                            accumulatedHits = [...accumulatedHits, ...hits];
                                            setResults([...accumulatedHits]);
                                            setCurrentSearchStage(stage);
                                            setStatusMessage(STAGE_LABELS[stage] || `Found ${accumulatedHits.length} results`);
                                        } else if (!done) {
                                            // Update stage status even if no new hits
                                            setCurrentSearchStage(stage);
                                            setStatusMessage(STAGE_LABELS[stage] || 'Searching...');
                                        }

                                        if (done) {
                                            setSearchContext({
                                                rewritten: null,
                                                strategy: latestStage,
                                                latencyMs: null, // We show time per file now
                                                variants: []
                                            });
                                            setCurrentSearchStage(null);
                                            setIsSearching(false);
                                            cancelStreamRef.current = null;
                                        }
                                    } catch (e) {
                                        console.error('Failed to parse search stream line', e, line);
                                    }
                                }
                            },
                            onError: (err) => {
                                if (pendingRequestIdRef.current !== requestId) return;
                                console.error('Stream search failed', err);
                                setStatusMessage('Search failed. Check the backend.');
                                setIsSearching(false);
                                setCurrentSearchStage(null);
                                cancelStreamRef.current = null;
                            },
                            onDone: () => {
                                if (pendingRequestIdRef.current !== requestId) return;
                                setIsSearching(false);
                                setCurrentSearchStage(null);
                                cancelStreamRef.current = null;
                            }
                        });
                        cancelStreamRef.current = cancel;
                    } else {
                        // Fallback to non-streaming search
                        const response = await api.search(trimmed, RESULT_LIMIT);
                        if (pendingRequestIdRef.current === requestId) {
                            const nextHits = Array.isArray(response?.hits) ? response.hits : [];
                            setResults(nextHits);
                            setSearchContext({
                                rewritten: response?.rewrittenQuery ?? null,
                                strategy: response?.strategy ?? null,
                                latencyMs: response?.latencyMs ?? null,
                                variants: response?.queryVariants ?? []
                            });
                            setStatusMessage(
                                nextHits.length
                                    ? `${nextHits.length} result${nextHits.length === 1 ? '' : 's'}`
                                    : 'No matching files yet.'
                            );
                            setIsSearching(false);
                        }
                    }
                } else {
                    // QA Streaming Mode
                    const qaLimit = config?.qaContextLimit ?? 5;
                    let buffer = '';
                    const cancel = api.askStream(trimmed, qaLimit, 'qa', {
                        onData: (chunk) => {
                            if (pendingRequestIdRef.current !== requestId) return;
                            buffer += chunk;
                            const lines = buffer.split('\n');
                            buffer = lines.pop() || '';

                            for (const line of lines) {
                                if (!line.trim()) continue;
                                try {
                                    const msg = JSON.parse(line);
                                    if (msg.type === 'token') {
                                        setQaAnswer(prev => (prev || '') + msg.data);
                                    } else if (msg.type === 'user_decision_required') {
                                        setNeedsUserDecision(true);
                                        setResumeToken(msg.resume_token || null);
                                        if (msg.message) setStatusMessage(msg.message);
                                        setIsSearching(false);
                                        // Don't clear cancelStreamRef, or maybe we should?
                                        // The backend pauses, but the stream is effectively done for now.
                                    } else if (msg.type === 'hits') {
                                        setResults(msg.data);
                                        setStatusMessage(`${msg.data.length} sources found.`);
                                    } else if (msg.type === 'chunk_analysis_item') {
                                        // Handle streaming single chunk analysis - update as each result arrives
                                        const item = msg.data as {
                                            index: number;
                                            has_answer: boolean;
                                            comment: string | null;
                                            confidence: number;
                                            file_id?: string;
                                            chunk_id?: string;
                                            progress?: number;
                                        };
                                        setResults(prev => prev.map((hit, idx) => {
                                            // Match by chunk_id (most precise) or index
                                            // Do NOT use file_id alone - multiple chunks from same file would all match!
                                            const hitChunkId = (hit as any).chunk_id || (hit as any).chunkId;

                                            let matches = false;
                                            if (item.chunk_id && hitChunkId && item.chunk_id === hitChunkId) {
                                                // Precise chunk_id match
                                                matches = true;
                                            } else if (item.index === idx + 1) {
                                                // Fallback to index-based matching
                                                matches = true;
                                            }

                                            if (matches) {
                                                return {
                                                    ...hit,
                                                    analysisComment: item.comment,
                                                    hasAnswer: item.has_answer,
                                                    analysisConfidence: item.confidence,
                                                    analysisProgress: item.progress
                                                };
                                            }
                                            return hit;
                                        }));
                                        // Update status with progress
                                        if (item.progress !== undefined) {
                                            const percent = Math.round(item.progress * 100);
                                            setStatusMessage(`Analyzing sources... ${percent}%`);
                                        }
                                    } else if (msg.type === 'chunk_analysis') {
                                        // Merge chunk analysis into results (batch update for backward compat)
                                        const analysisData = msg.data as Array<{
                                            index: number;
                                            has_answer: boolean;
                                            comment: string | null;
                                            confidence: number;
                                        }>;
                                        setResults(prev => prev.map((hit, idx) => {
                                            const analysis = analysisData.find(a => a.index === idx + 1);
                                            if (analysis) {
                                                return {
                                                    ...hit,
                                                    analysisComment: analysis.comment,
                                                    hasAnswer: analysis.has_answer,
                                                    analysisConfidence: analysis.confidence
                                                };
                                            }
                                            return hit;
                                        }));
                                    } else if (msg.type === 'status') {
                                        if (msg.data === 'searching') setStatusMessage('Searching files...');
                                        else if (msg.data === 'answering') setStatusMessage('Generating answer...');
                                        else if (msg.data === 'no_results') setStatusMessage('No relevant information found.');
                                        else if (msg.data === 'synthesizing_answer') setStatusMessage('Synthesizing answer...');
                                        else {
                                            // Handle dynamic patterns like "analyzing_X_chunks"
                                            const analyzingMatch = msg.data?.match(/analyzing_(\d+)_chunks/);
                                            if (analyzingMatch) {
                                                setStatusMessage(`Analyzing ${analyzingMatch[1]} sources...`);
                                            }
                                        }
                                    } else if (msg.type === 'error') {
                                        setStatusMessage(`Error: ${msg.data}`);
                                    } else if (msg.type === 'done') {
                                        setIsSearching(false);
                                        cancelStreamRef.current = null;
                                    }
                                } catch (e) {
                                    console.error('Failed to parse stream line', e);
                                }
                            }
                        },
                        onError: (err) => {
                            if (pendingRequestIdRef.current !== requestId) return;
                            console.error('Spotlight query failed', err);
                            setStatusMessage('Agent QA failed. Check the backend.');
                            setIsSearching(false);
                            cancelStreamRef.current = null;
                        },
                        onDone: () => {
                            if (pendingRequestIdRef.current !== requestId) return;
                            setIsSearching(false);
                            cancelStreamRef.current = null;
                        }
                    }, 'auto', resumeTokenArg);
                    cancelStreamRef.current = cancel;
                }
            } catch (error) {
                console.error('Spotlight query failed', error);
                if (pendingRequestIdRef.current === requestId) {
                    setResults([]);
                    setSearchContext(null);
                    if (currentMode === 'qa') {
                        setQaAnswer(null);
                        setQaMeta(null);
                        setStatusMessage('Agent QA failed. Check the backend.');
                    } else {
                        setStatusMessage('Search failed. Check the backend.');
                    }
                    setIsSearching(false);
                }
            }
        },
        [mode, config]
    );

    const handleClose = useCallback(() => {
        pendingRequestIdRef.current += 1;
        if (cancelStreamRef.current) {
            cancelStreamRef.current();
            cancelStreamRef.current = null;
        }
        setMode('rag');
        setQuery('');
        setResults([]);
        setIsSearching(false);
        setQaAnswer(null);
        setQaMeta(null);
        setSearchContext(null);
        setStatusMessage('File search mode · type to search indexed files.');
        setNeedsUserDecision(false);
        setResumeToken(null);
        const hideSpotlight = window.api?.hideSpotlightWindow;
        if (hideSpotlight) {
            hideSpotlight();
        } else {
            window.close();
        }
    }, []);

    const handleSelect = useCallback(
        (hit: SearchHit) => {
            const payload: SpotlightFilePayload = { fileId: hit.fileId };
            const focusFile = window.api?.spotlightFocusFile;
            if (!focusFile) {
                console.warn('Spotlight focus handler unavailable.');
                handleClose();
                return;
            }
            focusFile(payload.fileId);
            handleClose();
        },
        [handleClose]
    );

    const handleOpen = useCallback(
        async (hit: SearchHit) => {
            // Try to open directly if path is available
            const metadata = hit.metadata || {};
            const path = (metadata.path || metadata.file_path || metadata.full_path) as string;

            if (path && window.api?.openFile) {
                try {
                    await window.api.openFile(path);
                    handleClose();
                    return;
                } catch (e) {
                    console.error('Failed to open file directly', e);
                }
            }

            // Fallback to main window delegation
            const payload: SpotlightFilePayload = { fileId: hit.fileId };
            const openFile = window.api?.spotlightOpenFile;
            if (!openFile) {
                console.warn('Spotlight open handler unavailable.');
                handleClose();
                return;
            }
            openFile(payload.fileId);
            handleClose();
        },
        [handleClose]
    );

    useEffect(() => {
        if (mode !== 'rag') {
            return undefined;
        }
        const timer = window.setTimeout(() => {
            void runQuery(query);
        }, 300);
        return () => {
            window.clearTimeout(timer);
        };
    }, [mode, query, runQuery]);

    useEffect(() => {
        setResults([]);
        setQaAnswer(null);
        setQaMeta(null);
        setStatusMessage(
            mode === 'qa'
                ? 'Agent QA mode · ask a question about your local files.'
                : 'File search mode · type to search indexed files.'
        );
    }, [mode]);

    const handleModeChange = useCallback(
        (nextMode: SpotlightMode) => {
            if (nextMode === mode) {
                return;
            }
            pendingRequestIdRef.current += 1;
            if (cancelStreamRef.current) {
                cancelStreamRef.current();
                cancelStreamRef.current = null;
            }
            setMode(nextMode);
        },
        [mode]
    );

    const handleQueryChange = useCallback((newQuery: string) => {
        setQuery(newQuery);
        setNeedsUserDecision(false);
        setResumeToken(null);
        if (mode === 'qa') {
            setMode('rag');
        }
    }, [mode]);

    const handleResumeSearch = useCallback(() => {
        if (resumeToken) {
            void runQuery(query, 'qa', resumeToken);
        }
    }, [resumeToken, query, runQuery]);

    return (
        <QuickSearchPalette
            open
            query={query}
            results={results}
            isSearching={isSearching}
            mode={mode}
            onModeChange={handleModeChange}
            qaAnswer={qaAnswer}
            qaMeta={qaMeta}
            statusMessage={statusMessage}
            searchContext={searchContext}
            searchStage={currentSearchStage}
            fileFirstSeenMs={fileFirstSeenMs}
            onChange={handleQueryChange}
            onClose={handleClose}
            onSubmit={(value) => {
                setMode('qa');
                void runQuery(value, 'qa');
            }}
            needsUserDecision={needsUserDecision}
            onResumeSearch={handleResumeSearch}
            resumeToken={resumeToken}
            onSelect={handleSelect}
            onOpen={handleOpen}
            // Notes props
            activeTab={activeTab}
            onTabChange={setActiveTab}
            notes={notes}
            selectedNote={selectedNote}
            isNotesLoading={isNotesLoading}
            isNoteSaving={isNoteSaving}
            onSelectNote={handleSelectNote}
            onCreateNote={handleCreateNote}
            onSaveNote={handleSaveNote}
            onDeleteNote={handleDeleteNote}
            onBackToNotesList={handleBackToNotesList}
        />
    );
}

