/**
 * Enhanced Scan IPC Handlers
 * 
 * Features:
 * - Scope-based scanning with smart recommendations
 * - Configurable exclusions
 * - File type filtering (Code type excluded)
 * - Origin detection (Downloaded, Synced, Created here)
 * - Progress stages with detailed counters
 * - Folder tree building with pruning
 */

import { ipcMain, IpcMainEvent, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ScannedFile, ScanProgress, ScanStage, ScanOptions, FileKind, FolderNode, ScanDirectory, ScanSettings } from '../../types/files';
import {
    getSmartRecommendedDirectories,
    getSystemExclusions,
    shouldExcludeByName,
    shouldExcludeByPath,
    isSupportedFileType,
    getFileKindFromExtension,
    detectFileOrigin,
    loadScanSettings,
    saveScanSettings,
    getDefaultScanSettings,
    UNIVERSAL_DIR_EXCLUSIONS,
} from '../scanConfig';
import { WindowManager } from '../windowManager';

// Active scan state
let activeScanAbortController: AbortController | null = null;

interface ScanContext {
    event: IpcMainEvent;
    options: ScanOptions;
    cutoffDate: Date | null; // For "newer than" filtering
    dateFrom: Date | null; // For range filtering (start)
    dateTo: Date | null; // For range filtering (end)
    systemExclusions: string[];
    customExclusions: string[];

    // Counters
    scannedCount: number;
    matchedCount: number;
    skippedCount: number;

    // Results
    files: ScannedFile[];
    aborted: boolean;

    // Batching for performance
    batchBuffer: ScannedFile[];
    lastBatchTime: number;
    lastProgressTime: number;
}

// Send progress update
function sendProgress(ctx: ScanContext, stage: ScanStage, currentPath?: string) {
    if (ctx.event.sender.isDestroyed()) return;

    const stageLabels: Record<ScanStage, string> = {
        idle: 'Ready',
        planning: 'Scanning...', // Not used, but kept for type safety
        scanning: 'Scanning...',
        building: 'Scanning...', // Not used, but kept for type safety
        completed: 'Complete',
        cancelled: 'Cancelled',
        error: 'Failed',
    };

    const progress: ScanProgress = {
        status: stage,
        stage: stageLabels[stage],
        currentPath,
        scannedCount: ctx.scannedCount,
        matchedCount: ctx.matchedCount,
        skippedCount: ctx.skippedCount,
        startedAt: new Date().toISOString(),
    };

    ctx.event.sender.send('scan:progress', progress);
}

// Check if a path should be excluded
function shouldExclude(fullPath: string, dirName: string, ctx: ScanContext): boolean {
    // Check universal directory name exclusions
    if (shouldExcludeByName(dirName)) {
        return true;
    }

    // Check system exclusions
    if (ctx.options.useRecommendedExclusions && shouldExcludeByPath(fullPath, ctx.systemExclusions)) {
        return true;
    }

    // Check custom exclusions
    if (ctx.customExclusions.length > 0 && shouldExcludeByPath(fullPath, ctx.customExclusions)) {
        return true;
    }

    return false;
}

// Scan a single directory recursively
async function scanDirectory(dirPath: string, ctx: ScanContext): Promise<void> {
    if (ctx.aborted) return;

    // Send progress update when entering a new directory
    const now = Date.now();
    if (now - ctx.lastProgressTime > 200) {
        sendProgress(ctx, 'scanning', dirPath);
        ctx.lastProgressTime = now;
    }

    try {
        // Add timeout for readdir to avoid hanging on slow/network directories
        let entries;
        try {
            entries = await Promise.race([
                fs.promises.readdir(dirPath, { withFileTypes: true }),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('readdir timeout')), 5000)
                )
            ]);
        } catch (readdirErr) {
            // Skip directories that timeout
            ctx.skippedCount++;
            return;
        }

        if (ctx.aborted) return;

        for (const entry of entries) {
            if (ctx.aborted) return;

            const fullPath = path.join(dirPath, entry.name);

            // Skip hidden files/directories
            if (entry.name.startsWith('.')) {
                ctx.skippedCount++;
                continue;
            }

            try {
                if (entry.isDirectory()) {
                    // Check if directory should be excluded
                    if (shouldExclude(fullPath, entry.name, ctx)) {
                        ctx.skippedCount++;
                        continue;
                    }

                    // OPTIMIZATION: Check directory mtime before recursing
                    // If directory hasn't been modified since the time range, skip it entirely
                    // Note: This is a heuristic - directory mtime updates when files are
                    // created/deleted/renamed inside, but NOT when file contents change.
                    // However, this is still a huge optimization for large directories.
                    try {
                        const dirStats = await Promise.race([
                            fs.promises.stat(fullPath),
                            new Promise<never>((_, reject) =>
                                setTimeout(() => reject(new Error('dir stat timeout')), 500)
                            )
                        ]);

                        let shouldSkipDir = false;

                        // For year-based or custom date ranges (dateFrom/dateTo)
                        if (ctx.dateFrom && ctx.dateTo) {
                            // If directory was last modified BEFORE dateFrom, skip it
                            // (no files inside could have been modified within the range)
                            if (dirStats.mtime < ctx.dateFrom) {
                                shouldSkipDir = true;
                            }
                        } else if (ctx.cutoffDate) {
                            // For relative time ranges (Last Week, Last Month, etc.)
                            if (dirStats.mtime < ctx.cutoffDate) {
                                shouldSkipDir = true;
                            }
                        }

                        if (shouldSkipDir) {
                            ctx.skippedCount++;
                            continue;
                        }
                    } catch {
                        // If we can't stat the directory, continue with scanning
                    }

                    // Recursively scan subdirectory
                    await scanDirectory(fullPath, ctx);

                } else if (entry.isFile()) {
                    ctx.scannedCount++;

                    // Send progress updates periodically with file path (not just directory)
                    const currentTime = Date.now();
                    if (currentTime - ctx.lastProgressTime > 200) {
                        sendProgress(ctx, 'scanning', fullPath);
                        ctx.lastProgressTime = currentTime;
                    }

                    // Get file extension
                    const extension = path.extname(entry.name).slice(1).toLowerCase();

                    // Check if this is a supported file type (Code excluded)
                    if (!isSupportedFileType(extension)) {
                        ctx.skippedCount++;
                        continue;
                    }

                    // Get file stats with timeout to avoid hanging on slow files
                    let stats;
                    try {
                        stats = await Promise.race([
                            fs.promises.stat(fullPath),
                            new Promise<never>((_, reject) =>
                                setTimeout(() => reject(new Error('stat timeout')), 1000)
                            )
                        ]);
                    } catch (statErr) {
                        // Skip files that timeout or fail to stat
                        ctx.skippedCount++;
                        continue;
                    }

                    const modifiedAt = stats.mtime;

                    // Check time range filter
                    // If dateFrom and dateTo are set, use range filtering (for year-based or custom ranges)
                    if (ctx.dateFrom && ctx.dateTo) {
                        if (modifiedAt < ctx.dateFrom || modifiedAt > ctx.dateTo) {
                            ctx.skippedCount++;
                            continue;
                        }
                    } else if (ctx.cutoffDate && modifiedAt < ctx.cutoffDate) {
                        // Fallback to cutoff date for relative ranges
                        ctx.skippedCount++;
                        continue;
                    }

                    // Get file kind
                    const kind = getFileKindFromExtension(extension) || 'other';

                    // Detect origin
                    const origin = detectFileOrigin(fullPath);

                    const scannedFile: ScannedFile = {
                        path: fullPath,
                        name: entry.name,
                        extension,
                        size: stats.size,
                        modifiedAt: modifiedAt.toISOString(),
                        createdAt: stats.birthtime.toISOString(),
                        kind,
                        origin,
                        parentPath: dirPath,
                    };

                    ctx.files.push(scannedFile);
                    ctx.matchedCount++;
                    ctx.batchBuffer.push(scannedFile);

                    // Send updates in batches (every 100ms or 50 files)
                    if (ctx.batchBuffer.length >= 50 || currentTime - ctx.lastBatchTime > 100) {
                        if (!ctx.event.sender.isDestroyed()) {
                            ctx.event.sender.send('scan:files', ctx.batchBuffer);
                        }
                        ctx.batchBuffer = [];
                        ctx.lastBatchTime = currentTime;
                    }
                }
            } catch (err) {
                // Skip files/dirs we can't access
                ctx.skippedCount++;
            }
        }
    } catch (err) {
        // Skip directories we can't access
        ctx.skippedCount++;
    }
}

// Build folder tree from scanned files with pruning
function buildFolderTree(files: ScannedFile[], rootPaths: string[], filterKind?: FileKind): FolderNode[] {
    // Group files by their parent paths
    const filesByPath = new Map<string, ScannedFile[]>();

    for (const file of files) {
        // Filter by kind if specified
        if (filterKind && file.kind !== filterKind) {
            continue;
        }

        const parentPath = file.parentPath || path.dirname(file.path);
        if (!filesByPath.has(parentPath)) {
            filesByPath.set(parentPath, []);
        }
        filesByPath.get(parentPath)!.push(file);
    }

    // Build tree structure from root paths
    const trees: FolderNode[] = [];

    for (const rootPath of rootPaths) {
        const tree = buildFolderNodeRecursive(rootPath, filesByPath);
        if (tree && tree.totalFileCount > 0) {
            trees.push(tree);
        }
    }

    return trees;
}

function buildFolderNodeRecursive(
    dirPath: string,
    filesByPath: Map<string, ScannedFile[]>
): FolderNode | null {
    const directFiles = filesByPath.get(dirPath) || [];

    // Find all subdirectories that have files
    const childPaths: string[] = [];
    for (const [filePath] of filesByPath) {
        if (filePath.startsWith(dirPath + path.sep) && filePath !== dirPath) {
            // Get immediate child directory
            const relativePath = filePath.slice(dirPath.length + 1);
            const firstPart = relativePath.split(path.sep)[0];
            const childPath = path.join(dirPath, firstPart);
            if (!childPaths.includes(childPath) && childPath !== dirPath) {
                childPaths.push(childPath);
            }
        }
    }

    // Build child nodes
    const children: FolderNode[] = [];
    for (const childPath of childPaths) {
        const childNode = buildFolderNodeRecursive(childPath, filesByPath);
        if (childNode && childNode.totalFileCount > 0) {
            children.push(childNode);
        }
    }

    // Calculate totals
    const totalFileCount = directFiles.length + children.reduce((sum, c) => sum + c.totalFileCount, 0);
    const totalSize = directFiles.reduce((sum, f) => sum + f.size, 0) +
        children.reduce((sum, c) => sum + c.totalSize, 0);

    // Find latest modified
    let latestModified = directFiles.length > 0
        ? directFiles.reduce((max, f) => f.modifiedAt > max ? f.modifiedAt : max, directFiles[0].modifiedAt)
        : '';
    for (const child of children) {
        if (child.latestModified > latestModified) {
            latestModified = child.latestModified;
        }
    }

    // Prune: don't return node if no files in subtree
    if (totalFileCount === 0) {
        return null;
    }

    return {
        path: dirPath,
        name: path.basename(dirPath) || dirPath,
        fileCount: directFiles.length,
        totalFileCount,
        totalSize,
        latestModified,
        children: children.sort((a, b) => b.latestModified.localeCompare(a.latestModified)),
        files: directFiles.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    };
}

export function registerScanHandlers(windowManager?: WindowManager) {
    // Get smart recommended directories
    ipcMain.handle('scan:get-recommended-directories', async () => {
        return getSmartRecommendedDirectories();
    });

    // Get system exclusions list
    ipcMain.handle('scan:get-exclusions', async () => {
        return {
            system: getSystemExclusions(),
            universal: UNIVERSAL_DIR_EXCLUSIONS,
        };
    });

    // Load saved settings
    ipcMain.handle('scan:get-settings', async () => {
        const settings = loadScanSettings();
        return settings || getDefaultScanSettings();
    });

    // Save settings
    ipcMain.handle('scan:save-settings', async (_event, settings: ScanSettings) => {
        saveScanSettings(settings);
        return { success: true };
    });

    // Pick directories dialog
    ipcMain.handle('scan:pick-directories', async (event) => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory', 'multiSelections'],
            title: 'Select folders to scan',
        });

        if (result.canceled || result.filePaths.length === 0) {
            return [];
        }

        return result.filePaths.map(p => ({
            path: p,
            label: path.basename(p),
            isDefault: false,
            selected: true,
        })) as ScanDirectory[];
    });

    // Build folder tree from already scanned files
    ipcMain.handle('scan:build-tree', async (_event, payload: {
        files: ScannedFile[];
        rootPaths: string[];
        filterKind?: FileKind
    }) => {
        return buildFolderTree(payload.files, payload.rootPaths, payload.filterKind);
    });

    // Start scan with streaming results
    ipcMain.on('scan:start', async (event, payload: ScanOptions) => {
        // Cancel any existing scan
        if (activeScanAbortController) {
            activeScanAbortController.abort();
        }

        activeScanAbortController = new AbortController();
        const abortController = activeScanAbortController;

        const daysBack = payload?.daysBack ?? null;
        const cutoffDate = daysBack ? new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000) : null;
        const dateFrom = payload?.dateFrom ? new Date(payload.dateFrom) : null;
        const dateTo = payload?.dateTo ? new Date(payload.dateTo) : null;
        const directories = payload?.directories || [];

        if (directories.length === 0) {
            event.sender.send('scan:error', 'No directories selected for scanning');
            return;
        }

        const ctx: ScanContext = {
            event,
            options: payload,
            cutoffDate,
            dateFrom,
            dateTo,
            systemExclusions: getSystemExclusions(),
            customExclusions: payload.customExclusions || [],
            scannedCount: 0,
            matchedCount: 0,
            skippedCount: 0,
            files: [],
            aborted: false,
            batchBuffer: [],
            lastBatchTime: Date.now(),
            lastProgressTime: Date.now(),
        };

        try {
            // Listen for abort
            abortController.signal.addEventListener('abort', () => {
                ctx.aborted = true;
            });

            // Start scanning
            sendProgress(ctx, 'scanning');

            // Scan each directory
            for (const dir of directories) {
                if (ctx.aborted) break;

                // Verify directory exists
                try {
                    const stat = await fs.promises.stat(dir);
                    if (!stat.isDirectory()) continue;
                } catch {
                    continue;
                }

                await scanDirectory(dir, ctx);
            }

            // Send any remaining buffered files
            if (ctx.batchBuffer.length > 0 && !event.sender.isDestroyed()) {
                event.sender.send('scan:files', ctx.batchBuffer);
            }

            // Build folder tree (still in scanning stage, this is quick)
            const folderTree = buildFolderTree(ctx.files, directories);

            // Send completion
            if (!event.sender.isDestroyed()) {
                const completeProgress: ScanProgress = {
                    status: ctx.aborted ? 'cancelled' : 'completed',
                    stage: ctx.aborted ? 'Scan cancelled' : 'Scan complete',
                    scannedCount: ctx.scannedCount,
                    matchedCount: ctx.matchedCount,
                    skippedCount: ctx.skippedCount,
                    completedAt: new Date().toISOString(),
                };
                event.sender.send('scan:progress', completeProgress);
                event.sender.send('scan:done', {
                    files: ctx.files,
                    folderTree,
                    partial: ctx.aborted,
                });
            }
        } catch (error) {
            console.error('Scan failed:', error);
            if (!event.sender.isDestroyed()) {
                const errorProgress: ScanProgress = {
                    status: 'error',
                    stage: 'Scan failed',
                    scannedCount: ctx.scannedCount,
                    matchedCount: ctx.matchedCount,
                    skippedCount: ctx.skippedCount,
                    error: error instanceof Error ? error.message : 'Scan failed',
                };
                event.sender.send('scan:progress', errorProgress);
                event.sender.send('scan:error', errorProgress.error);
            }
        } finally {
            if (activeScanAbortController === abortController) {
                activeScanAbortController = null;
            }
        }
    });

    // Cancel scan
    ipcMain.on('scan:cancel', () => {
        if (activeScanAbortController) {
            activeScanAbortController.abort();
            activeScanAbortController = null;
        }
    });
}
