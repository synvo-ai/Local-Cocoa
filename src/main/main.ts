import { app, BrowserWindow, nativeImage } from 'electron';
import path from 'path';
import { loadEnvConfig, config } from './config';

// Set app name early for macOS menu bar and About panel
app.setName('Local Cocoa');

if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
        applicationName: 'Local Cocoa',
        applicationVersion: app.getVersion(),
        version: app.getVersion(),
        copyright: '© 2025 Synvo AI'
    });
}

// Load environment variables first before loading other modules (works in both dev and prod)
loadEnvConfig();

// Modify userData path for development, keep using the local project folder for convenience
if (config.isDev) {
    const devUserDataPath = path.join(config.projectRoot, 'runtime');
    app.setPath('userData', devUserDataPath);
    console.log(`[Main] Dev mode: userData path set to ${devUserDataPath}`);
}

import './logger'; // Initialize logger
import { WindowManager } from './windowManager';
import { ServiceManager } from './serviceManager';
import { ModelManager } from './modelManager';
import { PythonServer } from './pythonServer';
import { TrayManager } from './trayManager';
import { setDebugMode, createDebugLogger } from './debug';
import { registerFileHandlers } from './ipc/files';
import { registerEmailHandlers } from './ipc/email';
import { registerNotesHandlers } from './ipc/notes';
import { registerChatHandlers } from './ipc/chat';
import { registerActivityHandlers } from './ipc/activity';
import { registerModelHandlers } from './ipc/models';
import { registerSystemHandlers } from './ipc/system';
import { registerScanHandlers } from './ipc/scan';
import { registerMemoryHandlers } from './ipc/memory';
import { registerMCPHandlers, initMCPServer } from './ipc/mcp';
import { initPluginManager, getPluginManager } from './plugins';
import { ModelDownloadEvent } from './types';

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

const windowManager = new WindowManager();
const modelManager = new ModelManager(config.projectRoot);
const serviceManager = new ServiceManager(config.projectRoot);
const pythonServer = new PythonServer();
let trayManager: TrayManager | null = null;

// Initialize plugin manager
const pluginManager = initPluginManager(config.projectRoot);

function broadcastModelEvent(event: ModelDownloadEvent) {
    windowManager.broadcast('models:progress', event);
}

modelManager.on('event', (event: ModelDownloadEvent) => {
    broadcastModelEvent(event);
    if (event.state === 'completed') {
        console.log('[Main] Model download completed. Retrying service startup...');
        startServices().catch(console.error);
    }
});

async function startServices() {
    await modelManager.initializePromise;
    const modelConfig = await modelManager.getConfig();

    // Initialize debug mode from config
    setDebugMode(modelConfig.debugMode ?? false);

    const debugLog = createDebugLogger('Main');
    debugLog('startServices() called');
    debugLog(`app.isPackaged: ${app.isPackaged}, isDev: ${config.isDev}`);

    // Start Python Backend with config
    await pythonServer.start({
        LOCAL_VISION_MAX_PIXELS: (modelConfig.visionMaxPixels || 1003520).toString(),
        LOCAL_PDF_ONE_CHUNK_PER_PAGE: String(modelConfig.pdfOneChunkPerPage ?? true)
    });

    const modelPath = modelManager.getModelPath(modelConfig.activeModelId);
    const descriptor = modelManager.getDescriptor(modelConfig.activeModelId);

    console.log('[Main] Starting services with config:', modelConfig);
    console.log('[Main] Active model descriptor:', descriptor);
    console.log('[Main] Resolved model path:', modelPath);

    // Start VLM/LLM
    try {
        let mmprojPath: string | undefined;
        if (descriptor?.type === 'vlm' || descriptor?.id === 'vlm') {
            if (descriptor.mmprojId) {
                mmprojPath = modelManager.getModelPath(descriptor.mmprojId);
            } else {
                mmprojPath = modelManager.getModelPath('vlm-mmproj');
            }
        }

        console.log('[Main] VLM mmproj path:', mmprojPath);

        await serviceManager.startService({
            alias: 'vlm',
            modelPath: modelPath,
            port: config.ports.vlm,
            contextSize: modelConfig.contextSize,
            threads: 4,
            ngl: 999,
            type: 'vlm',
            mmprojPath: mmprojPath
        });
    } catch (err) {
        console.error('Failed to start VLM service:', err);
    }

    // Start Embedding
    try {
        const embeddingModelId = modelConfig.activeEmbeddingModelId || 'embedding-q4';
        console.log('[Main] Starting embedding with model:', embeddingModelId);

        // Fixed embedding server config - benchmark showed minimal impact from tuning
        // Using economical defaults that work well across all configurations
        await serviceManager.startService({
            alias: 'embedding',
            modelPath: modelManager.getModelPath(embeddingModelId),
            port: config.ports.embedding,
            contextSize: 8192,
            threads: 4,         // Increased for parallel request handling
            ngl: 999,
            type: 'embedding',
            batchSize: 8192,    // Max prompt length (tokens)
            ubatchSize: 512,    // Micro-batch for GPU processing
            parallel: 4         // 4 slots for parallel embedding requests
        });




    } catch (err) {
        console.error('Failed to start Embedding service:', err);
    }

    // Start Reranker
    try {
        const rerankerModelId = modelConfig.activeRerankerModelId || 'reranker';
        console.log('[Main] Starting reranker with model:', rerankerModelId);
        await serviceManager.startService({
            alias: 'reranker',
            modelPath: modelManager.getModelPath(rerankerModelId),
            port: config.ports.reranker,
            contextSize: 4096,
            threads: 2,
            ngl: 999,
            type: 'reranking',
            ubatchSize: 2048
        });
    } catch (err) {
        console.error('Failed to start Reranker service:', err);
    }

    // Start Whisper
    try {
        // Use configured audio model (can be changed in settings)
        // Available: whisper-base (English only), whisper-small (multi-language), whisper-large-v3-turbo (best quality)
        const whisperModelId = modelConfig.activeAudioModelId || 'whisper-small';

        console.log('[Main] Starting whisper with model:', whisperModelId);
        await serviceManager.startService({
            alias: 'whisper',
            modelPath: modelManager.getModelPath(whisperModelId),
            port: config.ports.whisper,
            contextSize: 0,
            threads: 4,
            ngl: 0,
            type: 'whisper'
        });
    } catch (err) {
        console.error('Failed to start Whisper service:', err);
    }
}

app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
        const iconPath = path.join(config.projectRoot, 'assets', 'icon.png');
        app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }

    windowManager.createApplicationMenu();

    // Start backend services FIRST, then create window
    // This ensures API key is available before frontend makes requests
    try {
        await startServices();
    } catch (error) {
        console.error('Failed to start services:', error);
    }

    windowManager.createMainWindow().catch((error) => {
        console.error('Failed to create window', error);
    });

    windowManager.registerSpotlightShortcut();
    windowManager.registerQuickNoteShortcut();

    // Initialize plugin system
    try {
        await pluginManager.initialize();
        pluginManager.registerIPCHandlers();

        // Set main window reference for plugin notifications
        if (windowManager.mainWindow) {
            pluginManager.setMainWindow(windowManager.mainWindow);
        }

        console.log('[Main] Plugin system initialized');
    } catch (error) {
        console.error('[Main] Failed to initialize plugin system:', error);
    }

    // Create system tray
    trayManager = new TrayManager(windowManager);
    trayManager.createTray();

    app.on('activate', () => {
        if (windowManager.mainWindow) {
            if (!windowManager.mainWindow.isVisible()) {
                windowManager.mainWindow.show();
            } else {
                windowManager.mainWindow.focus();
            }
            return;
        }
        if (BrowserWindow.getAllWindows().length === 0) {
            windowManager.createMainWindow().catch((error) => console.error('Failed to recreate window', error));
        }
    });
});

app.on('window-all-closed', () => {
    console.log('App window-all-closed');
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

let isQuitting = false;

app.on('before-quit', async (event) => {
    if (isQuitting) return;

    event.preventDefault();
    console.log('App before-quit: Stopping services...');

    try {
        await serviceManager.stopAll();
        pythonServer.stop();
    } catch (error) {
        console.error('Error stopping services:', error);
    } finally {
        isQuitting = true;
        app.quit();
    }
});

// Register IPC Handlers
registerFileHandlers(windowManager);
registerEmailHandlers();
registerNotesHandlers();
registerChatHandlers();
registerActivityHandlers();
registerModelHandlers(modelManager, serviceManager);
registerSystemHandlers(windowManager);
registerScanHandlers();
registerMemoryHandlers();
registerMCPHandlers();

// Initialize MCP server (for Claude Desktop integration)
initMCPServer();
