import { ipcMain } from 'electron';
import {
    getMemorySummary,
    getMemoryEpisodes,
    getMemoryEventLogs,
    getMemoryForesights
} from '../backendClient';

export function registerMemoryHandlers() {
    ipcMain.handle('memory:summary', async (_event, payload: { userId: string }) => {
        if (!payload?.userId) {
            throw new Error('Missing user id.');
        }
        return getMemorySummary(payload.userId);
    });

    ipcMain.handle('memory:episodes', async (_event, payload: { userId: string; limit?: number; offset?: number }) => {
        if (!payload?.userId) {
            throw new Error('Missing user id.');
        }
        return getMemoryEpisodes(payload.userId, payload.limit ?? 50, payload.offset ?? 0);
    });

    ipcMain.handle('memory:events', async (_event, payload: { userId: string; limit?: number; offset?: number }) => {
        if (!payload?.userId) {
            throw new Error('Missing user id.');
        }
        return getMemoryEventLogs(payload.userId, payload.limit ?? 100, payload.offset ?? 0);
    });

    ipcMain.handle('memory:foresights', async (_event, payload: { userId: string; limit?: number }) => {
        if (!payload?.userId) {
            throw new Error('Missing user id.');
        }
        return getMemoryForesights(payload.userId, payload.limit ?? 50);
    });
}
