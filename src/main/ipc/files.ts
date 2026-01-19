import { ipcMain, dialog, shell, app } from 'electron';
import fs from 'fs';
import path from 'path';
import {
    listFolders,
    addFolder,
    removeFolder,
    runIndex,
    getIndexStatus,
    getIndexSummary,
    pauseIndexing,
    resumeIndexing,
    getIndexInventory,
    listIndexedFiles,
    getFileById,
    deleteIndexedFile,
    searchFiles,
    searchFilesStream,
    IndexOperationOptions,
    getChunkById,
    listChunksForFile,
    getChunkHighlightPngBase64,
    // Staged indexing
    getStageProgress,
    startSemanticIndexing,
    stopSemanticIndexing,
    startDeepIndexing,
    stopDeepIndexing,
    getDeepStatus,
    runStagedIndex,
    // Privacy
    setFilePrivacy,
    getFilePrivacy,
    setFolderPrivacy,
    getFolderPrivacy,
} from '../backendClient';
import { WindowManager } from '../windowManager';

const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico'];

async function isPathInIndexedFolders(targetPath: string): Promise<boolean> {
    try {
        const folders = await listFolders();
        const resolvedTarget = path.resolve(targetPath);
        for (const folder of folders) {
            const resolvedFolder = path.resolve(folder.path);
            if (resolvedTarget.startsWith(resolvedFolder + path.sep) || resolvedTarget === resolvedFolder) {
                return true;
            }
        }
        const userData = app.getPath('userData');
        if (resolvedTarget.startsWith(userData + path.sep)) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

export function registerFileHandlers(windowManager: WindowManager) {
    ipcMain.handle('folders:pick', async () => {
        const openDialogOptions: Electron.OpenDialogOptions = {
            properties: ['openDirectory', 'multiSelections']
        };

        const result = windowManager.mainWindow
            ? await dialog.showOpenDialog(windowManager.mainWindow, openDialogOptions)
            : await dialog.showOpenDialog(openDialogOptions);

        if (result.canceled || !result.filePaths.length) {
            return [] as string[];
        }

        return result.filePaths;
    });

    ipcMain.handle('folders:list', async () => listFolders());

    ipcMain.handle('folders:add', async (_event, payload: { path: string; label?: string; scanMode?: 'full' | 'manual' }) => {
        if (!payload?.path) {
            throw new Error('Missing folder path.');
        }
        return addFolder(payload.path, payload.label, payload.scanMode);
    });

    ipcMain.handle('folders:remove', async (_event, folderId: string) => {
        if (!folderId) {
            throw new Error('Missing folder id.');
        }
        await removeFolder(folderId);
        return { id: folderId };
    });

    ipcMain.handle('index:run', async (_event, payload: IndexOperationOptions | undefined) => {
        return runIndex(payload);
    });

    ipcMain.handle('index:status', async () => getIndexStatus());
    ipcMain.handle('index:summary', async () => getIndexSummary());
    ipcMain.handle('index:pause', async () => pauseIndexing());
    ipcMain.handle('index:resume', async () => resumeIndexing());

    // Staged indexing (two-round progressive system)
    ipcMain.handle('index:stage-progress', async (_event, folderId?: string) => getStageProgress(folderId));
    ipcMain.handle('index:start-semantic', async () => startSemanticIndexing());
    ipcMain.handle('index:stop-semantic', async () => stopSemanticIndexing());
    ipcMain.handle('index:start-deep', async () => startDeepIndexing());
    ipcMain.handle('index:stop-deep', async () => stopDeepIndexing());
    ipcMain.handle('index:deep-status', async () => getDeepStatus());
    ipcMain.handle('index:run-staged', async (_event, options?: { folders?: string[]; files?: string[]; mode?: 'rescan' | 'reindex' }) => 
        runStagedIndex(options));

    ipcMain.handle('index:list', async (_event, payload: { folderId?: string; limit?: number; offset?: number }) => {
        return getIndexInventory(payload);
    });

    ipcMain.handle('files:list', async (_event, payload: { limit?: number; offset?: number }) => {
        return listIndexedFiles(payload?.limit, payload?.offset);
    });

    ipcMain.handle('files:get', async (_event, fileId: string) => {
        if (!fileId) {
            throw new Error('Missing file id.');
        }
        return getFileById(fileId);
    });

    ipcMain.handle('files:get-chunk', async (_event, chunkId: string) => {
        if (!chunkId) {
            throw new Error('Missing chunk id.');
        }
        return getChunkById(chunkId);
    });

    ipcMain.handle('files:list-chunks', async (_event, fileId: string) => {
        if (!fileId) {
            throw new Error('Missing file id.');
        }
        return listChunksForFile(fileId);
    });

    ipcMain.handle('files:chunk-highlight', async (_event, payload: { chunkId: string; zoom?: number }) => {
        const chunkId = payload?.chunkId;
        if (!chunkId) {
            throw new Error('Missing chunk id.');
        }
        const zoom = typeof payload?.zoom === 'number' ? payload.zoom : 2.0;
        return getChunkHighlightPngBase64(chunkId, zoom);
    });

    ipcMain.handle('files:open', async (_event, payload: { path: string }) => {
        const targetPath = payload?.path;
        if (!targetPath) {
            throw new Error('Missing file path.');
        }

        const isAllowed = await isPathInIndexedFolders(targetPath);
        if (!isAllowed) {
            throw new Error('Access denied: path is outside indexed folders.');
        }

        const result = await shell.openPath(targetPath);
        if (result) {
            throw new Error(result);
        }

        return { path: targetPath };
    });

    ipcMain.handle('files:delete', async (_event, fileId: string) => {
        if (!fileId) {
            throw new Error('Missing file id.');
        }
        await deleteIndexedFile(fileId);
        return { id: fileId };
    });

    ipcMain.handle('files:read-image', async (_event, payload: { filePath: string }) => {
        if (!payload?.filePath) {
            throw new Error('Missing file path.');
        }

        const ext = path.extname(payload.filePath).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
            throw new Error(`Access denied: file type "${ext}" is not an allowed image format.`);
        }

        const isAllowed = await isPathInIndexedFolders(payload.filePath);
        if (!isAllowed) {
            throw new Error('Access denied: path is outside indexed folders.');
        }

        try {
            const buffer = await fs.promises.readFile(payload.filePath);
            return buffer.toString('base64');
        } catch (error) {
            console.error('Failed to read image file:', error);
            throw error;
        }
    });

    ipcMain.handle('files:pick-one', async (_event, options) => {
        if (!windowManager.mainWindow) return null;
        const result = await dialog.showOpenDialog(windowManager.mainWindow, {
            properties: ['openFile'],
            filters: options?.filters
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    // Pick multiple files for indexing
    ipcMain.handle('files:pick-multiple', async (_event, options) => {
        const openDialogOptions: Electron.OpenDialogOptions = {
            properties: ['openFile', 'multiSelections'],
            filters: options?.filters
        };

        const result = windowManager.mainWindow
            ? await dialog.showOpenDialog(windowManager.mainWindow, openDialogOptions)
            : await dialog.showOpenDialog(openDialogOptions);

        if (result.canceled || !result.filePaths.length) {
            return [] as string[];
        }

        return result.filePaths;
    });

    ipcMain.handle('search:query', async (_event, payload: { query: string; limit?: number }) => {
        return searchFiles(payload?.query ?? '', payload?.limit);
    });

    // Progressive/layered search stream
    ipcMain.on('search:stream', (event, payload: { query: string; limit?: number }) => {
        const query = payload?.query ?? '';
        const limit = payload?.limit ?? 10;

        if (!query.trim()) {
            event.sender.send('search:stream-done');
            return;
        }

        searchFilesStream(
            query,
            limit,
            (chunk) => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send('search:stream-data', chunk);
                }
            },
            (error) => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send('search:stream-error', error.message);
                }
            },
            () => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send('search:stream-done');
                }
            }
        ).catch((err) => {
            if (!event.sender.isDestroyed()) {
                event.sender.send('search:stream-error', String(err));
            }
        });
    });

    // ========================================
    // Privacy Handlers
    // ========================================

    ipcMain.handle('privacy:set-file', async (_event, payload: { fileId: string; privacyLevel: 'normal' | 'private' }) => {
        if (!payload?.fileId) {
            throw new Error('Missing file id.');
        }
        const result = await setFilePrivacy(payload.fileId, payload.privacyLevel);
        return {
            fileId: result.file_id,
            privacyLevel: result.privacy_level,
            updated: result.updated
        };
    });

    ipcMain.handle('privacy:get-file', async (_event, payload: { fileId: string }) => {
        if (!payload?.fileId) {
            throw new Error('Missing file id.');
        }
        const result = await getFilePrivacy(payload.fileId);
        return {
            fileId: result.file_id,
            privacyLevel: result.privacy_level
        };
    });

    ipcMain.handle('privacy:set-folder', async (_event, payload: { 
        folderId: string; 
        privacyLevel: 'normal' | 'private';
        applyToFiles?: boolean;
    }) => {
        if (!payload?.folderId) {
            throw new Error('Missing folder id.');
        }
        const result = await setFolderPrivacy(
            payload.folderId, 
            payload.privacyLevel, 
            payload.applyToFiles ?? true
        );
        return {
            folderId: result.folder_id,
            privacyLevel: result.privacy_level,
            updated: result.updated,
            filesUpdated: result.files_updated
        };
    });

    ipcMain.handle('privacy:get-folder', async (_event, payload: { folderId: string }) => {
        if (!payload?.folderId) {
            throw new Error('Missing folder id.');
        }
        const result = await getFolderPrivacy(payload.folderId);
        return {
            folderId: result.folder_id,
            privacyLevel: result.privacy_level,
            filesNormal: result.files_normal,
            filesPrivate: result.files_private
        };
    });
}
