import { EventEmitter } from 'events';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { app, net } from 'electron';
import ProxyAgent from 'proxy-agent';
import type { ModelAssetStatus, ModelDownloadEvent, ModelStatusSummary } from '../types/files';

type ModelAssetDescriptor = {
    id: string;
    label: string;
    relativePath: string;
    optional?: boolean;
    type: 'embedding' | 'reranker' | 'vlm' | 'completion';
    url: string;
    mmprojId?: string;
};

interface ModelConfig {
    activeModelId: string;
    activeEmbeddingModelId: string;
    activeRerankerModelId: string;
    activeAudioModelId: string;  // Whisper model for speech recognition
    contextSize: number;
    visionMaxPixels: number;
    videoMaxPixels: number;
    pdfOneChunkPerPage: boolean;
    summaryMaxTokens?: number;
    searchResultLimit?: number;
    qaContextLimit?: number;
    maxSnippetLength?: number;
    embedBatchSize?: number;
    embedBatchDelayMs?: number;
    visionBatchDelayMs?: number;
    debugMode?: boolean;
}



export class ModelManager extends EventEmitter {
    private readonly modelRootPath: string;
    private readonly projectRoot: string;
    private readonly configPath: string;
    private readonly modelsConfigPath: string;
    private activeDownload: Promise<ModelStatusSummary> | null = null;
    private descriptors: ModelAssetDescriptor[] = [];
    private proxyAgent: any | null = null;
    private config: ModelConfig = {
        activeModelId: 'vlm',
        activeEmbeddingModelId: 'embedding-q4',
        activeRerankerModelId: 'reranker',
        activeAudioModelId: 'whisper-small',  // Multi-language whisper model
        contextSize: 8192,
        visionMaxPixels: 1003520,
        videoMaxPixels: 307200,  // ~640×480, lower than images for faster video processing
        pdfOneChunkPerPage: true,
        summaryMaxTokens: 256,
        searchResultLimit: 15,
        qaContextLimit: 5,
        maxSnippetLength: 2000,
        embedBatchSize: 10,
        embedBatchDelayMs: 10,
        visionBatchDelayMs: 200,
        debugMode: true
    };
    public readonly initializePromise: Promise<void>;

    constructor(projectRoot: string, modelRoot?: string) {
        super();
        this.projectRoot = projectRoot;

        this.modelRootPath = modelRoot ? modelRoot : path.join(app.getPath('userData'), 'local-cocoa-models', 'pretrained');

        this.configPath = path.join(app.getPath('userData'), 'model-config.json');
        this.modelsConfigPath = path.join(projectRoot, 'config', 'models.config.json');

        console.log('[ModelManager] Initialized');
        console.log('[ModelManager] Model Root:', this.modelRootPath);
        console.log('[ModelManager] Models Config:', this.modelsConfigPath);

        this.initializePromise = this.initialize();
    }

    private async initialize() {
        await this.loadConfig();
        await this.loadModelDescriptors();
    }

    private async loadModelDescriptors() {
        try {
            const data = await fs.readFile(this.modelsConfigPath, 'utf-8');
            const json = JSON.parse(data);
            if (Array.isArray(json.models)) {
                this.descriptors = json.models;
            }
        } catch (error) {
            console.error('Failed to load models.config.json:', error);
            this.descriptors = [];
        }
    }

    private async loadConfig() {
        try {
            const data = await fs.readFile(this.configPath, 'utf-8');
            this.config = { ...this.config, ...JSON.parse(data) };
        } catch {
            // Ignore error, use defaults
        }
    }

    private async saveConfig() {
        try {
            await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
        } catch (error) {
            console.error('Failed to save model config:', error);
        }
    }

    async getConfig(): Promise<ModelConfig> {
        return this.config;
    }

    async setConfig(newConfig: Partial<ModelConfig>): Promise<void> {
        this.config = { ...this.config, ...newConfig };
        await this.saveConfig();
        this.emit('config-changed', this.config);
    }

    getModelPath(id: string): string {
        const descriptor = this.descriptors.find((d) => d.id === id);
        if (!descriptor) {
            // Fallback for synchronous access if descriptors aren't loaded yet
            // This is a best-effort fallback for the known structure
            if (id === 'embedding' || id === 'embedding-q4') return path.join(this.modelRootPath, 'Qwen3-Embedding-0.6B-Q4_K_M.gguf');
            if (id === 'reranker') return path.join(this.modelRootPath, 'bge-reranker-v2-m3-q8_0.gguf');
            if (id === 'vlm') return path.join(this.modelRootPath, 'qwenvl', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf');
            throw new Error(`Unknown model id: ${id}`);
        }
        return path.join(this.modelRootPath, descriptor.relativePath);
    }

    getDescriptor(id: string): ModelAssetDescriptor | undefined {
        return this.descriptors.find((d) => d.id === id);
    }

    async getStatus(): Promise<ModelStatusSummary> {
        if (this.descriptors.length === 0) {
            await this.loadModelDescriptors();
        }
        const assets = await Promise.all(
            this.descriptors.map(async (descriptor) => this.describeAsset(descriptor))
        );
        const missing = assets.filter((asset) => !asset.exists && !asset.optional).map((asset) => asset.id);
        return {
            assets,
            ready: missing.length === 0 && this.descriptors.length > 0,
            missing,
            lastCheckedAt: new Date().toISOString()
        };
    }

    async downloadMissing(): Promise<ModelStatusSummary> {
        if (this.activeDownload) {
            return this.activeDownload;
        }
        this.activeDownload = this.performDownload();
        try {
            return await this.activeDownload;
        } finally {
            this.activeDownload = null;
        }
    }

    async redownloadAsset(assetId: string): Promise<ModelStatusSummary> {
        if (this.activeDownload) {
            return this.activeDownload;
        }
        if (this.descriptors.length === 0) {
            await this.loadModelDescriptors();
        }
        const descriptor = this.descriptors.find((d) => d.id === assetId);
        if (!descriptor) {
            throw new Error(`Unknown model asset: ${assetId}`);
        }

        this.activeDownload = this.performSingleAssetDownload(descriptor);
        try {
            return await this.activeDownload;
        } finally {
            this.activeDownload = null;
        }
    }

    private async performDownload(): Promise<ModelStatusSummary> {
        await fs.mkdir(this.modelRootPath, { recursive: true });

        if (this.descriptors.length === 0) {
            await this.loadModelDescriptors();
        }

        const status = await this.getStatus();

        // Note: We don't return early if status.ready is true, because there might
        // be optional assets that are missing and we want to download them too.

        // Download all missing assets (including optional ones if they are missing)
        const assetsToDownload = this.descriptors.filter(d => {
            const assetStatus = status.assets.find(a => a.id === d.id);
            return !assetStatus?.exists;
        });

        console.log('[ModelManager] Descriptors count:', this.descriptors.length);
        console.log('[ModelManager] Assets to download:', assetsToDownload.map(a => a.id));
        console.log('[ModelManager] Model Root Path:', this.modelRootPath);

        if (assetsToDownload.length === 0) {
            if (this.descriptors.length === 0) {
                const msg = 'No model descriptors found. Check models.config.json path: ' + this.modelsConfigPath;
                console.error('[ModelManager]', msg);
                this.emitProgress({ state: 'error', message: msg, statuses: status.assets });
            } else {
                this.emitProgress({ state: 'completed', percent: 100, message: 'All models ready.', statuses: status.assets });
            }
            return status;
        }

        this.emitProgress({ state: 'downloading', percent: 0, message: 'Starting download...' });

        for (const asset of assetsToDownload) {
            try {
                await this.downloadDescriptor(asset);
                // Emit status update after each successful download so UI updates incrementally
                const currentStatus = await this.getStatus();
                this.emitProgress({
                    state: 'downloading',
                    assetId: asset.id,
                    message: `${asset.label} downloaded.`,
                    statuses: currentStatus.assets
                });
            } catch (error: any) {
                this.emitProgress({ state: 'error', message: `Failed to download ${asset.label}: ${error.message}` });
                throw error;
            }
        }

        const finalStatus = await this.getStatus();
        this.emitProgress({ state: 'completed', percent: 100, statuses: finalStatus.assets, message: 'All downloads finished.' });
        return finalStatus;
    }

    private async performSingleAssetDownload(asset: ModelAssetDescriptor): Promise<ModelStatusSummary> {
        await fs.mkdir(this.modelRootPath, { recursive: true });
        this.emitProgress({ state: 'downloading', assetId: asset.id, percent: 0, message: `Preparing to redownload ${asset.label}...` });
        await this.removeAssetFiles(asset);
        try {
            await this.downloadDescriptor(asset);
        } catch (error: any) {
            this.emitProgress({ state: 'error', assetId: asset.id, message: `Failed to redownload ${asset.label}: ${error.message}` });
            throw error;
        }
        const finalStatus = await this.getStatus();
        this.emitProgress({ state: 'completed', assetId: asset.id, percent: 100, statuses: finalStatus.assets, message: `${asset.label} refreshed.` });
        return finalStatus;
    }

    private async downloadDescriptor(asset: ModelAssetDescriptor): Promise<void> {
        const destPath = path.join(this.modelRootPath, asset.relativePath);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await this.downloadFile(asset.url, destPath, asset.id);
    }

    private async removeAssetFiles(asset: ModelAssetDescriptor): Promise<void> {
        const destPath = path.join(this.modelRootPath, asset.relativePath);
        this.emitProgress({ state: 'downloading', assetId: asset.id, message: `Removing existing ${asset.label}...` });
        try {
            await fs.rm(destPath, { force: true });
        } catch (error) {
            console.warn(`[ModelManager] Failed to remove existing asset ${asset.id}:`, error);
        }
        try {
            await fs.rm(`${destPath}.downloading`, { force: true });
        } catch {
            // Ignore cleanup failure for temp artifacts
        }
    }

    private async downloadFile(url: string, destPath: string, assetId: string): Promise<void> {
        if (!this.hasProxyEnvVars()) {
            // Electron's net stack respects system proxy settings (Clash/Shadowsocks etc.)
            // so prefer it when no explicit env proxy is configured.
            return this.downloadFileViaElectronNet(url, destPath, assetId);
        }

        return this.downloadFileViaNode(url, destPath, assetId);
    }

    private hasProxyEnvVars(): boolean {
        const env = process.env;
        return Boolean(
            env.HTTPS_PROXY || env.https_proxy ||
            env.HTTP_PROXY || env.http_proxy ||
            env.ALL_PROXY || env.all_proxy
        );
    }

    private async downloadFileViaNode(url: string, destPath: string, assetId: string): Promise<void> {
        const tempPath = `${destPath}.downloading`;
        return new Promise((resolve, reject) => {
            const cleanupTemp = async () => {
                await fs.unlink(tempPath).catch(() => { });
            };

            const request = (uri: string, redirectsLeft: number) => {
                this.emitProgress({ state: 'downloading', assetId, message: `Connecting to ${assetId}...` });

                let targetUrl: URL;
                try {
                    targetUrl = new URL(uri);
                } catch (err) {
                    reject(err);
                    return;
                }

                const client = targetUrl.protocol === 'http:' ? http : https;
                const agent = this.getProxyAgent();

                const req = client.get(
                    targetUrl,
                    {
                        agent,
                        headers: {
                            'User-Agent': 'LocalCocoa/0.1'
                        }
                    },
                    (response) => {
                        const statusCode = response.statusCode ?? 0;
                        const location = response.headers.location;

                        if (statusCode >= 300 && statusCode < 400 && location) {
                            if (redirectsLeft <= 0) {
                                reject(new Error('Too many redirects'));
                                return;
                            }
                            const nextUrl = new URL(location, targetUrl).toString();
                            response.resume();
                            request(nextUrl, redirectsLeft - 1);
                            return;
                        }

                        if (statusCode !== 200) {
                            response.resume();
                            reject(new Error(`HTTP ${statusCode}`));
                            return;
                        }

                        const totalBytes = parseInt(String(response.headers['content-length'] || '0'), 10) || 0;
                        let downloadedBytes = 0;
                        const fileStream = createWriteStream(tempPath);

                        response.pipe(fileStream);

                        response.on('data', (chunk) => {
                            downloadedBytes += chunk.length;
                            const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : null;
                            const downloadedMb = Math.round(downloadedBytes / 1024 / 1024);
                            const totalMb = totalBytes > 0 ? Math.round(totalBytes / 1024 / 1024) : null;
                            this.emitProgress({
                                state: 'downloading',
                                assetId,
                                percent,
                                message: totalMb != null
                                    ? `Downloading ${assetId} (${downloadedMb}MB / ${totalMb}MB)`
                                    : `Downloading ${assetId} (${downloadedMb}MB)`
                            });
                        });

                        fileStream.on('finish', async () => {
                            fileStream.close();
                            try {
                                await fs.rename(tempPath, destPath);
                                resolve();
                            } catch (err) {
                                await cleanupTemp();
                                reject(err);
                            }
                        });

                        fileStream.on('error', async (err) => {
                            fileStream.close();
                            await cleanupTemp();
                            reject(err);
                        });

                        response.on('error', async (err) => {
                            await cleanupTemp();
                            reject(err);
                        });
                    }
                );

                req.on('error', async (err) => {
                    await cleanupTemp();
                    reject(err);
                });
            };

            request(url, 10);
        });
    }

    private async downloadFileViaElectronNet(url: string, destPath: string, assetId: string): Promise<void> {
        const tempPath = `${destPath}.downloading`;
        return new Promise((resolve, reject) => {
            const cleanupTemp = async () => {
                await fs.unlink(tempPath).catch(() => { });
            };

            const request = (uri: string, redirectsLeft: number) => {
                this.emitProgress({ state: 'downloading', assetId, message: `Connecting to ${assetId}...` });

                const req = net.request({
                    method: 'GET',
                    url: uri,
                });

                req.on('response', (response) => {
                    const statusCode = response.statusCode ?? 0;
                    const locationHeader = (response.headers as any)?.location;
                    const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;

                    if (statusCode >= 300 && statusCode < 400 && location) {
                        if (redirectsLeft <= 0) {
                            reject(new Error('Too many redirects'));
                            return;
                        }
                        const nextUrl = new URL(String(location), uri).toString();
                        (response as any).resume?.();
                        request(nextUrl, redirectsLeft - 1);
                        return;
                    }

                    if (statusCode !== 200) {
                        (response as any).resume?.();
                        reject(new Error(`HTTP ${statusCode}`));
                        return;
                    }

                    const totalBytes = parseInt(String((response.headers as any)?.['content-length'] || '0'), 10) || 0;
                    let downloadedBytes = 0;
                    const fileStream = createWriteStream(tempPath);

                    (response as any).pipe(fileStream);

                    response.on('data', (chunk) => {
                        downloadedBytes += chunk.length;
                        const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : null;
                        const downloadedMb = Math.round(downloadedBytes / 1024 / 1024);
                        const totalMb = totalBytes > 0 ? Math.round(totalBytes / 1024 / 1024) : null;
                        this.emitProgress({
                            state: 'downloading',
                            assetId,
                            percent,
                            message: totalMb != null
                                ? `Downloading ${assetId} (${downloadedMb}MB / ${totalMb}MB)`
                                : `Downloading ${assetId} (${downloadedMb}MB)`
                        });
                    });

                    fileStream.on('finish', async () => {
                        fileStream.close();
                        try {
                            await fs.rename(tempPath, destPath);
                            resolve();
                        } catch (err) {
                            await cleanupTemp();
                            reject(err);
                        }
                    });

                    fileStream.on('error', async (err) => {
                        fileStream.close();
                        await cleanupTemp();
                        reject(err);
                    });

                    response.on('error', async (err: any) => {
                        await cleanupTemp();
                        reject(err);
                    });
                });

                req.on('error', async (err) => {
                    await cleanupTemp();
                    reject(err);
                });

                req.end();
            };

            request(url, 10);
        });
    }

    private getProxyAgent(): any | undefined {
        if (!this.hasProxyEnvVars()) {
            return undefined;
        }
        if (!this.proxyAgent) {
            // proxy-agent automatically respects: HTTP(S)_PROXY, ALL_PROXY, NO_PROXY (and lowercase variants)
            this.proxyAgent = new (ProxyAgent as any)();
        }
        return this.proxyAgent;
    }

    private async describeAsset(descriptor: ModelAssetDescriptor): Promise<ModelAssetStatus> {
        const filePath = path.join(this.modelRootPath, descriptor.relativePath);
        let exists = false;
        let sizeBytes: number | null = null;
        try {
            const stats = await fs.stat(filePath);
            if (stats.isFile() && stats.size > 0) {
                exists = true;
                sizeBytes = stats.size;
            }
        } catch {
            exists = false;
        }
        return {
            id: descriptor.id,
            label: descriptor.label,
            path: filePath,
            exists,
            sizeBytes,
            optional: Boolean(descriptor.optional),
            mmprojId: descriptor.mmprojId
        };
    }

    private emitProgress(event: Partial<ModelDownloadEvent>): void {
        const payload: ModelDownloadEvent = {
            state: event.state ?? 'downloading',
            message: event.message ?? null,
            percent: event.percent ?? null,
            assetId: event.assetId ?? null,
            statuses: event.statuses,
            logLine: event.logLine
        };
        this.emit('event', payload);
    }

    async addModel(descriptor: ModelAssetDescriptor): Promise<void> {
        this.descriptors.push(descriptor);
        // Save to models.config.json
        try {
            const data = await fs.readFile(this.modelsConfigPath, 'utf-8');
            const json = JSON.parse(data);
            if (!Array.isArray(json.models)) {
                json.models = [];
            }
            json.models.push(descriptor);
            await fs.writeFile(this.modelsConfigPath, JSON.stringify(json, null, 4));
        } catch (error) {
            console.error('Failed to save new model to config:', error);
        }
    }
}
