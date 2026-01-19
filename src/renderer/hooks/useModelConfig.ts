import { useState, useEffect, useCallback } from 'react';

interface ModelConfig {
    activeModelId: string;
    activeEmbeddingModelId: string;
    activeRerankerModelId: string;
    activeAudioModelId: string;  // Whisper model for speech recognition
    contextSize: number;
    visionMaxPixels: number;
    videoMaxPixels: number;
    pdfOneChunkPerPage?: boolean;
    summaryMaxTokens?: number;
    searchResultLimit?: number;
    qaContextLimit?: number;
    maxSnippetLength?: number;
    embedBatchSize?: number;
    embedBatchDelayMs?: number;
    visionBatchDelayMs?: number;
    debugMode?: boolean;
}



export function useModelConfig() {
    const [config, setConfig] = useState<ModelConfig | null>(null);
    const [loading, setLoading] = useState(false);

    const fetchConfig = useCallback(async () => {
        if (!window.api?.getModelConfig) return;
        try {
            const data = await window.api.getModelConfig();
            setConfig(data);
        } catch (error) {
            console.error('Failed to fetch model config:', error);
        }
    }, []);

    const updateConfig = useCallback(async (newConfig: Partial<ModelConfig>) => {
        if (!window.api?.setModelConfig) return;
        setLoading(true);
        try {
            const updated = await window.api.setModelConfig(newConfig);
            setConfig(updated);
        } catch (error) {
            console.error('Failed to update model config:', error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchConfig();
    }, [fetchConfig]);

    return {
        config,
        loading,
        updateConfig,
        refreshConfig: fetchConfig
    };
}
