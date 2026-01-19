import { useState, useCallback, useEffect, useRef } from 'react';
import type { ModelStatusSummary, ModelDownloadEvent, ModelAssetStatus } from '../types';

const FALLBACK_MODEL_ASSETS: ModelAssetStatus[] = [
    { id: 'embedding', label: 'Embedding encoder', path: '', exists: false, sizeBytes: null },
    { id: 'reranker', label: 'Reranker model', path: '', exists: false, sizeBytes: null },
    { id: 'llm', label: 'MiniCPM LLM', path: '', exists: false, sizeBytes: null },
    { id: 'vlm', label: 'Vision-language model', path: '', exists: false, sizeBytes: null, optional: true }
];

export function useModelStatus() {
    const [modelStatus, setModelStatus] = useState<ModelStatusSummary | null>(null);
    const [modelDownloadEvent, setModelDownloadEvent] = useState<ModelDownloadEvent | null>(null);
    const [modelDownloadLog, setModelDownloadLog] = useState<string[]>([]);
    const [activeModelId, setActiveModelId] = useState<string>('vlm');
    const [availableModels, setAvailableModels] = useState<ModelAssetStatus[]>([]);
    const bootstrapTriggerRef = useRef(false);

    const modelBridgeAvailable = typeof window !== 'undefined' && Boolean(window.api?.modelStatus);
    const modelsReady = modelBridgeAvailable ? Boolean(modelStatus?.ready) : true;

    const refreshModelStatus = useCallback(async () => {
        const api = window.api;
        if (!api?.modelStatus) {
            return null;
        }
        try {
            const status = await api.modelStatus();
            setModelStatus(status);
            setAvailableModels(status.assets);

            if (api.getModelConfig) {
                const config = await api.getModelConfig();
                if (config?.activeModelId) {
                    setActiveModelId(config.activeModelId);
                }
            }
            return status;
        } catch (error) {
            console.error('Failed to refresh model status', error);
            return null;
        }
    }, []);

    const setActiveModel = useCallback(async (modelId: string) => {
        const api = window.api;
        if (!api?.setModelConfig) return;
        try {
            const config = await api.getModelConfig();
            await api.setModelConfig({ ...config, activeModelId: modelId });
            setActiveModelId(modelId);
        } catch (error) {
            console.error('Failed to set active model', error);
        }
    }, []);

    const addLocalModel = useCallback(async () => {
        const api = window.api;
        if (!api?.pickFile || !api?.addModel) return;
        try {
            // 1. Pick the main GGUF model
            const filePath = await api.pickFile({
                filters: [{ name: 'GGUF Models', extensions: ['gguf'] }]
            });
            if (!filePath) return;

            // 2. Pick the mmproj file
            // We use a small delay or alert to inform user? 
            // Since we can't show alerts easily from here without UI, we just open the dialog.
            // Ideally we should show a toast or something, but for now we just open the second dialog.
            // Let's assume the user knows they need to pick the mmproj next.
            // Or we can rely on the dialog title if the API supported it (it doesn't currently).

            // HACK: We can't easily change the dialog title via the current API bridge.
            // We will just open the second picker.
            const mmprojPath = await api.pickFile({
                filters: [{ name: 'MMProj Files', extensions: ['gguf', 'mmproj', 'bin'] }]
            });

            if (!mmprojPath) {
                console.warn('No mmproj file selected. Aborting model addition.');
                return;
            }

            const timestamp = Date.now();
            const modelId = `local-vlm-${timestamp}`;
            const mmprojId = `local-mmproj-${timestamp}`;
            const filename = filePath.split(/[/\\]/).pop() || 'Local Model';
            const mmprojFilename = mmprojPath.split(/[/\\]/).pop() || 'Local MMProj';

            // 3. Add mmproj asset first
            const mmprojDescriptor = {
                id: mmprojId,
                label: mmprojFilename,
                relativePath: mmprojPath,
                type: 'vlm' as const, // It's part of VLM system
                url: '',
                optional: true
            };
            await api.addModel(mmprojDescriptor);

            // 4. Add main model asset referencing the mmproj
            const modelDescriptor = {
                id: modelId,
                label: filename,
                relativePath: filePath,
                type: 'vlm' as const,
                url: '',
                optional: true,
                mmprojId: mmprojId
            };

            await api.addModel(modelDescriptor);
            await refreshModelStatus();
            await setActiveModel(modelId);
        } catch (error) {
            console.error('Failed to add local model', error);
        }
    }, [refreshModelStatus, setActiveModel]);

    const handleManualModelDownload = useCallback(() => {
        if (!modelBridgeAvailable) {
            return;
        }
        bootstrapTriggerRef.current = true;
        setModelDownloadLog([]);
        window.api?.downloadModels?.().catch((error) => {
            console.error('Model download failed', error);
        });
    }, [modelBridgeAvailable]);

    const handleRedownloadModel = useCallback((assetId: string) => {
        if (!modelBridgeAvailable || !assetId) {
            return;
        }
        bootstrapTriggerRef.current = true;
        setModelDownloadLog([]);
        window.api?.redownloadModel?.(assetId).catch((error) => {
            console.error(`Model redownload failed for ${assetId}`, error);
        });
    }, [modelBridgeAvailable]);

    useEffect(() => {
        if (!modelBridgeAvailable) {
            return;
        }
        void refreshModelStatus();
    }, [modelBridgeAvailable, refreshModelStatus]);

    useEffect(() => {
        if (!modelBridgeAvailable) {
            return;
        }
        const unsubscribe = window.api?.onModelDownloadEvent?.((payload) => {
            setModelDownloadEvent(payload);

            // Update status immediately if event contains updated statuses (incremental updates)
            if (payload.statuses) {
                setModelStatus((prev) => prev ? { ...prev, assets: payload.statuses! } : prev);
                setAvailableModels(payload.statuses);
            }

            if (payload.state === 'completed') {
                bootstrapTriggerRef.current = false;
                void refreshModelStatus();
            }
        });
        return () => {
            unsubscribe?.();
        };
    }, [modelBridgeAvailable, refreshModelStatus]);

    useEffect(() => {
        if (!modelDownloadEvent) {
            return;
        }
        const nextLine = modelDownloadEvent.logLine ?? modelDownloadEvent.message;
        if (!nextLine) {
            return;
        }
        setModelDownloadLog((prev) => {
            if (prev.length && prev[prev.length - 1] === nextLine) {
                return prev;
            }
            const updated = [...prev, nextLine];
            return updated.length > 60 ? updated.slice(updated.length - 60) : updated;
        });
    }, [modelDownloadEvent]);

    return {
        modelStatus,
        modelDownloadEvent,
        modelDownloadLog,
        modelsReady,
        handleManualModelDownload,
        handleRedownloadModel,
        FALLBACK_MODEL_ASSETS,
        activeModelId,
        availableModels,
        setActiveModel,
        addLocalModel
    };
}
