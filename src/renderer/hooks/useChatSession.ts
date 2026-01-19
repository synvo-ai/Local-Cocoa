import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { ChatSession, ConversationMessage, SearchHit, ThinkingStep, ThinkingStepHit } from '../types';
import { useModelConfig } from './useModelConfig';
import type { SearchMode } from '../components/ConversationPanel';

interface AgentContextState {
    original: string;
    rewritten?: string | null;
    variants: string[];
    latencyMs?: number | null;
    status: 'idle' | 'pending' | 'ok' | 'error';
}

const LOCAL_MODEL_LABEL = 'local-llm';

export function useChatSession() {
    const { config } = useModelConfig();
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    const [agentContext, setAgentContext] = useState<AgentContextState | null>(null);
    const [isAnswering, setIsAnswering] = useState(false);
    const askSessionRef = useRef(0);

    // Load sessions from DB on mount
    useEffect(() => {
        let mounted = true;

        const loadSessions = async (retryCount = 0) => {
            const api = window.api;
            if (!api?.listChatSessions) return;
            try {
                const loaded = await api.listChatSessions(50); // Load last 50 sessions
                if (mounted) {
                    setSessions(loaded);
                    if (loaded.length > 0 && !currentSessionId) {
                        setCurrentSessionId(loaded[0].id);
                    }
                }
            } catch (e) {
                // Only log after a few retries to reduce noise during startup
                if (retryCount >= 3) {
                    console.error(`Failed to load sessions (attempt ${retryCount + 1})`, e);
                }
                // Retry on failure (e.g. backend not ready yet)
                // Increase max retries for dev mode where backend startup can be slow
                if (mounted && retryCount < 10) {
                    const timeout = Math.min(1000 * Math.pow(1.5, retryCount), 8000); // Gentler exponential backoff
                    setTimeout(() => loadSessions(retryCount + 1), timeout);
                }
            }
        };

        // Initial delay to give backend time to start
        // This reduces unnecessary early retries during startup
        const initialDelay = setTimeout(() => loadSessions(), 1000);

        return () => {
            mounted = false;
            clearTimeout(initialDelay);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const currentSession = useMemo(() =>
        sessions.find(s => s.id === currentSessionId),
        [sessions, currentSessionId]);

    const messages = currentSession?.messages ?? [];

    const handleCreateSession = useCallback(async () => {
        const api = window.api;
        if (!api?.createChatSession) return;
        try {
            const newSession = await api.createChatSession('New Chat');
            setSessions(prev => [newSession, ...prev]);
            setCurrentSessionId(newSession.id);
            setAgentContext(null);
            setIsAnswering(false);
        } catch (e) {
            console.error('Failed to create session', e);
        }
    }, []);

    const handleDeleteSession = useCallback(async (sessionId: string) => {
        const api = window.api;
        if (!api?.deleteChatSession) return;
        try {
            await api.deleteChatSession(sessionId);
            setSessions(prev => prev.filter(s => s.id !== sessionId));
            if (currentSessionId === sessionId) {
                setCurrentSessionId(null);
                setAgentContext(null);
            }
        } catch (e) {
            console.error('Failed to delete session', e);
        }
    }, [currentSessionId]);

    const handleSelectSession = useCallback((sessionId: string) => {
        setCurrentSessionId(sessionId);
        setAgentContext(null);
    }, []);

    const handleResetConversation = useCallback(() => {
        void handleCreateSession();
    }, [handleCreateSession]);

    const generateTitle = useCallback(async (sessionId: string, firstMessage: string, answer: string) => {
        const api = window.api;
        if (!api?.ask || !api?.updateChatSession) return;

        // Always use both user question and AI answer to generate title
        // But guide the LLM to focus on the topic/question, not the answer status
        const prompt = `Generate a short, descriptive title (3-6 words) for this conversation.
Focus on the TOPIC or SUBJECT the user is asking about, not whether an answer was found.
Do not use quotes. Do not say "Unknown" or "Untitled".

User question: ${firstMessage}
AI response: ${answer.slice(0, 200)}

Title:`;

        try {
            const response = await api.ask(prompt, 1, 'chat');
            const newTitle = response.answer?.trim().replace(/^["']|["']$/g, '');

            // Validate the generated title
            const isBadTitle = !newTitle ||
                newTitle.length < 3 ||
                newTitle.toLowerCase() === 'unknown' ||
                newTitle.toLowerCase() === 'untitled' ||
                newTitle.toLowerCase().includes('no title') ||
                newTitle.toLowerCase().includes('cannot');

            if (!isBadTitle) {
                await api.updateChatSession(sessionId, newTitle);
                setSessions(prev => prev.map(s => {
                    if (s.id === sessionId) {
                        return { ...s, title: newTitle };
                    }
                    return s;
                }));
            }
            // If bad title, just keep the default "New Chat" - it's better than a bad generated title
        } catch (e) {
            console.warn('Failed to generate title', e);
            // Keep default title on error
        }
    }, []);

    const handleSend = useCallback(
        async (text: string, searchMode: SearchMode = 'auto') => {
            const api = window.api;
            const timestamp = new Date().toISOString();
            const modelLabel = LOCAL_MODEL_LABEL;
            const userMessage: ConversationMessage = {
                role: 'user',
                text,
                timestamp,
                meta: modelLabel
            };
            const requestId = askSessionRef.current + 1;
            askSessionRef.current = requestId;

            let targetSessionId = currentSessionId;
            let shouldGenerateTitle = false;

            // Create session if none exists
            if (!targetSessionId) {
                shouldGenerateTitle = true;
                if (api?.createChatSession) {
                    try {
                        const newSession = await api.createChatSession('New Chat');
                        setSessions(prev => [newSession, ...prev]);
                        targetSessionId = newSession.id;
                        setCurrentSessionId(targetSessionId);
                    } catch (e) {
                        console.error('Failed to create session on send', e);
                        return;
                    }
                } else {
                    // Fallback if API missing (shouldn't happen)
                    return;
                }
            } else {
                const session = sessions.find(s => s.id === targetSessionId);
                if (session && session.messages.length === 0) {
                    shouldGenerateTitle = true;
                }
            }

            // Optimistic update for user message
            setSessions(prev => prev.map(s => {
                if (s.id === targetSessionId) {
                    return { ...s, messages: [...s.messages, userMessage], updatedAt: new Date().toISOString() };
                }
                return s;
            }));

            // Persist user message
            if (api?.addChatMessage && targetSessionId) {
                void api.addChatMessage(targetSessionId, userMessage).catch(e => console.error('Failed to persist user message', e));
            }

            setIsAnswering(true);
            setAgentContext({
                original: text,
                rewritten: null,
                variants: [],
                latencyMs: null,
                status: 'pending'
            });

            if (!api?.askStream) {
                // Fallback to non-streaming if stream API not available
                if (!api?.ask) {
                    const errorMsg = 'Desktop bridge unavailable. Please relaunch the app.';
                    const errorAssistantMsg: ConversationMessage = {
                        role: 'assistant',
                        text: errorMsg,
                        timestamp: new Date().toISOString()
                    };
                    setSessions(prev => prev.map(s => {
                        if (s.id === targetSessionId) {
                            return {
                                ...s,
                                messages: [...s.messages, errorAssistantMsg]
                            };
                        }
                        return s;
                    }));
                    setAgentContext({
                        original: text,
                        rewritten: null,
                        variants: [],
                        latencyMs: null,
                        status: 'error'
                    });
                    setIsAnswering(false);
                    return;
                }

                try {
                    const limit = config?.qaContextLimit ?? 5;
                    const response = await api.ask(text, limit, 'qa', searchMode);
                    const answer = response.answer?.trim() || 'The backend returned an empty answer.';
                    const hits = response.hits ?? [];
                    const metaParts: string[] = [];
                    if (hits.length) {
                        metaParts.push(`${hits.length} source${hits.length === 1 ? '' : 's'}`);
                    }
                    if (typeof response.latencyMs === 'number' && Number.isFinite(response.latencyMs)) {
                        metaParts.push(`${response.latencyMs} ms`);
                    }

                    const assistantMessage: ConversationMessage = {
                        role: 'assistant',
                        text: answer,
                        timestamp: new Date().toISOString(),
                        references: hits,
                        meta: metaParts.length ? metaParts.join(' · ') : undefined,
                        steps: response.diagnostics?.steps,
                        diagnosticsSummary: response.diagnostics?.summary ?? null
                    };

                    setSessions(prev => prev.map(s => {
                        if (s.id === targetSessionId) {
                            return {
                                ...s,
                                messages: [...s.messages, assistantMessage],
                                updatedAt: new Date().toISOString()
                            };
                        }
                        return s;
                    }));

                    // Persist assistant message
                    if (api?.addChatMessage && targetSessionId) {
                        void api.addChatMessage(targetSessionId, assistantMessage).catch(e => console.error('Failed to persist assistant message', e));
                    }

                    if (askSessionRef.current === requestId) {
                        setAgentContext({
                            original: text,
                            rewritten: response.rewrittenQuery ?? null,
                            variants: response.queryVariants ?? [],
                            latencyMs: response.latencyMs ?? null,
                            status: 'ok'
                        });

                        if (shouldGenerateTitle) {
                            void generateTitle(targetSessionId!, text, answer);
                        }
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'The backend is offline.';
                    const errorMsg: ConversationMessage = {
                        role: 'assistant',
                        text: message,
                        timestamp: new Date().toISOString(),
                        meta: 'Error'
                    };
                    setSessions(prev => prev.map(s => {
                        if (s.id === targetSessionId) {
                            return {
                                ...s,
                                messages: [...s.messages, errorMsg]
                            };
                        }
                        return s;
                    }));
                    if (askSessionRef.current === requestId) {
                        setAgentContext({
                            original: text,
                            rewritten: null,
                            variants: [],
                            latencyMs: null,
                            status: 'error'
                        });
                    }
                } finally {
                    if (askSessionRef.current === requestId) {
                        setIsAnswering(false);
                    }
                }
                return;
            }

            // Streaming implementation
            let currentAnswer = '';
            let currentHits: SearchHit[] = [];
            let buffer = ''; // Buffer to accumulate incomplete JSON lines
            let currentMeta: string | undefined = 'Thinking...';

            // Create a placeholder message
            const placeholderTimestamp = new Date().toISOString();
            const placeholderMessage: ConversationMessage = {
                role: 'assistant',
                text: '',
                timestamp: placeholderTimestamp,
                meta: 'Thinking...'
            };

            setSessions(prev => prev.map(s => {
                if (s.id === targetSessionId) {
                    return {
                        ...s,
                        messages: [...s.messages, placeholderMessage]
                    };
                }
                return s;
            }));

            const maybeNotifyContextTooLarge = (rawMessage: unknown) => {
                const errorText = String(rawMessage ?? '');
                const lower = errorText.toLowerCase();
                if (!lower.includes('exceeds the available context size') && !lower.includes('available context size')) {
                    return;
                }
                window.dispatchEvent(new CustomEvent('synvo:notify', {
                    detail: {
                        message: 'This request is too large for the model context window. Try lowering Vision Performance (Max Resolution) or increasing Context Size in Models.',
                        action: {
                            label: 'Model Settings',
                            onClick: () => window.dispatchEvent(new CustomEvent('synvo:navigate', { detail: { view: 'models' } }))
                        }
                    }
                }));
            };

            const updateMessage = (updates: Partial<ConversationMessage>) => {
                setSessions(prev => prev.map(s => {
                    if (s.id === targetSessionId) {
                        const msgs = [...s.messages];
                        const lastIdx = msgs.length - 1;
                        if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
                            msgs[lastIdx] = { ...msgs[lastIdx], ...updates };
                        }
                        return { ...s, messages: msgs };
                    }
                    return s;
                }));
            };

            const limit = config?.qaContextLimit ?? 5;
            let currentThinkingSteps: ThinkingStep[] = [];
            let isMultiPath = false;
            let needsUserDecision = false;
            let resumeToken: string | null = null;
            let decisionMessage: string | undefined;

            api.askStream(text, limit, 'qa', {
                onData: (chunkStr) => {
                    if (askSessionRef.current !== requestId) return;

                    // Add chunk to buffer
                    buffer += chunkStr;

                    // Split by newlines and process complete lines
                    const lines = buffer.split('\n');

                    // Keep the last incomplete line in the buffer
                    buffer = lines.pop() || '';

                    // Process complete lines
                    for (const line of lines) {
                        if (!line.trim()) continue;

                        try {
                            const payload = JSON.parse(line);

                            // Handle multi-path thinking events
                            if (payload.type === 'multi_path_start') {
                                isMultiPath = true;
                                currentThinkingSteps = [];
                                updateMessage({ isMultiPath: true, thinkingSteps: [] });
                            } else if (payload.type === 'multi_path_end') {
                                // Mark all steps as complete
                                currentThinkingSteps = currentThinkingSteps.map(s => ({
                                    ...s,
                                    status: s.status === 'running' ? 'complete' : s.status
                                })) as ThinkingStep[];
                                updateMessage({ thinkingSteps: [...currentThinkingSteps] });
                            } else if (payload.type === 'thinking_step') {
                                const stepData = payload.data;
                                const existingIdx = currentThinkingSteps.findIndex(s => s.id === stepData.id);

                                // Use new hits if provided, otherwise preserve existing hits
                                const existingHits = existingIdx >= 0 ? currentThinkingSteps[existingIdx].hits : undefined;
                                const newHits = stepData.hits || existingHits;

                                const newStep: ThinkingStep = {
                                    id: stepData.id,
                                    type: stepData.type,
                                    title: stepData.title,
                                    status: stepData.status,
                                    summary: stepData.summary,
                                    details: stepData.details,
                                    subQuery: stepData.subQuery || stepData.sub_query,
                                    subQueryAnswer: stepData.subQueryAnswer || stepData.sub_query_answer,
                                    hits: newHits,  // Use new hits from stepData if provided
                                    timestampMs: stepData.timestamp_ms || stepData.timestampMs,  // Step timing
                                    metadata: {
                                        subQueryIndex: stepData.metadata?.subQueryIndex || stepData.metadata?.sub_query_index,
                                        totalSubQueries: stepData.metadata?.totalSubQueries || stepData.metadata?.total_sub_queries,
                                        resultsCount: stepData.metadata?.resultsCount || stepData.metadata?.results_count,
                                        relevantCount: stepData.metadata?.relevantCount || stepData.metadata?.relevant_count,
                                        strategy: stepData.metadata?.strategy,
                                        sources: stepData.metadata?.sources,
                                        // Also include new metadata fields for rich display
                                        sub_queries: stepData.metadata?.sub_queries,
                                        keywords: stepData.metadata?.keywords,
                                        candidates: stepData.metadata?.candidates,
                                        verification_results: stepData.metadata?.verification_results,
                                        best_answer: stepData.metadata?.best_answer,
                                        confidence: stepData.metadata?.confidence,
                                        chunks: stepData.metadata?.chunks,
                                    }
                                };

                                // Update or add step
                                if (existingIdx >= 0) {
                                    currentThinkingSteps[existingIdx] = newStep;
                                } else {
                                    currentThinkingSteps.push(newStep);
                                }
                                updateMessage({ thinkingSteps: [...currentThinkingSteps] });
                            } else if (payload.type === 'user_decision_required') {
                                needsUserDecision = true;
                                resumeToken = payload.resume_token;
                                decisionMessage = payload.message;
                                updateMessage({
                                    needsUserDecision: true,
                                    resumeToken: payload.resume_token,
                                    decisionMessage: payload.message,
                                    meta: 'Waiting for confirmation...'
                                });
                            } else if (payload.type === 'status') {
                                // Map status codes to user-friendly messages
                                const statusMessages: Record<string, string> = {
                                    'searching': 'Searching...',
                                    'answering': 'Generating answer...',
                                    'decomposing_query': 'Decomposing query...',
                                    'merging_results': 'Merging results...',
                                    'synthesizing_answer': 'Synthesizing answer...',
                                };
                                // Handle dynamic status patterns
                                let statusText = statusMessages[payload.data] || payload.data;

                                // Handle "analyzing_X_chunks" pattern - initialize progress
                                const analyzingMatch = payload.data?.match(/analyzing_(\d+)_chunks/);
                                if (analyzingMatch) {
                                    const totalCount = parseInt(analyzingMatch[1], 10);
                                    console.log('📊 Initializing analysis progress:', totalCount, 'chunks');
                                    statusText = `Starting analysis of ${totalCount} sources...`;
                                    // Initialize analysis progress with isPreparing flag
                                    updateMessage({
                                        meta: statusText,
                                        analysisProgress: {
                                            processedCount: 0,
                                            totalCount: totalCount,
                                            highQualityCount: 0,
                                            batchNum: 0,
                                            totalBatches: Math.ceil(totalCount / 5),
                                            isPreparing: true,
                                            isComplete: false
                                        }
                                    });
                                    return; // Early return since we already updated
                                }

                                // Handle "searching_subquery_1_of_2" pattern
                                const subqueryMatch = payload.data?.match(/searching_subquery_(\d+)_of_(\d+)/);
                                if (subqueryMatch) {
                                    statusText = `Searching sub-query ${subqueryMatch[1]}/${subqueryMatch[2]}...`;
                                }
                                currentMeta = statusText;
                                updateMessage({ meta: currentMeta });
                            } else if (payload.type === 'hits') {
                                // Map snake_case to camelCase for hits from streaming
                                const mapHit = (h: any) => ({
                                    fileId: h.file_id || h.fileId || '',
                                    score: h.score || 0,
                                    summary: h.summary || null,
                                    snippet: h.snippet || null,
                                    metadata: h.metadata || {},
                                    chunkId: h.chunk_id || h.chunkId || null,
                                });
                                const newHits = (payload.data || []).map(mapHit);
                                const previousHitsCount = currentHits.length;

                                // CRITICAL: Always update thinkingSteps search step with hits
                                // This ensures each search step (including SQ2, SQ3) gets its own hits array
                                if (currentThinkingSteps.length > 0) {
                                    // Find the most recent search step and update its hits
                                    for (let i = currentThinkingSteps.length - 1; i >= 0; i--) {
                                        if (currentThinkingSteps[i].type === 'search') {
                                            currentThinkingSteps[i] = {
                                                ...currentThinkingSteps[i],
                                                hits: newHits as any
                                            };
                                            break;
                                        }
                                    }
                                }

                                // For multi-path, merge new hits with existing ones instead of replacing
                                // IMPORTANT: Track by metadata.index (global citation index) NOT by chunkId
                                // Same chunk can appear in multiple subqueries with different indices, and we need
                                // all indices to be resolvable in the final answer (e.g., [1], [4] from SQ1, [6], [10] from SQ2)
                                if (isMultiPath && previousHitsCount > 0) {
                                    // Track which indices we already have
                                    const existingIndices = new Set(currentHits.map(h => h.metadata?.index));
                                    for (const newHit of newHits) {
                                        const hitIndex = newHit.metadata?.index;
                                        // Add if we don't have this index yet
                                        if (hitIndex !== undefined && !existingIndices.has(hitIndex)) {
                                            currentHits.push(newHit);
                                            existingIndices.add(hitIndex);
                                        }
                                    }
                                    updateMessage({ references: currentHits, thinkingSteps: [...currentThinkingSteps] });
                                } else {
                                    currentHits = newHits;

                                    // If this is an update (filtered hits), show a different message
                                    const isUpdate = previousHitsCount > 0 && currentHits.length < previousHitsCount;
                                    if (isUpdate) {
                                        // This is filtered hits, update references without changing meta
                                        updateMessage({ references: currentHits, thinkingSteps: [...currentThinkingSteps] });
                                    } else {
                                        updateMessage({ references: currentHits, meta: `Found ${currentHits.length} sources`, thinkingSteps: [...currentThinkingSteps] });
                                    }
                                }
                            } else if (payload.type === 'subquery_hits') {
                                // Merge sub-query hits into current hits (for multi-path)
                                const subqueryData = payload.data;
                                const rawHits = subqueryData.hits || [];
                                const subQueryIndex = subqueryData.sub_query_index;

                                // Map snake_case to camelCase and add sub-query info
                                const enrichedHits: ThinkingStepHit[] = rawHits.map((hit: any) => ({
                                    fileId: hit.file_id || hit.fileId || '',
                                    score: hit.score || 0,
                                    summary: hit.summary || null,
                                    snippet: hit.snippet || null,
                                    metadata: hit.metadata || {},
                                    chunkId: hit.chunk_id || hit.chunkId || null,
                                }));

                                // Find the search step for this sub-query and attach hits
                                const searchStepIdx = currentThinkingSteps.findIndex(s =>
                                    s.type === 'search' && s.metadata?.subQueryIndex === subQueryIndex
                                );
                                if (searchStepIdx >= 0) {
                                    currentThinkingSteps[searchStepIdx] = {
                                        ...currentThinkingSteps[searchStepIdx],
                                        hits: enrichedHits,
                                        subQuery: subqueryData.sub_query,
                                    };
                                    updateMessage({ thinkingSteps: [...currentThinkingSteps] });
                                }

                                // Also update global hits for backward compatibility
                                const globalHits = rawHits.map((hit: any) => ({
                                    fileId: hit.file_id || hit.fileId || '',
                                    score: hit.score || 0,
                                    summary: hit.summary || null,
                                    snippet: hit.snippet || null,
                                    metadata: hit.metadata || {},
                                    chunkId: hit.chunk_id || hit.chunkId || null,
                                    subQueryIndex: subqueryData.sub_query_index,
                                    subQuery: subqueryData.sub_query,
                                }));
                                currentHits = [...currentHits, ...globalHits];
                                updateMessage({
                                    references: currentHits,
                                    meta: `Sub-query ${subqueryData.sub_query_index}: Found ${enrichedHits.length} sources`
                                });
                            } else if (payload.type === 'chunk_progress') {
                                // Handle single chunk progress - real-time updates during chunk analysis
                                console.log('📥 Received chunk_progress:', payload.data);
                                const progressData = payload.data as {
                                    processed_count: number;
                                    total_count: number;
                                    high_quality_count: number;
                                    is_last: boolean;
                                    current_file?: string;
                                    chunk_result?: {
                                        index: number;
                                        has_answer: boolean;
                                        comment: string | null;
                                        confidence: number;
                                        source: string;
                                        file_name?: string;
                                        file_id?: string;
                                        chunk_id?: string;
                                    };
                                };

                                // Update hits with single chunk result
                                if (currentHits && currentHits.length > 0 && progressData.chunk_result) {
                                    const result = progressData.chunk_result;

                                    // Debug: Log the chunk_result we received
                                    console.log('🔍 chunk_progress result:', {
                                        chunk_id: result.chunk_id,
                                        index: result.index,
                                        has_answer: result.has_answer,
                                    });

                                    // Helper function to update a single hit
                                    const updateHit = (hit: any, idx: number) => {
                                        if (hit.hasAnswer !== undefined) return hit;

                                        // Handle both snake_case and camelCase for chunk_id
                                        // Check both hit.chunkId and hit.metadata.chunk_id
                                        const hitChunkId = hit.chunkId || hit.chunk_id || hit.metadata?.chunkId || hit.metadata?.chunk_id;
                                        const resultChunkId = result.chunk_id;

                                        // Use metadata.index if available (set by backend), fallback to idx + 1
                                        const hitIndex = hit.metadata?.index ?? (idx + 1);

                                        // Debug: Log comparison for the first few hits
                                        if (idx < 3) {
                                            console.log(`  Hit[${idx}]:`, {
                                                hitChunkId,
                                                resultChunkId,
                                                hitIndex,
                                                resultIndex: result.index,
                                                chunkMatch: hitChunkId && resultChunkId && hitChunkId === resultChunkId,
                                                indexMatch: result.index === hitIndex,
                                            });
                                        }

                                        // Match by chunk_id (primary) or index from metadata (secondary)
                                        const isMatch = (resultChunkId && hitChunkId && resultChunkId === hitChunkId) ||
                                            (result.index === hitIndex);

                                        if (isMatch) {
                                            console.log(`✅ MATCH found at idx ${idx}, hitChunkId=${hitChunkId}, hitIndex=${hitIndex}`);
                                            return {
                                                ...hit,
                                                analysisComment: result.comment,
                                                hasAnswer: result.has_answer,
                                                analysisConfidence: result.confidence
                                            };
                                        }
                                        return hit;
                                    };

                                    // 1. Update Global Hits (Refereces list)
                                    currentHits = currentHits.map(updateHit);

                                    // 2. Update Thinking Steps (UI Cards)
                                    // Find the most recent search/analyze step that has hits
                                    let stepUpdated = false;
                                    for (let i = currentThinkingSteps.length - 1; i >= 0; i--) {
                                        const step = currentThinkingSteps[i];
                                        if (step.hits && step.hits.length > 0) {
                                            const updatedHits = step.hits.map((h, idx) => {
                                                const newHit = updateHit(h, idx);
                                                // Log if update happened - check reference equality
                                                if (newHit !== h) {
                                                    console.log('✅ Updated UI card:', {
                                                        file: newHit.fileId,
                                                        chunk: newHit.chunkId,
                                                        hasAnswer: newHit.hasAnswer
                                                    });
                                                }
                                                return newHit;
                                            });

                                            // Check if any hit was actually updated
                                            const hasChanges = updatedHits.some((h, idx) => h !== step.hits![idx]);

                                            if (hasChanges) {
                                                currentThinkingSteps[i] = {
                                                    ...step,
                                                    hits: updatedHits
                                                };
                                                stepUpdated = true;
                                            }
                                            break; // Only update the most recent search-like step
                                        }
                                    }

                                    // Trigger update with explicit new array reference
                                    if (stepUpdated) {
                                        console.log('🔄 Triggering ThinkingSteps re-render');
                                        updateMessage({
                                            references: currentHits,
                                            thinkingSteps: [...currentThinkingSteps]
                                        });
                                    } else {
                                        updateMessage({ references: currentHits });
                                    }
                                }

                                // Update message with progress info - one chunk at a time
                                updateMessage({
                                    meta: `Analyzing ${progressData.current_file || 'source'}...`,
                                    analysisProgress: {
                                        processedCount: progressData.processed_count,
                                        totalCount: progressData.total_count,
                                        highQualityCount: progressData.high_quality_count,
                                        batchNum: 1,
                                        totalBatches: 1,
                                        currentFiles: progressData.current_file ? [progressData.current_file] : [],
                                        isProcessing: false,
                                        isPreparing: false,  // Clear preparing state when first progress arrives
                                        isComplete: false  // Will be set to true when chunk_analysis arrives
                                    }
                                });
                            } else if (payload.type === 'chunk_analysis') {
                                // Merge chunk analysis results into hits (batch update for backward compat)
                                const analysisData = payload.data as Array<{
                                    index: number;
                                    has_answer: boolean;
                                    comment: string | null;
                                    confidence: number;
                                    source: string;
                                    file_id?: string;
                                    chunk_id?: string;
                                    sub_query_index?: number;
                                }>;

                                // Helper to apply analysis to a hit
                                // Match by chunk_id (precise) or index. Do NOT use file_id alone!
                                const applyAnalysis = (hit: ThinkingStepHit, idx: number) => {
                                    if (hit.hasAnswer !== undefined) return hit;

                                    const hitChunkId = hit.chunkId;

                                    // First try precise chunk_id match
                                    let analysis = analysisData.find(a =>
                                        a.chunk_id && hitChunkId && a.chunk_id === hitChunkId
                                    );
                                    // Fallback to index-based matching
                                    if (!analysis) {
                                        analysis = analysisData.find(a => a.index === idx + 1);
                                    }

                                    if (analysis) {
                                        return {
                                            ...hit,
                                            analysisComment: analysis.comment,
                                            hasAnswer: analysis.has_answer,
                                            analysisConfidence: analysis.confidence
                                        };
                                    }
                                    return hit;
                                };

                                // Get sub_query_index from analysis data
                                const subQueryIndex = analysisData[0]?.sub_query_index;

                                // Update hits in corresponding thinking step
                                if (subQueryIndex !== undefined && isMultiPath) {
                                    // Find the search step for this sub-query
                                    const searchStepIdx = currentThinkingSteps.findIndex(s =>
                                        s.type === 'search' && s.metadata?.subQueryIndex === subQueryIndex
                                    );
                                    if (searchStepIdx >= 0 && currentThinkingSteps[searchStepIdx].hits) {
                                        const updatedHits = currentThinkingSteps[searchStepIdx].hits!.map(applyAnalysis);
                                        currentThinkingSteps[searchStepIdx] = {
                                            ...currentThinkingSteps[searchStepIdx],
                                            hits: updatedHits
                                        };
                                        updateMessage({ thinkingSteps: [...currentThinkingSteps] });
                                    }
                                }

                                // Also update global hits for backward compatibility
                                // Match by chunk_id (precise) or index. Do NOT use file_id alone!
                                if (currentHits && currentHits.length > 0) {
                                    currentHits = currentHits.map((hit, idx) => {
                                        if (hit.hasAnswer !== undefined) return hit;

                                        const hitChunkId = hit.chunkId || (hit as any).chunk_id;

                                        // First try precise chunk_id match
                                        let analysis = analysisData.find(a =>
                                            a.chunk_id && hitChunkId && a.chunk_id === hitChunkId
                                        );
                                        // Fallback to index-based matching
                                        if (!analysis) {
                                            analysis = analysisData.find(a => a.index === idx + 1);
                                        }

                                        if (analysis) {
                                            return {
                                                ...hit,
                                                analysisComment: analysis.comment,
                                                hasAnswer: analysis.has_answer,
                                                analysisConfidence: analysis.confidence
                                            };
                                        }
                                        return hit;
                                    });
                                    // Mark analysis as complete when chunk_analysis arrives
                                    updateMessage({
                                        references: currentHits,
                                        analysisProgress: {
                                            processedCount: analysisData.length,
                                            totalCount: analysisData.length,
                                            highQualityCount: analysisData.filter(a => a.has_answer && a.confidence >= 0.8).length,
                                            batchNum: 1,
                                            totalBatches: 1,
                                            currentFiles: [],
                                            isPreparing: false,
                                            isComplete: true  // Analysis complete!
                                        }
                                    });
                                }
                            } else if (payload.type === 'token') {
                                currentAnswer += payload.data;
                                updateMessage({ text: currentAnswer });
                            } else if (payload.type === 'error') {
                                maybeNotifyContextTooLarge(payload.data);
                                currentAnswer += `\n[Error: ${payload.data}]`;
                                currentMeta = 'Error';
                                updateMessage({ text: currentAnswer, meta: 'Error' });
                            } else if (payload.type === 'done') {
                                if (payload.data) {
                                    currentAnswer += payload.data;
                                    updateMessage({ text: currentAnswer });
                                }
                                // Clear status but explicitly preserve thinkingSteps and isMultiPath
                                // to prevent race condition where these might be lost
                                updateMessage({
                                    meta: undefined,
                                    ...(isMultiPath ? {
                                        isMultiPath: true,
                                        thinkingSteps: [...currentThinkingSteps]
                                    } : {})
                                });
                                currentMeta = undefined;
                            }
                        } catch (e) {
                            console.error('Failed to parse stream line', e, 'Line:', line);
                        }
                    }
                },
                onError: (error) => {
                    if (askSessionRef.current !== requestId) return;
                    maybeNotifyContextTooLarge(error);
                    currentAnswer += `\n[Error: ${error}]`;
                    currentMeta = 'Error';
                    updateMessage({ text: currentAnswer, meta: 'Error' });
                    setIsAnswering(false);

                    // Persist error message
                    if (api?.addChatMessage && targetSessionId) {
                        const finalMsg: ConversationMessage = {
                            role: 'assistant',
                            text: currentAnswer,
                            timestamp: placeholderTimestamp,
                            meta: 'Error'
                        };
                        void api.addChatMessage(targetSessionId, finalMsg).catch(e => console.error('Failed to persist error message', e));
                    }
                },
                onDone: () => {
                    if (askSessionRef.current !== requestId) return;
                    setIsAnswering(false);
                    setAgentContext({
                        original: text,
                        rewritten: null,
                        variants: [],
                        latencyMs: null,
                        status: 'ok'
                    });

                    // Persist final assistant message
                    if (api?.addChatMessage && targetSessionId) {
                        const finalMsg: ConversationMessage = {
                            role: 'assistant',
                            text: currentAnswer,
                            timestamp: placeholderTimestamp,
                            references: currentHits,
                            meta: undefined,
                            // Always persist thinking steps (for both single-path and multi-path)
                            // This ensures search results survive app restart
                            ...(currentThinkingSteps.length > 0 ? {
                                isMultiPath: isMultiPath,
                                thinkingSteps: [...currentThinkingSteps]
                            } : {}),
                            ...(needsUserDecision ? {
                                needsUserDecision,
                                resumeToken,
                                decisionMessage
                            } : {})
                        };
                        void api.addChatMessage(targetSessionId, finalMsg).catch(e => console.error('Failed to persist final message', e));
                    }

                    if (shouldGenerateTitle) {
                        void generateTitle(targetSessionId!, text, currentAnswer);
                    }
                }
            }, searchMode);
        },
        [currentSessionId, generateTitle, sessions, config]
    );

    const handleResume = useCallback(
        async (sessionId: string, searchMode: SearchMode = 'auto') => {
            const api = window.api;
            if (!api?.askStream) return;

            const session = sessions.find(s => s.id === sessionId);
            if (!session) return;

            let lastMsgIdx = -1;
            for (let i = session.messages.length - 1; i >= 0; i--) {
                if (session.messages[i].role === 'assistant') {
                    lastMsgIdx = i;
                    break;
                }
            }
            if (lastMsgIdx === -1) return;

            const lastMsg = session.messages[lastMsgIdx];
            const token = lastMsg.resumeToken;
            if (!token) return;

            const userMsg = session.messages[lastMsgIdx - 1];
            const text = userMsg?.text || (agentContext?.original ?? "");

            const requestId = askSessionRef.current + 1;
            askSessionRef.current = requestId;

            setIsAnswering(true);
            setAgentContext({
                original: text,
                rewritten: null,
                variants: [],
                latencyMs: null,
                status: 'pending'
            });

            // State for resuming
            let currentAnswer = lastMsg.text || '';
            let currentHits: SearchHit[] = lastMsg.references || [];
            let currentThinkingSteps: ThinkingStep[] = lastMsg.thinkingSteps ? [...lastMsg.thinkingSteps] : [];
            let isMultiPath = lastMsg.isMultiPath || false;
            let buffer = '';
            let currentMeta: string | undefined = 'Resuming...';

            let needsUserDecision = false;
            let nextResumeToken: string | null = null;
            let decisionMessage: string | undefined;

            const updateMessage = (updates: Partial<ConversationMessage>) => {
                setSessions(prev => prev.map(s => {
                    if (s.id === sessionId) {
                        const msgs = [...s.messages];
                        if (msgs[lastMsgIdx]) {
                            msgs[lastMsgIdx] = { ...msgs[lastMsgIdx], ...updates };
                        }
                        return { ...s, messages: msgs };
                    }
                    return s;
                }));
            };

            // Reset decision state
            updateMessage({ needsUserDecision: false, resumeToken: undefined, decisionMessage: undefined, meta: 'Resuming...' });

            const maybeNotifyContextTooLarge = (rawMessage: unknown) => {
                const errorText = String(rawMessage ?? '');
                const lower = errorText.toLowerCase();
                if (!lower.includes('exceeds the available context size') && !lower.includes('available context size')) return;
                window.dispatchEvent(new CustomEvent('synvo:notify', {
                    detail: {
                        message: 'Result too large for context window.',
                        action: { label: 'Model Settings', onClick: () => window.dispatchEvent(new CustomEvent('synvo:navigate', { detail: { view: 'models' } })) }
                    }
                }));
            };

            const limit = config?.qaContextLimit ?? 5;

            api.askStream(text, limit, 'qa', {
                onData: (chunkStr) => {
                    if (askSessionRef.current !== requestId) return;
                    buffer += chunkStr;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const payload = JSON.parse(line);

                            if (payload.type === 'multi_path_start') {
                                isMultiPath = true;
                                currentThinkingSteps = [];
                                updateMessage({ isMultiPath: true, thinkingSteps: [] });
                            } else if (payload.type === 'multi_path_end') {
                                currentThinkingSteps = currentThinkingSteps.map(s => ({
                                    ...s,
                                    status: s.status === 'running' ? 'complete' : s.status
                                })) as ThinkingStep[];
                                updateMessage({ thinkingSteps: [...currentThinkingSteps] });
                            } else if (payload.type === 'thinking_step') {
                                const stepData = payload.data;
                                const existingIdx = currentThinkingSteps.findIndex(s => s.id === stepData.id);
                                const existingHits = existingIdx >= 0 ? currentThinkingSteps[existingIdx].hits : undefined;
                                const newHits = stepData.hits || existingHits;
                                const newStep: ThinkingStep = {
                                    id: stepData.id,
                                    type: stepData.type,
                                    title: stepData.title,
                                    status: stepData.status,
                                    summary: stepData.summary,
                                    details: stepData.details,
                                    subQuery: stepData.subQuery || stepData.sub_query,
                                    subQueryAnswer: stepData.subQueryAnswer || stepData.sub_query_answer,
                                    hits: newHits,
                                    metadata: {
                                        subQueryIndex: stepData.metadata?.subQueryIndex || stepData.metadata?.sub_query_index,
                                        totalSubQueries: stepData.metadata?.totalSubQueries || stepData.metadata?.total_sub_queries,
                                        resultsCount: stepData.metadata?.resultsCount || stepData.metadata?.results_count,
                                        relevantCount: stepData.metadata?.relevantCount || stepData.metadata?.relevant_count,
                                        strategy: stepData.metadata?.strategy,
                                        sources: stepData.metadata?.sources,
                                        sub_queries: stepData.metadata?.sub_queries,
                                        keywords: stepData.metadata?.keywords,
                                        candidates: stepData.metadata?.candidates,
                                        verification_results: stepData.metadata?.verification_results,
                                        best_answer: stepData.metadata?.best_answer,
                                        confidence: stepData.metadata?.confidence,
                                        chunks: stepData.metadata?.chunks,
                                    }
                                };
                                if (existingIdx >= 0) currentThinkingSteps[existingIdx] = newStep;
                                else currentThinkingSteps.push(newStep);
                                updateMessage({ thinkingSteps: [...currentThinkingSteps] });
                            } else if (payload.type === 'user_decision_required') {
                                needsUserDecision = true;
                                nextResumeToken = payload.resume_token;
                                decisionMessage = payload.message;
                                updateMessage({
                                    needsUserDecision: true,
                                    resumeToken: payload.resume_token,
                                    decisionMessage: payload.message,
                                    meta: 'Waiting for confirmation...'
                                });
                            } else if (payload.type === 'status') {
                                const statusMessages: Record<string, string> = {
                                    'searching': 'Searching...',
                                    'answering': 'Generating answer...',
                                    'decomposing_query': 'Decomposing query...',
                                    'merging_results': 'Merging results...',
                                    'synthesizing_answer': 'Synthesizing answer...',
                                };
                                let statusText = statusMessages[payload.data] || payload.data;
                                const analyzingMatch = payload.data?.match(/analyzing_(\d+)_chunks/);
                                if (analyzingMatch) {
                                    const totalCount = parseInt(analyzingMatch[1], 10);
                                    updateMessage({
                                        meta: `Starting analysis of ${totalCount} sources...`,
                                        analysisProgress: {
                                            processedCount: 0, totalCount, highQualityCount: 0, batchNum: 0, totalBatches: Math.ceil(totalCount / 5),
                                            isPreparing: true, isComplete: false
                                        }
                                    });
                                    return;
                                }
                                const subqueryMatch = payload.data?.match(/searching_subquery_(\d+)_of_(\d+)/);
                                if (subqueryMatch) statusText = `Searching sub-query ${subqueryMatch[1]}/${subqueryMatch[2]}...`;
                                currentMeta = statusText;
                                updateMessage({ meta: currentMeta });
                            } else if (payload.type === 'hits') {
                                const mapHit = (h: any) => ({
                                    fileId: h.file_id || h.fileId || '',
                                    score: h.score || 0,
                                    summary: h.summary || null,
                                    snippet: h.snippet || null,
                                    metadata: h.metadata || {},
                                    chunkId: h.chunk_id || h.chunkId || null,
                                });
                                const newHits = (payload.data || []).map(mapHit);
                                const previousHitsCount = currentHits.length;
                                if (isMultiPath && previousHitsCount > 0) {
                                    const existingChunkIds = new Set(currentHits.map(h => h.chunkId || h.fileId));
                                    for (const newHit of newHits) {
                                        const key = newHit.chunkId || newHit.fileId;
                                        if (!existingChunkIds.has(key)) currentHits.push(newHit);
                                    }
                                    updateMessage({ references: currentHits });
                                } else {
                                    currentHits = newHits;
                                    const isUpdate = previousHitsCount > 0 && currentHits.length < previousHitsCount;
                                    if (isUpdate) updateMessage({ references: currentHits });
                                    else updateMessage({ references: currentHits, meta: `Found ${currentHits.length} sources` });
                                }
                            } else if (payload.type === 'subquery_hits') {
                                const subqueryData = payload.data;
                                const rawHits = subqueryData.hits || [];
                                const subQueryIndex = subqueryData.sub_query_index;
                                const enrichedHits: ThinkingStepHit[] = rawHits.map((hit: any) => ({
                                    fileId: hit.file_id || hit.fileId || '',
                                    score: hit.score || 0,
                                    summary: hit.summary || null,
                                    snippet: hit.snippet || null,
                                    metadata: hit.metadata || {},
                                    chunkId: hit.chunk_id || hit.chunkId || null,
                                }));
                                const searchStepIdx = currentThinkingSteps.findIndex(s => s.type === 'search' && s.metadata?.subQueryIndex === subQueryIndex);
                                if (searchStepIdx >= 0) {
                                    currentThinkingSteps[searchStepIdx] = {
                                        ...currentThinkingSteps[searchStepIdx],
                                        hits: enrichedHits,
                                        subQuery: subqueryData.sub_query,
                                    };
                                    updateMessage({ thinkingSteps: [...currentThinkingSteps] });
                                }
                                const globalHits = rawHits.map((hit: any) => ({
                                    fileId: hit.file_id || hit.fileId || '',
                                    score: hit.score || 0,
                                    summary: hit.summary || null,
                                    snippet: hit.snippet || null,
                                    metadata: hit.metadata || {},
                                    chunkId: hit.chunk_id || hit.chunkId || null,
                                    subQueryIndex: subqueryData.sub_query_index,
                                    subQuery: subqueryData.sub_query,
                                })) as SearchHit[];
                                currentHits = [...currentHits, ...globalHits];
                                updateMessage({ references: currentHits, meta: `Sub-query ${subqueryData.sub_query_index}: Found ${enrichedHits.length} sources` });
                            } else if (payload.type === 'chunk_progress') {
                                const progressData = payload.data as any;
                                if (currentHits && currentHits.length > 0 && progressData.chunk_result) {
                                    const result = progressData.chunk_result;
                                    currentHits = currentHits.map((hit, idx) => {
                                        const hitChunkId = hit.chunkId || (hit as any).chunk_id;
                                        const isMatch = (result.chunk_id && hitChunkId && result.chunk_id === hitChunkId) || (result.index === idx + 1);
                                        if (isMatch) return { ...hit, analysisComment: result.comment, hasAnswer: result.has_answer, analysisConfidence: result.confidence };
                                        return hit;
                                    });
                                }
                                updateMessage({
                                    references: currentHits,
                                    meta: `Analyzing ${progressData.current_file || 'source'}...`,
                                    analysisProgress: {
                                        processedCount: progressData.processed_count, totalCount: progressData.total_count, highQualityCount: progressData.high_quality_count,
                                        batchNum: 1, totalBatches: 1, currentFiles: progressData.current_file ? [progressData.current_file] : [], isProcessing: false, isPreparing: false, isComplete: false
                                    }
                                });
                            } else if (payload.type === 'chunk_analysis') {
                                const analysisData = payload.data as any[];
                                const applyAnalysis = (hit: ThinkingStepHit, idx: number) => {
                                    if (hit.hasAnswer !== undefined) return hit;
                                    const hitChunkId = hit.chunkId;
                                    let analysis = analysisData.find(a => a.chunk_id && hitChunkId && a.chunk_id === hitChunkId);
                                    if (!analysis) analysis = analysisData.find(a => a.index === idx + 1);
                                    if (analysis) return { ...hit, analysisComment: analysis.comment, hasAnswer: analysis.has_answer, analysisConfidence: analysis.confidence };
                                    return hit;
                                };
                                const subQueryIndex = analysisData[0]?.sub_query_index;
                                if (subQueryIndex !== undefined && isMultiPath) {
                                    const searchStepIdx = currentThinkingSteps.findIndex(s => s.type === 'search' && s.metadata?.subQueryIndex === subQueryIndex);
                                    if (searchStepIdx >= 0 && currentThinkingSteps[searchStepIdx].hits) {
                                        const updatedHits = currentThinkingSteps[searchStepIdx].hits!.map(applyAnalysis);
                                        currentThinkingSteps[searchStepIdx] = { ...currentThinkingSteps[searchStepIdx], hits: updatedHits };
                                        updateMessage({ thinkingSteps: [...currentThinkingSteps] });
                                    }
                                }
                                if (currentHits && currentHits.length > 0) {
                                    currentHits = currentHits.map((hit, idx) => applyAnalysis(hit, idx)) as SearchHit[];
                                    updateMessage({
                                        references: currentHits,
                                        analysisProgress: {
                                            processedCount: analysisData.length, totalCount: analysisData.length, highQualityCount: analysisData.filter(a => a.has_answer && a.confidence >= 0.8).length,
                                            batchNum: 1, totalBatches: 1, currentFiles: [], isPreparing: false, isComplete: true
                                        }
                                    });
                                }
                            } else if (payload.type === 'token') {
                                currentAnswer += payload.data;
                                updateMessage({ text: currentAnswer });
                            } else if (payload.type === 'error') {
                                maybeNotifyContextTooLarge(payload.data);
                                currentAnswer += `\n[Error: ${payload.data}]`;
                                currentMeta = 'Error';
                                updateMessage({ text: currentAnswer, meta: 'Error' });
                            } else if (payload.type === 'done') {
                                if (payload.data) {
                                    currentAnswer += payload.data;
                                    updateMessage({ text: currentAnswer });
                                }
                                updateMessage({
                                    meta: undefined,
                                    ...(isMultiPath ? { isMultiPath: true, thinkingSteps: [...currentThinkingSteps] } : {}),
                                    ...(needsUserDecision ? { needsUserDecision, resumeToken: nextResumeToken, decisionMessage } : {})
                                });
                                currentMeta = undefined;
                            }
                        } catch (e) {
                            console.error('Failed to parse stream line', e, 'Line:', line);
                        }
                    }
                },
                onError: (error) => {
                    if (askSessionRef.current !== requestId) return;
                    maybeNotifyContextTooLarge(error);
                    currentAnswer += `\n[Error: ${error}]`;
                    updateMessage({ text: currentAnswer, meta: 'Error' });
                    setIsAnswering(false);
                },
                onDone: () => {
                    if (askSessionRef.current !== requestId) return;
                    setIsAnswering(false);
                    setAgentContext({
                        original: text,
                        rewritten: null,
                        variants: [],
                        latencyMs: null,
                        status: 'ok'
                    });

                    if (api?.addChatMessage) {
                        const finalMsg: ConversationMessage = {
                            role: 'assistant',
                            text: currentAnswer,
                            timestamp: lastMsg.timestamp,
                            references: currentHits,
                            meta: undefined,
                            ...(isMultiPath ? { isMultiPath: true, thinkingSteps: [...currentThinkingSteps] } : {}),
                            ...(needsUserDecision ? { needsUserDecision, resumeToken: nextResumeToken, decisionMessage } : {})
                        };
                        void api.addChatMessage(sessionId, finalMsg).catch(e => console.error('Failed to persist final message', e));
                    }
                }
            }, searchMode, token);
        },
        [currentSessionId, sessions, config, agentContext]
    );

    return {
        sessions,
        currentSessionId,
        currentSession,
        messages,
        agentContext,
        isAnswering,
        handleCreateSession,
        handleDeleteSession,
        handleSelectSession,
        handleResetConversation,
        handleSend,
        handleResume,
        setSessions,
        setCurrentSessionId,
        setAgentContext,
        setIsAnswering
    };
}
