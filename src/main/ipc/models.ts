import { ipcMain } from 'electron';
import { ModelManager } from '../modelManager';
import { ServiceManager } from '../serviceManager';
import { updateLogSettings } from '../logger';
import { updateSettings, stopPythonModel, updateVLMConfig, updateEmbeddingConfig, updateRerankerConfig, updateWhisperConfig } from '../backendClient';

export function registerModelHandlers(modelManager: ModelManager, serviceManager: ServiceManager) {
    ipcMain.handle('models:status', async () => modelManager.getStatus());
    ipcMain.handle('models:download', async () => modelManager.downloadMissing());
    ipcMain.handle('models:redownload', async (_event, assetId: string) => modelManager.redownloadAsset(assetId));
    ipcMain.handle('models:get-config', async () => modelManager.getConfig());

    ipcMain.handle('models:set-config', async (_event, config) => {
        const oldConfig = await modelManager.getConfig();
        await modelManager.setConfig(config);
        const newConfig = await modelManager.getConfig();

        // Update Python backend settings if relevant fields changed
        const settingsToUpdate: any = {};
        if (oldConfig.visionMaxPixels !== newConfig.visionMaxPixels) {
            settingsToUpdate.vision_max_pixels = newConfig.visionMaxPixels;
        }
        if (oldConfig.videoMaxPixels !== newConfig.videoMaxPixels) {
            settingsToUpdate.video_max_pixels = newConfig.videoMaxPixels;
        }
        if (oldConfig.searchResultLimit !== newConfig.searchResultLimit) {
            settingsToUpdate.search_result_limit = newConfig.searchResultLimit;
        }
        if (oldConfig.qaContextLimit !== newConfig.qaContextLimit) {
            settingsToUpdate.qa_context_limit = newConfig.qaContextLimit;
        }
        if (oldConfig.maxSnippetLength !== newConfig.maxSnippetLength) {
            settingsToUpdate.max_snippet_length = newConfig.maxSnippetLength;
        }
        if (oldConfig.summaryMaxTokens !== newConfig.summaryMaxTokens) {
            settingsToUpdate.summary_max_tokens = newConfig.summaryMaxTokens;
        }
        if (oldConfig.embedBatchSize !== newConfig.embedBatchSize) {
            settingsToUpdate.embed_batch_size = newConfig.embedBatchSize;
        }
        if (oldConfig.embedBatchDelayMs !== newConfig.embedBatchDelayMs) {
            settingsToUpdate.embed_batch_delay_ms = newConfig.embedBatchDelayMs;
        }
        if (oldConfig.visionBatchDelayMs !== newConfig.visionBatchDelayMs) {
            settingsToUpdate.vision_batch_delay_ms = newConfig.visionBatchDelayMs;
        }
        if (oldConfig.pdfOneChunkPerPage !== newConfig.pdfOneChunkPerPage) {
            settingsToUpdate.pdf_one_chunk_per_page = newConfig.pdfOneChunkPerPage;
        }

        if (Object.keys(settingsToUpdate).length > 0) {
            try {
                await updateSettings(settingsToUpdate);
            } catch (err) {
                console.error('Failed to update backend settings:', err);
            }
        }

        // Update debug mode if changed (takes effect immediately for new logs)
        if (oldConfig.debugMode !== newConfig.debugMode) {
            config.logLevel = newConfig.debugMode ? 'debug' : 'info';
            updateLogSettings();
        }

        // Only restart VLM if context size or model changed
        if (oldConfig.contextSize !== newConfig.contextSize || oldConfig.activeModelId !== newConfig.activeModelId) {
            // Stop both Electron-managed and Python-managed VLM processes
            await serviceManager.stopService('vlm');
            try {
                await stopPythonModel('vision');
            } catch (e) {
                console.log('[Models IPC] Python VLM stop failed (may not be running):', e);
            }
            // Restart with new config
            const modelPath = modelManager.getModelPath(newConfig.activeModelId);
            const descriptor = modelManager.getDescriptor(newConfig.activeModelId);

            // Resolve mmproj path - use mmprojId from descriptor if available
            let mmprojPath: string | undefined;
            if (descriptor?.type === 'vlm' || descriptor?.id === 'vlm') {
                if (descriptor.mmprojId) {
                    mmprojPath = modelManager.getModelPath(descriptor.mmprojId);
                } else {
                    mmprojPath = modelManager.getModelPath('vlm-mmproj');
                }
            }

            // Update Python backend's VLM config so it uses the correct model
            // when starting VLM on-demand (e.g., after system hibernation)
            try {
                await updateVLMConfig({
                    vlm_model: modelPath,
                    vlm_mmproj: mmprojPath
                });
                console.log('[Models IPC] Updated Python backend VLM config:', { modelPath, mmprojPath });
            } catch (e) {
                console.warn('[Models IPC] Failed to update Python VLM config (backend may not be ready):', e);
            }

            await serviceManager.startService({
                alias: 'vlm',
                modelPath: modelPath,
                port: 8007,
                contextSize: newConfig.contextSize,
                threads: 4,
                ngl: 999,
                type: 'vlm',
                mmprojPath: mmprojPath
            });
        }

        // Restart embedding service if embedding model changed
        if (oldConfig.activeEmbeddingModelId !== newConfig.activeEmbeddingModelId) {
            console.log('[Models IPC] Embedding model changed, restarting service...');
            await serviceManager.stopService('embedding');
            try {
                await stopPythonModel('embedding');
            } catch (e) {
                console.log('[Models IPC] Python embedding stop failed (may not be running):', e);
            }
            const embeddingModelId = newConfig.activeEmbeddingModelId || 'embedding-q4';
            const embeddingModelPath = modelManager.getModelPath(embeddingModelId);

            // Update Python backend's embedding config
            try {
                await updateEmbeddingConfig({ embedding_model: embeddingModelPath });
                console.log('[Models IPC] Updated Python backend embedding config:', embeddingModelPath);
            } catch (e) {
                console.warn('[Models IPC] Failed to update Python embedding config:', e);
            }

            await serviceManager.startService({
                alias: 'embedding',
                modelPath: embeddingModelPath,
                port: 8005,
                contextSize: 8192,
                threads: 2,
                ngl: 999,
                type: 'embedding'
            });
        }

        // Restart reranker service if reranker model changed
        if (oldConfig.activeRerankerModelId !== newConfig.activeRerankerModelId) {
            console.log('[Models IPC] Reranker model changed, restarting service...');
            await serviceManager.stopService('reranker');
            try {
                await stopPythonModel('reranking');
            } catch (e) {
                console.log('[Models IPC] Python reranker stop failed (may not be running):', e);
            }
            const rerankerModelId = newConfig.activeRerankerModelId || 'reranker';
            const rerankerModelPath = modelManager.getModelPath(rerankerModelId);

            // Update Python backend's reranker config
            try {
                await updateRerankerConfig({ rerank_model: rerankerModelPath });
                console.log('[Models IPC] Updated Python backend reranker config:', rerankerModelPath);
            } catch (e) {
                console.warn('[Models IPC] Failed to update Python reranker config:', e);
            }

            await serviceManager.startService({
                alias: 'reranker',
                modelPath: rerankerModelPath,
                port: 8006,
                contextSize: 4096,
                threads: 2,
                ngl: 999,
                type: 'reranking',
                ubatchSize: 2048
            });
        }

        // Restart whisper service if audio model changed
        if (oldConfig.activeAudioModelId !== newConfig.activeAudioModelId) {
            console.log('[Models IPC] Audio model changed, restarting whisper service...');
            await serviceManager.stopService('whisper');
            try {
                await stopPythonModel('transcription');
            } catch (e) {
                console.log('[Models IPC] Python whisper stop failed (may not be running):', e);
            }
            const audioModelId = newConfig.activeAudioModelId || 'whisper-small';
            const whisperModelPath = modelManager.getModelPath(audioModelId);

            // Update Python backend's whisper config
            try {
                await updateWhisperConfig({ whisper_model: whisperModelPath });
                console.log('[Models IPC] Updated Python backend whisper config:', whisperModelPath);
            } catch (e) {
                console.warn('[Models IPC] Failed to update Python whisper config:', e);
            }

            await serviceManager.startService({
                alias: 'whisper',
                modelPath: whisperModelPath,
                port: 8080,
                contextSize: 0,
                threads: 4,
                ngl: 0,
                type: 'whisper'
            });
        }

        return newConfig;
    });

    ipcMain.handle('models:add', async (_event, descriptor) => {
        await modelManager.addModel(descriptor);
        return descriptor;
    });
}
