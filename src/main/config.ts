import path from 'path';
import { app } from 'electron';
import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import pkgJson from '../../package.json';

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'prod';
const projectRoot = path.resolve(__dirname, '../..');
const runtimeRoot = isDev ? path.join(projectRoot, 'runtime') : process.resourcesPath;

const pkg = pkgJson as { name?: string; version?: string };
process.env.APP_NAME = pkg.name ?? '';
process.env.APP_VERSION = pkg.version ?? '';

/**
 * Load environment variables based on the current mode
 * This should be called as early as possible in the application lifecycle
 */
export function loadEnvConfig() {
    // Determine mode and config directory
    const mode = isDev ? 'dev' : 'prod';

    const configDir = path.join(projectRoot, 'config');

    console.log(`[Env] Loading environment for mode: ${mode}`);
    console.log(`[Env] Config directory: ${configDir}`);

    // Load .env configuration
    dotenvExpand.expand(dotenv.config({ path: path.join(configDir, `.env`) }));
    dotenvExpand.expand(dotenv.config({ path: path.join(configDir, `.env.${mode}`) }));
}

export const config = {
    isDev,
    projectRoot,
    get devServerUrl() { return process.env.VITE_DEV_SERVER_URL ?? ''; },
    get ports() {
        return {
            backend: parseInt(process.env.LOCAL_RAG_PORT ?? '8890'),
            vlm: 8007, // Keep hardcoded or add to env if needed, based on existing pattern only backend was varied mostly? Actually let's use env if available but keep defaults matching default.json
            embedding: 8005,
            reranker: 8006,
            whisper: 8080,
        };
    },
    get urls() {
        return {
            backend: process.env.LOCAL_RAG_API_URL ?? 'http://127.0.0.1:8890',
        };
    },
    paths: {
        llamaServer: path.join(runtimeRoot, 'llama-cpp', 'bin', `llama-server${process.platform === 'win32' ? '.exe' : ''}`),
        whisperServer: path.join(runtimeRoot, 'whisper-cpp', 'bin', `whisper-server${process.platform === 'win32' ? '.exe' : ''}`),
        backendScript: path.join(runtimeRoot, 'local_rag_dist', `run${process.platform === 'win32' ? '.ps1' : '.sh'}`),
        preload: path.join(__dirname, '../preload', isDev ? 'preload-dev.js' : 'preload.js'),
        dist: path.join(projectRoot, 'dist-electron', 'renderer'),
    },
    windows: {
        main: {
            width: 1280,
            height: 820,
            backgroundColor: '#0f172a',
        },
        spotlight: {
            width: 760,
            height: 520,
        },
        quickNote: {
            width: 480,
            height: 360,
            backgroundColor: '#1e293b',
        }
    },
    // Expose app info
    appInfo: {
        name: pkg.name,
        version: pkg.version
    }
};
