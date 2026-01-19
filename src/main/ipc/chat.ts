import { ipcMain } from 'electron';
import {
    askWorkspace,
    askWorkspaceStream,
    listChatSessions,
    createChatSession,
    getChatSession,
    deleteChatSession,
    updateChatSession,
    addChatMessage
} from '../backendClient';

export function registerChatHandlers() {
    ipcMain.handle('qa:ask', async (_event, payload: { query: string; limit?: number; mode?: 'qa' | 'chat'; searchMode?: 'auto' | 'knowledge' | 'direct' }) => {
        if (!payload?.query) {
            throw new Error('Missing question text.');
        }
        return askWorkspace(payload.query, payload.limit, payload.mode, payload.searchMode);
    });

    ipcMain.on('qa:ask-stream', (event, payload: { query: string; limit?: number; mode?: 'qa' | 'chat'; searchMode?: 'auto' | 'knowledge' | 'direct'; resumeToken?: string }) => {
        if (!payload?.query) {
            event.sender.send('qa:stream-error', 'Missing question text.');
            return;
        }

        askWorkspaceStream(
            payload.query,
            payload.limit,
            payload.mode,
            (chunk) => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send('qa:stream-data', chunk);
                }
            },
            (error) => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send('qa:stream-error', error.message);
                }
            },
            () => {
                if (!event.sender.isDestroyed()) {
                    event.sender.send('qa:stream-done');
                }
            },
            payload.searchMode,
            payload.resumeToken
        ).catch((err) => {
            if (!event.sender.isDestroyed()) {
                event.sender.send('qa:stream-error', String(err));
            }
        });
    });

    ipcMain.handle('chat:list', async (_event, payload: { limit?: number; offset?: number }) => {
        return listChatSessions(payload?.limit, payload?.offset);
    });

    ipcMain.handle('chat:create', async (_event, payload: { title?: string }) => {
        return createChatSession(payload?.title);
    });

    ipcMain.handle('chat:get', async (_event, payload: { sessionId: string }) => {
        if (!payload?.sessionId) throw new Error('Missing session id');
        return getChatSession(payload.sessionId);
    });

    ipcMain.handle('chat:delete', async (_event, payload: { sessionId: string }) => {
        if (!payload?.sessionId) throw new Error('Missing session id');
        await deleteChatSession(payload.sessionId);
        return { id: payload.sessionId };
    });

    ipcMain.handle('chat:update', async (_event, payload: { sessionId: string; title: string }) => {
        if (!payload?.sessionId) throw new Error('Missing session id');
        return updateChatSession(payload.sessionId, payload.title);
    });

    ipcMain.handle('chat:add-message', async (_event, payload: { sessionId: string; message: any }) => {
        if (!payload?.sessionId) throw new Error('Missing session id');
        return addChatMessage(payload.sessionId, payload.message);
    });
}
