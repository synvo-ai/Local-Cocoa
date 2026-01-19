import { Moon, Sun, Monitor, Activity, Database, Cpu, Settings as SettingsIcon, CheckCircle2, Download, Box, RotateCcw, Check, AlertCircle, Shield, Trash2, Plus, Copy, HardDrive, Folder, Cloud, X, Settings2, ChevronRight, FileDown, Loader2, Bug } from 'lucide-react';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { CSSProperties, useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from './theme-provider';
import { useSkin, AVAILABLE_SKINS, type Skin } from './skin-provider';
import { useWorkspaceData } from '../hooks/useWorkspaceData';
import { useModelConfig } from '../hooks/useModelConfig';
import { useModelStatus } from '../hooks/useModelStatus';
import { cn } from '../lib/utils';
import type { ModelAssetStatus, ApiKey, ScanDirectory, ScanScope, ScanMode } from '../types';
import cocoaMascot from '../assets/cocoa-mascot.png';
import synvoLogo from '../../../assets/synvo_logo.png';

interface PythonSettings {
    rag_chunk_size: number;
    rag_chunk_overlap: number;
    search_result_limit: number;
    qa_context_limit: number;
    max_snippet_length: number;
    summary_max_tokens: number;
    pdf_one_chunk_per_page: boolean;
    embed_batch_size: number;
    embed_batch_delay_ms: number;
    vision_batch_delay_ms: number;
    default_indexing_mode: 'fast' | 'deep';
}

interface ModelGroup {
    id: string;
    label: string;
    assets: ModelAssetStatus[];
    ready: boolean;
}

function groupAssets(assets: ModelAssetStatus[]): ModelGroup[] {
    const groups: Record<string, ModelGroup> = {};

    assets.forEach(asset => {
        let groupId = 'other';
        let groupLabel = 'Other Assets';

        if (asset.id.includes('vlm') || asset.id.includes('mmproj')) {
            groupId = 'vlm';
            groupLabel = 'Vision Language Model (VLM)';
        } else if (asset.id.includes('embedding')) {
            groupId = 'embedding';
            groupLabel = 'Embedding Model';
        } else if (asset.id.includes('reranker') || asset.id.includes('bge')) {
            groupId = 'reranker';
            groupLabel = 'Reranker Model';
        } else if (asset.id.includes('whisper')) {
            groupId = 'audio';
            groupLabel = 'Audio Model (Speech Recognition)';
        }

        if (!groups[groupId]) {
            groups[groupId] = {
                id: groupId,
                label: groupLabel,
                assets: [],
                ready: true
            };
        }

        groups[groupId].assets.push(asset);
        if (!asset.exists) {
            groups[groupId].ready = false;
        }
    });

    Object.values(groups).forEach(group => {
        group.assets.sort((a, b) => a.label.localeCompare(b.label));
    });

    // Sort order: VLM first, then Embedding, then Reranker, then others
    const order = ['vlm', 'embedding', 'reranker', 'other'];
    return Object.values(groups).sort((a, b) => {
        const aIdx = order.indexOf(a.id);
        const bIdx = order.indexOf(b.id);
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    });
}

// API Reference Section with tabs
interface ApiEndpoint {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path: string;
    description: string;
    curl: (apiKey: string) => string;
}

const API_ENDPOINTS: Record<string, ApiEndpoint[]> = {
    'Query': [
        {
            method: 'POST',
            path: '/qa',
            description: 'Ask questions about your documents using RAG',
            curl: (key) => `curl -X POST "http://127.0.0.1:8890/qa" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${key}" \\
  -d '{"query": "What is in my documents?", "limit": 5}'`
        },
        {
            method: 'GET',
            path: '/search',
            description: 'Semantic search across all indexed files',
            curl: (key) => `curl "http://127.0.0.1:8890/search?q=meeting%20notes&limit=10" \\
  -H "X-API-Key: ${key}"`
        },
    ],
    'Files': [
        {
            method: 'GET',
            path: '/files',
            description: 'List all indexed files with pagination',
            curl: (key) => `curl "http://127.0.0.1:8890/files?limit=50&offset=0" \\
  -H "X-API-Key: ${key}"`
        },
        {
            method: 'GET',
            path: '/files/{id}',
            description: 'Get details of a specific file',
            curl: (key) => `curl "http://127.0.0.1:8890/files/{file_id}" \\
  -H "X-API-Key: ${key}"`
        },
        {
            method: 'GET',
            path: '/files/{id}/chunks',
            description: 'Get text chunks of a file',
            curl: (key) => `curl "http://127.0.0.1:8890/files/{file_id}/chunks" \\
  -H "X-API-Key: ${key}"`
        },
    ],
    'Folders': [
        {
            method: 'GET',
            path: '/folders',
            description: 'List all monitored folders',
            curl: (key) => `curl "http://127.0.0.1:8890/folders" \\
  -H "X-API-Key: ${key}"`
        },
        {
            method: 'GET',
            path: '/folders/{id}',
            description: 'Get details of a specific folder',
            curl: (key) => `curl "http://127.0.0.1:8890/folders/{folder_id}" \\
  -H "X-API-Key: ${key}"`
        },
    ],
    'System': [
        {
            method: 'GET',
            path: '/health',
            description: 'Check if the service is running',
            curl: (key) => `curl "http://127.0.0.1:8890/health" \\
  -H "X-API-Key: ${key}"`
        },
        {
            method: 'GET',
            path: '/index/summary',
            description: 'Get indexing statistics',
            curl: (key) => `curl "http://127.0.0.1:8890/index/summary" \\
  -H "X-API-Key: ${key}"`
        },
        {
            method: 'GET',
            path: '/index/status',
            description: 'Get current indexing status',
            curl: (key) => `curl "http://127.0.0.1:8890/index/status" \\
  -H "X-API-Key: ${key}"`
        },
    ],
};

// API Key Item with copy and reveal functionality
function ApiKeyItem({ apiKey, localKey, onDelete }: { apiKey: ApiKey; localKey: string | null; onDelete: () => void }) {
    const [showKey, setShowKey] = useState(false);
    const [copied, setCopied] = useState(false);

    const copyKey = () => {
        navigator.clipboard.writeText(apiKey.key);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30 group">
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{apiKey.name}</span>
                    {apiKey.is_system && (
                        <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">System</span>
                    )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                    Created: {new Date(apiKey.created_at).toLocaleDateString()}
                    {apiKey.last_used_at && ` • Last used: ${new Date(apiKey.last_used_at).toLocaleDateString()}`}
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                    <code className="text-xs font-mono bg-background/50 px-2 py-1 rounded border text-muted-foreground select-all">
                        {showKey ? apiKey.key : `${apiKey.key.substring(0, 10)}${'•'.repeat(20)}`}
                    </code>
                    <button
                        onClick={() => setShowKey(!showKey)}
                        className="p-1 hover:bg-background rounded text-muted-foreground hover:text-foreground transition-colors"
                        title={showKey ? "Hide" : "Show"}
                        type="button"
                    >
                        {showKey ? (
                            <X className="h-3.5 w-3.5" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                        )}
                    </button>
                    <button
                        onClick={copyKey}
                        className={cn(
                            "p-1 rounded transition-colors",
                            copied 
                                ? "text-green-500" 
                                : "hover:bg-background text-muted-foreground hover:text-foreground"
                        )}
                        title={copied ? "Copied!" : "Copy"}
                        type="button"
                    >
                        {copied ? (
                            <Check className="h-3.5 w-3.5" />
                        ) : (
                            <Copy className="h-3.5 w-3.5" />
                        )}
                    </button>
                </div>
            </div>
            {!apiKey.is_system && apiKey.key !== localKey && (
                <button
                    onClick={onDelete}
                    className="p-2 hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded-md transition-colors ml-2"
                    title="Delete Key"
                    type="button"
                >
                    <Trash2 className="h-4 w-4" />
                </button>
            )}
        </div>
    );
}

function ApiReferenceSection({ apiKey }: { apiKey: string }) {
    const [activeCategory, setActiveCategory] = useState<string>('Query');
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
    const categories = Object.keys(API_ENDPOINTS);
    const endpoints = API_ENDPOINTS[activeCategory] || [];

    const copyToClipboard = (text: string, index: number) => {
        navigator.clipboard.writeText(text.replace(/\\\n\s*/g, ' '));
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 2000);
    };

    const getMethodColor = (method: string) => {
        switch (method) {
            case 'GET': return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
            case 'POST': return 'bg-green-500/15 text-green-600 dark:text-green-400';
            case 'PUT': return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
            case 'DELETE': return 'bg-red-500/15 text-red-600 dark:text-red-400';
            case 'PATCH': return 'bg-purple-500/15 text-purple-600 dark:text-purple-400';
            default: return 'bg-gray-500/15 text-gray-600 dark:text-gray-400';
        }
    };

    return (
        <div className="space-y-4">
            <h3 className="text-sm font-medium">API Reference</h3>
            <div className="rounded-lg border bg-card overflow-hidden">
                {/* Category Tabs */}
                <div className="flex border-b bg-muted/30">
                    {categories.map((cat) => (
                        <button
                            key={cat}
                            onClick={() => setActiveCategory(cat)}
                            className={cn(
                                "px-4 py-2 text-xs font-medium transition-colors relative",
                                activeCategory === cat
                                    ? "text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {cat}
                            {activeCategory === cat && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                            )}
                        </button>
                    ))}
                </div>

                {/* Endpoints List */}
                <div className="divide-y">
                    {endpoints.map((endpoint, index) => (
                        <div key={index} className="p-4 space-y-3">
                            <div className="flex items-center gap-3">
                                <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded", getMethodColor(endpoint.method))}>
                                    {endpoint.method}
                                </span>
                                <code className="text-xs font-mono font-medium">{endpoint.path}</code>
                                <span className="text-xs text-muted-foreground">—</span>
                                <span className="text-xs text-muted-foreground">{endpoint.description}</span>
                            </div>
                            <div className="relative group">
                                <pre className="text-[11px] bg-muted/50 p-3 rounded-md overflow-x-auto font-mono text-muted-foreground leading-relaxed">
                                    {endpoint.curl(apiKey)}
                                </pre>
                                <button
                                    onClick={() => copyToClipboard(endpoint.curl(apiKey), index)}
                                    className={cn(
                                        "absolute top-2 right-2 p-1.5 rounded transition-all",
                                        "opacity-0 group-hover:opacity-100",
                                        "hover:bg-background border border-transparent hover:border-border",
                                        copiedIndex === index && "opacity-100"
                                    )}
                                    title={copiedIndex === index ? "Copied!" : "Copy"}
                                    type="button"
                                >
                                    {copiedIndex === index ? (
                                        <Check className="h-3.5 w-3.5 text-green-500" />
                                    ) : (
                                        <Copy className="h-3.5 w-3.5" />
                                    )}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Footer hint */}
                <div className="px-4 py-3 bg-muted/30 border-t">
                    <p className="text-[11px] text-muted-foreground">
                        All endpoints require the <code className="bg-muted px-1 py-0.5 rounded text-[10px]">X-API-Key</code> header for authentication.
                    </p>
                </div>
            </div>
        </div>
    );
}

interface SettingsPanelProps {
    initialTab?: 'general' | 'models' | 'retrieval' | 'security' | 'scan';
}

export function SettingsPanel({ initialTab = 'general' }: SettingsPanelProps) {
    const { t } = useTranslation();
    const { theme, setTheme } = useTheme();
    const { skin, setSkin } = useSkin();
    const { health, systemSpecs } = useWorkspaceData();
    const { config, loading: configLoading, updateConfig } = useModelConfig();
    const { modelStatus, handleManualModelDownload, handleRedownloadModel, modelDownloadEvent } = useModelStatus();
    const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
    const MANUAL_KEY_STORAGE = 'local_rag_api_key_override';

    const [activeTab, setActiveTab] = useState<'general' | 'models' | 'retrieval' | 'security' | 'scan'>(initialTab);
    const [pythonSettings, setPythonSettings] = useState<PythonSettings | null>(null);

    // Listen for tab switch requests (e.g., from Scan page)
    useEffect(() => {
        const handleTabSwitch = (event: Event) => {
            const detail = (event as CustomEvent).detail as { tab?: 'general' | 'models' | 'retrieval' | 'security' | 'scan' } | undefined;
            if (detail?.tab) {
                setActiveTab(detail.tab);
            }
        };
        window.addEventListener('synvo:settings-tab', handleTabSwitch as EventListener);
        return () => {
            window.removeEventListener('synvo:settings-tab', handleTabSwitch as EventListener);
        };
    }, []);
    const [showSaveSuccess, setShowSaveSuccess] = useState(false);
    const [localKey, setLocalKey] = useState<string | null>(null);
    const [manualApiKey, setManualApiKey] = useState('');
    const [manualKeyApplied, setManualKeyApplied] = useState(false);
    const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
    const [newKeyName, setNewKeyName] = useState('');
    const [createdKey, setCreatedKey] = useState<ApiKey | null>(null);

    // Scan settings state
    const [recommendedDirs, setRecommendedDirs] = useState<ScanDirectory[]>([]);
    const [scanScope, setScanScope] = useState<ScanScope>({
        mode: 'smart',
        directories: [],
        useRecommendedExclusions: true,
        customExclusions: [],
    });
    const [showExclusions, setShowExclusions] = useState(false);

    // Export logs state
    const [isExportingLogs, setIsExportingLogs] = useState(false);
    const [exportLogsResult, setExportLogsResult] = useState<{ success: boolean; message: string } | null>(null);

    const isDownloading = modelDownloadEvent?.state === 'downloading';
    const modelGroups = useMemo(() => modelStatus?.assets ? groupAssets(modelStatus.assets) : [], [modelStatus]);

    // --- Python Settings Logic ---
    const loadPythonSettings = useCallback((key: string) => {
        fetch('http://127.0.0.1:8890/settings', { headers: { 'X-API-Key': key } })
            .then(res => res.json())
            .then(data => setPythonSettings(data))
            .catch(err => console.error('Failed to load settings:', err));

        fetch('http://127.0.0.1:8890/security/keys', { headers: { 'X-API-Key': key } })
            .then(res => res.json())
            .then(data => setApiKeys(data))
            .catch(err => console.error('Failed to load keys:', err));
    }, []);

    useEffect(() => {
        const storedKey = localStorage.getItem(MANUAL_KEY_STORAGE)?.trim();
        if (storedKey) {
            setManualApiKey(storedKey);
            window.api.setLocalKeyOverride(storedKey).then(() => {
                setLocalKey(storedKey);
                loadPythonSettings(storedKey);
                setManualKeyApplied(true);
            });
            return;
        }

        window.api.getLocalKey().then(key => {
            setLocalKey(key);
            if (key) {
                loadPythonSettings(key);
            }
        });
    }, [loadPythonSettings]);

    const applyManualKey = useCallback(async () => {
        const trimmed = manualApiKey.trim();
        if (!trimmed) return;
        localStorage.setItem(MANUAL_KEY_STORAGE, trimmed);
        await window.api.setLocalKeyOverride(trimmed);
        setLocalKey(trimmed);
        loadPythonSettings(trimmed);
        setManualKeyApplied(true);
    }, [manualApiKey, loadPythonSettings]);

    const clearManualKey = useCallback(async () => {
        localStorage.removeItem(MANUAL_KEY_STORAGE);
        setManualApiKey('');
        await window.api.setLocalKeyOverride(null);
        const key = await window.api.getLocalKey();
        setLocalKey(key);
        if (key) {
            loadPythonSettings(key);
        }
        setManualKeyApplied(false);
    }, [loadPythonSettings]);

    // --- Scan Settings Logic ---
    useEffect(() => {
        const loadScanSettings = async () => {
            const api = window.api;
            if (!api) return;

            try {
                const dirs = await api.getRecommendedDirectories?.();
                if (dirs) {
                    setRecommendedDirs(dirs);
                }

                const settings = await api.getScanSettings?.();
                if (settings?.scope) {
                    setScanScope(settings.scope);
                } else if (dirs) {
                    setScanScope({
                        mode: 'smart',
                        directories: dirs.filter(d => d.isDefault),
                        useRecommendedExclusions: true,
                        customExclusions: [],
                    });
                }
            } catch (error) {
                console.error('Failed to load scan settings:', error);
            }
        };

        loadScanSettings();
    }, []);

    const saveScanScope = useCallback(async (newScope: ScanScope) => {
        setScanScope(newScope);
        const api = window.api;
        if (api?.saveScanSettings) {
            try {
                await api.saveScanSettings({ scope: newScope });
            } catch (error) {
                console.error('Failed to save scan settings:', error);
            }
        }
    }, []);

    const toggleScanDirectory = useCallback((dirPath: string) => {
        const existing = scanScope.directories.find(d => d.path === dirPath);
        if (existing) {
            saveScanScope({
                ...scanScope,
                directories: scanScope.directories.filter(d => d.path !== dirPath),
            });
        } else {
            const recommended = recommendedDirs.find(d => d.path === dirPath);
            if (recommended) {
                saveScanScope({
                    ...scanScope,
                    directories: [...scanScope.directories, { ...recommended, selected: true }],
                });
            }
        }
    }, [scanScope, recommendedDirs, saveScanScope]);

    const pickScanDirectories = useCallback(async () => {
        const api = window.api;
        if (!api?.pickScanDirectories) return;

        try {
            const dirs = await api.pickScanDirectories();
            if (dirs && dirs.length > 0) {
                saveScanScope({
                    ...scanScope,
                    directories: [...scanScope.directories, ...dirs],
                });
            }
        } catch (error) {
            console.error('Failed to pick directories:', error);
        }
    }, [scanScope, saveScanScope]);

    const setScanMode = useCallback((mode: ScanMode) => {
        if (mode === 'smart') {
            const defaultDirs = recommendedDirs.filter(d => d.isDefault);
            saveScanScope({
                ...scanScope,
                mode,
                directories: defaultDirs,
            });
        } else {
            saveScanScope({ ...scanScope, mode });
        }
    }, [scanScope, recommendedDirs, saveScanScope]);

    // Export logs handler
    const handleExportLogs = useCallback(async () => {
        setIsExportingLogs(true);
        setExportLogsResult(null);

        try {
            const result = await window.api.exportLogs();
            if (result.exported) {
                setExportLogsResult({
                    success: true,
                    message: 'Logs exported successfully!'
                });
            } else if (result.error) {
                setExportLogsResult({
                    success: false,
                    message: result.error
                });
            } else {
                setExportLogsResult({
                    success: false,
                    message: 'Export cancelled'
                });
            }
        } catch (error) {
            console.error('Failed to export logs:', error);
            setExportLogsResult({
                success: false,
                message: error instanceof Error ? error.message : 'Failed to export logs'
            });
        } finally {
            setIsExportingLogs(false);
            // Clear result after 5 seconds
            setTimeout(() => setExportLogsResult(null), 5000);
        }
    }, []);

    const updatePythonSetting = (key: keyof PythonSettings, value: any) => {
        if (!pythonSettings || !localKey) return;
        const newSettings = { ...pythonSettings, [key]: value };

        // Auto-calculate overlap if chunk size changes
        if (key === 'rag_chunk_size') {
            newSettings.rag_chunk_overlap = Math.floor(value / 5);
        }

        setPythonSettings(newSettings);

        fetch('http://127.0.0.1:8890/settings', {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': localKey
            },
            body: JSON.stringify({ [key]: value, ...(key === 'rag_chunk_size' ? { rag_chunk_overlap: newSettings.rag_chunk_overlap } : {}) })
        })
            .then(() => {
                setShowSaveSuccess(true);
                setTimeout(() => setShowSaveSuccess(false), 2000);
            })
            .catch(err => console.error('Failed to save settings:', err));
    };

    const createApiKey = () => {
        if (!localKey || !newKeyName.trim()) return;
        fetch(`http://127.0.0.1:8890/security/keys?name=${encodeURIComponent(newKeyName)}`, {
            method: 'POST',
            headers: { 'X-API-Key': localKey }
        })
            .then(res => res.json())
            .then(data => {
                setCreatedKey(data);
                setNewKeyName('');
                // Refresh keys
                fetch('http://127.0.0.1:8890/security/keys', { headers: { 'X-API-Key': localKey } })
                    .then(res => res.json())
                    .then(data => setApiKeys(data));
            })
            .catch(err => console.error('Failed to create key:', err));
    };

    const deleteApiKey = (key: string) => {
        if (!localKey) return;
        fetch(`http://127.0.0.1:8890/security/keys/${key}`, {
            method: 'DELETE',
            headers: { 'X-API-Key': localKey }
        })
            .then(() => {
                fetch('http://127.0.0.1:8890/security/keys', { headers: { 'X-API-Key': localKey } })
                    .then(res => res.json())
                    .then(data => setApiKeys(data));
            })
            .catch(err => console.error('Failed to delete key:', err));
    };

    // --- Model Settings Logic ---
    const GB = 1024 * 1024 * 1024;
    const totalMemory = systemSpecs?.totalMemory ?? 0;
    let maxAllowedContext = 32768;
    if (totalMemory > 0) {
        if (totalMemory < 22 * GB) maxAllowedContext = 8192;
        else if (totalMemory < 30 * GB) maxAllowedContext = 16384;
    }

    const allowedContextSizes = useMemo(() => [2048, 4096, 8192, 16384, 32768].filter(v => v <= maxAllowedContext), [maxAllowedContext]);
    const visionOptions = useMemo(() => [
        { value: 200704, label: 'Low (448×448)' },
        { value: 501760, label: 'Medium (700×700)' },
        { value: 1003520, label: 'High (1280×720)' },
        { value: 2073600, label: 'Ultra (1920×1080)' }
    ], []);

    const videoOptions = useMemo(() => [
        { value: 102400, label: 'Low (320×320)' },
        { value: 230400, label: 'Medium (480×480)' },
        { value: 307200, label: 'High (640×480)' },
        { value: 501760, label: 'Ultra (700×700)' }
    ], []);

    const handleContextSizeChange = (newSize: number) => {
        let recommendedPixels = 1003520;
        if (newSize <= 2048) recommendedPixels = 200704;
        else if (newSize <= 4096) recommendedPixels = 501760;
        else recommendedPixels = 1003520;

        updateConfig({ contextSize: newSize, visionMaxPixels: recommendedPixels });
    };

    const vlmModels = useMemo(() => {
        if (!modelStatus?.assets) return [];
        // Exclude mmproj - it's a helper component, not a standalone model
        return modelStatus.assets.filter(a =>
            (a.id.includes('vlm') || a.id.includes('llm')) && !a.id.includes('mmproj')
        );
    }, [modelStatus]);

    // Get available embedding models (those that exist)
    const embeddingModels = useMemo(() => {
        if (!modelStatus?.assets) return [];
        return modelStatus.assets.filter(a => a.id.includes('embedding') && a.exists);
    }, [modelStatus]);
    const currentEmbeddingModelId = config?.activeEmbeddingModelId || 'embedding-q4';

    // Get available reranker models (those that exist)
    const rerankerModels = useMemo(() => {
        if (!modelStatus?.assets) return [];
        return modelStatus.assets.filter(a =>
            (a.id.includes('reranker') || a.id.includes('bge')) && a.exists
        );
    }, [modelStatus]);
    const currentRerankerModelId = config?.activeRerankerModelId || 'reranker';

    // Get available audio models (whisper models that exist)
    const audioModels = useMemo(() => {
        if (!modelStatus?.assets) return [];
        return modelStatus.assets.filter(a => a.id.includes('whisper') && a.exists);
    }, [modelStatus]);
    const currentAudioModelId = config?.activeAudioModelId || 'whisper-small';

    return (
        <div className="flex h-full flex-col bg-background">
            {/* Header Region - Draggable */}
            <div className="flex-none border-b px-6 pt-8 pb-0" style={dragStyle}>
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-lg font-semibold tracking-tight">{t('settings.title')}</h2>
                        <p className="text-xs text-muted-foreground">{t('settings.subtitle')}</p>
                    </div>
                </div>

                {/* Tabs - Non-draggable */}
                <div className="flex items-center gap-6" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
                    <button
                        onClick={() => setActiveTab('general')}
                        className={cn("flex items-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors", activeTab === 'general' ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
                    >
                        <SettingsIcon className="h-4 w-4" /> {t('settings.general')}
                    </button>
                    <button
                        onClick={() => setActiveTab('models')}
                        className={cn("flex items-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors", activeTab === 'models' ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
                    >
                        <Cpu className="h-4 w-4" /> {t('settings.models')}
                    </button>
                    <button
                        onClick={() => setActiveTab('retrieval')}
                        className={cn("flex items-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors", activeTab === 'retrieval' ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
                    >
                        <Database className="h-4 w-4" /> {t('settings.retrievalIndexing')}
                    </button>
                    <button
                        onClick={() => setActiveTab('security')}
                        className={cn("flex items-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors", activeTab === 'security' ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
                    >
                        <Shield className="h-4 w-4" /> {t('settings.security')}
                    </button>
                    <button
                        onClick={() => setActiveTab('scan')}
                        className={cn("flex items-center gap-2 py-3 text-sm font-medium border-b-2 transition-colors", activeTab === 'scan' ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
                    >
                        <HardDrive className="h-4 w-4" /> {t('settings.scanScope')}
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-4xl mx-auto space-y-8 pb-10">
                    {activeTab === 'general' && (
                        <>
                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">{t('settings.systemHealth')}</h3>
                                <div className="rounded-lg border bg-card p-4 space-y-3">
                                    {health?.services?.map((service) => (
                                        <div key={service.name} className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <Activity className="h-4 w-4 text-muted-foreground" />
                                                <span className="text-sm font-medium">{service.name}</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className={cn('h-2 w-2 rounded-full', service.status === 'online' ? 'bg-emerald-500' : 'bg-red-500')} />
                                                <span className="text-xs text-muted-foreground">
                                                    {service.status === 'online' ? `${Math.round(service.latencyMs || 0)}ms` : service.details || 'Offline'}
                                                </span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">{t('settings.appearance')}</h3>
                                <div className="grid grid-cols-3 gap-4 max-w-md">
                                    {(['light', 'dark', 'system'] as const).map((themeOption) => (
                                        <button
                                            key={themeOption}
                                            onClick={() => setTheme(themeOption)}
                                            className={cn(
                                                "flex flex-col items-center justify-center gap-2 rounded-lg border p-4 transition-all hover:bg-accent",
                                                theme === themeOption ? "border-primary bg-primary/5" : "bg-card"
                                            )}
                                        >
                                            {themeOption === 'light' ? <Sun className="h-6 w-6" /> : themeOption === 'dark' ? <Moon className="h-6 w-6" /> : <Monitor className="h-6 w-6" />}
                                            <span className="text-xs font-medium">{t(`settings.${themeOption}`)}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">{t('settings.language')}</h3>
                                <p className="text-xs text-muted-foreground">{t('settings.languageDescription')}</p>
                                <div className="max-w-2xl">
                                    <LanguageSwitcher />
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">{t('settings.skin')}</h3>
                                <p className="text-xs text-muted-foreground">{t('settings.skinDescription')}</p>
                                <div className="grid grid-cols-2 gap-4 max-w-md">
                                    {AVAILABLE_SKINS.map((s) => (
                                        <button
                                            key={s.id}
                                            onClick={() => setSkin(s.id)}
                                            className={cn(
                                                "relative flex flex-col items-center justify-center gap-3 rounded-xl border p-5 transition-all hover:shadow-md",
                                                skin === s.id
                                                    ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                                                    : "bg-card hover:bg-accent/50"
                                            )}
                                        >
                                            {/* Skin Preview Icon */}
                                            <div className={cn(
                                                "flex h-12 w-12 items-center justify-center rounded-lg",
                                                s.id === 'minimalist'
                                                    ? "bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-800"
                                                    : "bg-gradient-to-br from-amber-100 via-orange-100 to-amber-200 dark:from-amber-900/50 dark:via-orange-900/40 dark:to-amber-800/50"
                                            )}>
                                                {s.id === 'minimalist' ? (
                                                    <img src={synvoLogo} alt="Synvo AI" className="h-7 w-7 object-contain" />
                                                ) : (
                                                    <img src={cocoaMascot} alt="Local Cocoa" className="h-8 w-8 object-contain" />
                                                )}
                                            </div>
                                            <div className="text-center">
                                                <span className="text-sm font-medium">{s.name}</span>
                                                <p className="text-[10px] text-muted-foreground mt-0.5">{s.description}</p>
                                            </div>
                                            {/* Selected indicator */}
                                            {skin === s.id && (
                                                <div className="absolute top-2 right-2">
                                                    <Check className="h-4 w-4 text-primary" />
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Diagnostics & Support Section */}
                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">Diagnostics & Support</h3>
                                <div className="rounded-lg border bg-card p-4 space-y-4">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2">
                                                <FileDown className="h-4 w-4 text-muted-foreground" />
                                                <span className="text-sm font-medium">Export Logs</span>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                Export application logs for troubleshooting. Share these with support when reporting issues.
                                            </p>
                                        </div>
                                        <button
                                            onClick={handleExportLogs}
                                            disabled={isExportingLogs}
                                            className={cn(
                                                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                                                "bg-primary text-primary-foreground hover:bg-primary/90",
                                                "disabled:opacity-50 disabled:cursor-not-allowed"
                                            )}
                                        >
                                            {isExportingLogs ? (
                                                <>
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    Exporting...
                                                </>
                                            ) : (
                                                <>
                                                    <Download className="h-4 w-4" />
                                                    Export Logs
                                                </>
                                            )}
                                        </button>
                                    </div>

                                    {exportLogsResult && (
                                        <div className={cn(
                                            "flex items-center gap-2 px-3 py-2 rounded-lg text-sm",
                                            exportLogsResult.success
                                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                                : "bg-red-500/10 text-red-600 dark:text-red-400"
                                        )}>
                                            {exportLogsResult.success ? (
                                                <CheckCircle2 className="h-4 w-4" />
                                            ) : (
                                                <AlertCircle className="h-4 w-4" />
                                            )}
                                            {exportLogsResult.message}
                                        </div>
                                    )}

                                    <div className="pt-2 border-t">
                                        <p className="text-xs text-muted-foreground">
                                            <span className="font-medium">Version:</span> {window.env?.APP_VERSION || 'unknown'}
                                        </p>
                                    </div>

                                    {/* Debug Mode Toggle */}
                                    <div className="pt-3 border-t">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <Bug className="h-4 w-4 text-muted-foreground" />
                                                <div>
                                                    <span className="text-sm font-medium">Debug Mode</span>
                                                    <p className="text-xs text-muted-foreground">
                                                        Write detailed logs to ~/local-cocoa-debug.log
                                                    </p>
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => updateConfig({ debugMode: !config?.debugMode })}
                                                className={cn(
                                                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                                                    config?.debugMode ? "bg-primary" : "bg-muted"
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                                                        config?.debugMode ? "translate-x-6" : "translate-x-1"
                                                    )}
                                                />
                                            </button>
                                        </div>
                                        {config?.debugMode && (
                                            <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                                                ⚠️ Debug mode is enabled. Logs will be saved to your home folder. Restart the app to apply changes.
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}

                    {activeTab === 'models' && config && (
                        <div className="space-y-6">
                            <div className="rounded-lg border bg-card p-4 space-y-6">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">API Key Override</label>
                                    <p className="text-xs text-muted-foreground">
                                        Use this when the backend is started outside the app. Requests will use this key.
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="text"
                                            value={manualApiKey}
                                            onChange={(e) => setManualApiKey(e.target.value)}
                                            placeholder="sk-session-..."
                                            className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                                        />
                                        <button
                                            onClick={applyManualKey}
                                            disabled={!manualApiKey.trim()}
                                            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Check className="h-3.5 w-3.5" />
                                            Apply
                                        </button>
                                        <button
                                            onClick={clearManualKey}
                                            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            Clear
                                        </button>
                                    </div>
                                    {manualKeyApplied && (
                                        <p className="text-xs text-emerald-600 dark:text-emerald-400">
                                            Manual key applied for this session.
                                        </p>
                                    )}
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Active Multimodal Model</label>
                                    <select
                                        value={config.activeModelId}
                                        onChange={(e) => updateConfig({ activeModelId: e.target.value })}
                                        disabled={configLoading}
                                        className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    >
                                        {vlmModels.map((model) => (
                                            <option key={model.id} value={model.id}>
                                                {model.label} {model.exists ? '(Ready)' : '(Missing)'}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {embeddingModels.length > 1 && (
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">Active Embedding Model</label>
                                        <select
                                            value={currentEmbeddingModelId}
                                            onChange={(e) => updateConfig({ activeEmbeddingModelId: e.target.value })}
                                            disabled={configLoading}
                                            className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        >
                                            {embeddingModels.map((model) => (
                                                <option key={model.id} value={model.id}>
                                                    {model.label} ({(model.sizeBytes! / 1024 / 1024).toFixed(0)} MB)
                                                </option>
                                            ))}
                                        </select>
                                        <p className="text-xs text-muted-foreground">
                                            Changing this will restart the embedding service.
                                        </p>
                                    </div>
                                )}

                                {rerankerModels.length > 1 && (
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">Active Reranker Model</label>
                                        <select
                                            value={currentRerankerModelId}
                                            onChange={(e) => updateConfig({ activeRerankerModelId: e.target.value })}
                                            disabled={configLoading}
                                            className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        >
                                            {rerankerModels.map((model) => (
                                                <option key={model.id} value={model.id}>
                                                    {model.label} ({(model.sizeBytes! / 1024 / 1024).toFixed(0)} MB)
                                                </option>
                                            ))}
                                        </select>
                                        <p className="text-xs text-muted-foreground">
                                            Changing this will restart the reranker service.
                                        </p>
                                    </div>
                                )}

                                {audioModels.length > 0 && (
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">Active Audio Model (Speech Recognition)</label>
                                        <select
                                            value={currentAudioModelId}
                                            onChange={(e) => updateConfig({ activeAudioModelId: e.target.value })}
                                            disabled={configLoading}
                                            className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        >
                                            {audioModels.map((model) => (
                                                <option key={model.id} value={model.id}>
                                                    {model.label} ({(model.sizeBytes! / 1024 / 1024).toFixed(0)} MB)
                                                </option>
                                            ))}
                                        </select>
                                        <p className="text-xs text-muted-foreground">
                                            Whisper model for Earlog transcription. Larger models are more accurate but slower.
                                        </p>
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium">Context Size</label>
                                        <span className="text-xs font-mono text-muted-foreground">{config.contextSize} tokens</span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={allowedContextSizes.length - 1}
                                        step={1}
                                        value={allowedContextSizes.indexOf(config.contextSize)}
                                        onChange={(e) => handleContextSizeChange(allowedContextSizes[Number(e.target.value)])}
                                        className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                                    />
                                    <div className="flex justify-between text-xs text-muted-foreground">
                                        <span>{allowedContextSizes[0]}</span>
                                        <span>{allowedContextSizes[allowedContextSizes.length - 1]}</span>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium">Vision Resolution</label>
                                        <span className="text-xs text-muted-foreground">
                                            {visionOptions.find(o => o.value === config.visionMaxPixels)?.label ?? 'Custom'}
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={visionOptions.length - 1}
                                        step={1}
                                        value={visionOptions.findIndex(o => o.value === config.visionMaxPixels)}
                                        onChange={(e) => updateConfig({ visionMaxPixels: visionOptions[Number(e.target.value)].value })}
                                        className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium">Video Resolution</label>
                                        <span className="text-xs text-muted-foreground">
                                            {videoOptions.find(o => o.value === config.videoMaxPixels)?.label ?? 'Custom'}
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={videoOptions.length - 1}
                                        step={1}
                                        value={videoOptions.findIndex(o => o.value === config.videoMaxPixels)}
                                        onChange={(e) => updateConfig({ videoMaxPixels: videoOptions[Number(e.target.value)].value })}
                                        className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                                    />
                                    <p className="text-xs text-muted-foreground">Lower resolution for faster video processing</p>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-sm font-medium">Model Assets</h3>
                                    <button
                                        onClick={() => handleManualModelDownload()}
                                        disabled={isDownloading}
                                        className={cn(
                                            "inline-flex items-center justify-center rounded-md text-xs font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
                                            "bg-primary text-primary-foreground hover:bg-primary/90 h-8 px-3",
                                            !modelStatus?.ready && !isDownloading && "animate-pulse ring-2 ring-primary ring-offset-2"
                                        )}
                                    >
                                        {isDownloading ? (
                                            <>
                                                <div className="mr-2 h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                                Downloading...
                                            </>
                                        ) : (
                                            <>
                                                <Download className="mr-2 h-3 w-3" />
                                                Check & Download
                                            </>
                                        )}
                                    </button>
                                </div>

                                <div className="rounded-lg border bg-card p-4 space-y-6">
                                    {modelGroups.map((group) => (
                                        <div key={group.id} className="space-y-3">
                                            <div className="flex items-center gap-2 pb-2 border-b">
                                                <Box className="h-4 w-4 text-muted-foreground" />
                                                <h3 className="text-sm font-medium">{group.label}</h3>
                                                <div className={cn(
                                                    "ml-auto text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full",
                                                    group.ready ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"
                                                )}>
                                                    {group.ready ? "Ready" : "Incomplete"}
                                                </div>
                                            </div>
                                            <div className="grid gap-3">
                                                {group.assets.map((asset) => {
                                                    const isDownloadingThis = isDownloading && modelDownloadEvent?.assetId === asset.id;
                                                    const disableRedownload = isDownloading && !isDownloadingThis;
                                                    return (
                                                        <div key={asset.id} className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 transition-colors hover:bg-muted/50">
                                                            <div className="flex items-center justify-between w-full">
                                                                <div className="flex items-start gap-3">
                                                                    <div className={cn("mt-1.5 h-2 w-2 rounded-full shrink-0", asset.exists ? "bg-emerald-500" : "bg-amber-500")} />
                                                                    <div className="min-w-0">
                                                                        <p className="text-sm font-medium leading-none truncate">{asset.label}</p>
                                                                        <p className="mt-1 text-xs text-muted-foreground font-mono truncate max-w-[300px]" title={asset.path}>
                                                                            {asset.path.split('/').pop()}
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="flex items-center gap-4 shrink-0">
                                                                    {asset.sizeBytes && (
                                                                        <span className="text-xs text-muted-foreground font-mono">{(asset.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                                                                    )}
                                                                    {asset.exists ? <Check className="h-4 w-4 text-emerald-500" /> : <AlertCircle className="h-4 w-4 text-amber-500" />}
                                                                </div>
                                                            </div>
                                                            {asset.exists && (
                                                                <div className="flex items-center justify-end">
                                                                    <button
                                                                        onClick={() => handleRedownloadModel(asset.id)}
                                                                        disabled={disableRedownload}
                                                                        className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                                                                        title="Remove the current file and download a fresh copy"
                                                                    >
                                                                        {isDownloadingThis ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <RotateCcw className="h-3.5 w-3.5" />}
                                                                        Force Redownload
                                                                    </button>
                                                                </div>
                                                            )}
                                                            {isDownloadingThis && (
                                                                <div className="w-full">
                                                                    <div className="flex items-center justify-between mb-1.5">
                                                                        <span className="text-xs text-muted-foreground">{modelDownloadEvent.message}</span>
                                                                        <span className="text-xs font-medium">{Math.round(modelDownloadEvent.percent ?? 0)}%</span>
                                                                    </div>
                                                                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-background/50">
                                                                        <div className="h-full bg-primary transition-all duration-300 ease-in-out" style={{ width: `${modelDownloadEvent.percent ?? 0}%` }} />
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {modelDownloadEvent?.message && !modelDownloadEvent.assetId && (
                                    <div className="mt-6 rounded-lg border bg-muted/50 p-4">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-sm font-medium">{modelDownloadEvent.message}</span>
                                            {typeof modelDownloadEvent.percent === 'number' && <span className="text-sm text-muted-foreground">{Math.round(modelDownloadEvent.percent)}%</span>}
                                        </div>
                                        {typeof modelDownloadEvent.percent === 'number' && (
                                            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                                                <div className="h-full bg-primary transition-all duration-300 ease-in-out" style={{ width: `${modelDownloadEvent.percent}%` }} />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'retrieval' && pythonSettings && (
                        <div className="space-y-6">
                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">Indexing Settings</h3>
                                <div className="rounded-lg border bg-card p-4 space-y-4">
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">Default Indexing Mode</label>
                                        <select
                                            value={pythonSettings.default_indexing_mode}
                                            onChange={(e) => updatePythonSetting('default_indexing_mode', e.target.value as 'fast' | 'deep')}
                                            className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        >
                                            <option value="fast">Fast (Text-based extraction)</option>
                                            <option value="deep">Deep (Vision-based analysis)</option>
                                        </select>
                                        <p className="text-xs text-muted-foreground">
                                            Fast mode uses text extraction for quick indexing. Deep mode uses vision analysis for better understanding of images and complex documents.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">Chunking Settings</h3>
                                <div className="rounded-lg border bg-card p-4 space-y-4">
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">PDF Chunking</label>
                                        <select
                                            value={pythonSettings.pdf_one_chunk_per_page ? 'page' : 'multi'}
                                            onChange={(e) => updatePythonSetting('pdf_one_chunk_per_page', e.target.value === 'page')}
                                            className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        >
                                            <option value="page">One chunk per page (Faster)</option>
                                            <option value="multi">Multiple chunks (Better precision)</option>
                                        </select>
                                        <p className="text-xs text-muted-foreground">
                                            Controls how PDF documents are split into chunks for indexing and retrieval.
                                        </p>
                                    </div>
                                </div>
                            </div>



                            <div className="space-y-4">
                                <div>
                                    <h3 className="text-sm font-medium">Retrieval Settings</h3>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Control how many documents are retrieved when searching your files
                                    </p>
                                </div>
                                <div className="rounded-lg border bg-card p-4 space-y-6">
                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                            <label className="text-sm font-medium">Max number of files per search</label>
                                            <span className="text-xs font-mono bg-muted px-2 py-1 rounded">{pythonSettings.search_result_limit} files</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="5"
                                            max="50"
                                            step="1"
                                            value={pythonSettings.search_result_limit}
                                            onChange={(e) => updatePythonSetting('search_result_limit', parseInt(e.target.value))}
                                            className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Maximum number of matching files shown in search results. Higher values show more results but may include less relevant matches.
                                        </p>
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                            <label className="text-sm font-medium">Max number of evidences per query</label>
                                            <span className="text-xs font-mono bg-muted px-2 py-1 rounded">{pythonSettings.qa_context_limit} evidences</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="1"
                                            max="50"
                                            step="1"
                                            value={pythonSettings.qa_context_limit}
                                            onChange={(e) => updatePythonSetting('qa_context_limit', parseInt(e.target.value))}
                                            className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Number of evidence pieces sent to the AI when answering questions. More evidences improve answer quality but increase response time.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {showSaveSuccess && (
                                <div className="flex items-center gap-2 text-sm text-emerald-600 animate-in fade-in duration-200">
                                    <CheckCircle2 className="h-4 w-4" />
                                    <span>Settings saved</span>
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'security' && (
                        <div className="space-y-6">
                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">API Keys</h3>
                                <div className="rounded-lg border bg-card p-4 space-y-4">
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            placeholder="New Key Name"
                                            value={newKeyName}
                                            onChange={(e) => setNewKeyName(e.target.value)}
                                            className="flex-1 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                        />
                                        <button
                                            onClick={createApiKey}
                                            disabled={!newKeyName.trim()}
                                            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
                                        >
                                            <Plus className="mr-2 h-4 w-4" /> Generate
                                        </button>
                                    </div>

                                    {createdKey && (
                                        <div className="rounded-md bg-green-500/10 p-3 border border-green-500/20">
                                            <p className="text-xs font-medium text-green-600 mb-1">New Key Generated</p>
                                            <div className="flex items-center gap-2">
                                                <code className="flex-1 text-xs bg-background p-1.5 rounded border font-mono">{createdKey.key}</code>
                                                <button
                                                    onClick={() => navigator.clipboard.writeText(createdKey.key)}
                                                    className="p-1.5 hover:bg-background rounded border border-transparent hover:border-border"
                                                    title="Copy"
                                                    type="button"
                                                >
                                                    <Copy className="h-3.5 w-3.5" />
                                                </button>
                                            </div>
                                            <p className="text-[10px] text-muted-foreground mt-1">Copy this key now. You won&apos;t be able to see it again.</p>
                                        </div>
                                    )}

                                    <div className="space-y-2">
                                        {apiKeys.map(key => (
                                            <ApiKeyItem 
                                                key={key.key} 
                                                apiKey={key} 
                                                localKey={localKey}
                                                onDelete={() => deleteApiKey(key.key)}
                                            />
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <ApiReferenceSection apiKey={localKey || 'YOUR_API_KEY'} />
                        </div>
                    )}


                    {activeTab === 'scan' && (
                        <div className="space-y-6">
                            <div className="space-y-4">
                                <div>
                                    <h3 className="text-sm font-medium">Scan Scope</h3>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Choose which folders to include when scanning your file system
                                    </p>
                                </div>

                                <div className="rounded-lg border bg-card p-4 space-y-4">
                                    {/* Mode Toggle */}
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-medium">Selection Mode</span>
                                        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
                                            <button
                                                onClick={() => setScanMode('smart')}
                                                className={cn(
                                                    "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                                                    scanScope.mode === 'smart'
                                                        ? "bg-background text-foreground shadow-sm"
                                                        : "text-muted-foreground hover:text-foreground"
                                                )}
                                            >
                                                Smart
                                            </button>
                                            <button
                                                onClick={() => setScanMode('custom')}
                                                className={cn(
                                                    "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                                                    scanScope.mode === 'custom'
                                                        ? "bg-background text-foreground shadow-sm"
                                                        : "text-muted-foreground hover:text-foreground"
                                                )}
                                            >
                                                Custom
                                            </button>
                                        </div>
                                    </div>

                                    {/* Selected Directories */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-muted-foreground">
                                                {scanScope.directories.length} folder{scanScope.directories.length !== 1 ? 's' : ''} selected
                                            </span>
                                            {scanScope.mode === 'custom' && (
                                                <button
                                                    onClick={pickScanDirectories}
                                                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                                                >
                                                    <Plus className="h-3 w-3" />
                                                    Add Folder
                                                </button>
                                            )}
                                        </div>

                                        <div className="flex flex-wrap gap-2">
                                            {scanScope.directories.map((dir) => (
                                                <div
                                                    key={dir.path}
                                                    className={cn(
                                                        "flex items-center gap-2 px-3 py-2 rounded-lg text-sm",
                                                        dir.isCloudSync
                                                            ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                                                            : "bg-primary/10 text-primary"
                                                    )}
                                                >
                                                    {dir.isCloudSync ? (
                                                        <Cloud className="h-4 w-4" />
                                                    ) : (
                                                        <Folder className="h-4 w-4" />
                                                    )}
                                                    <span className="font-medium">{dir.label}</span>
                                                    <button
                                                        onClick={() => toggleScanDirectory(dir.path)}
                                                        className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
                                                    >
                                                        <X className="h-3 w-3" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Available Directories (Smart mode) */}
                                    {scanScope.mode === 'smart' && (
                                        <div className="space-y-2 pt-2 border-t">
                                            <span className="text-xs text-muted-foreground">Available locations:</span>
                                            <div className="flex flex-wrap gap-2">
                                                {recommendedDirs.filter(d => !scanScope.directories.some(sd => sd.path === d.path)).map((dir) => (
                                                    <button
                                                        key={dir.path}
                                                        onClick={() => toggleScanDirectory(dir.path)}
                                                        className={cn(
                                                            "flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-dashed",
                                                            "text-muted-foreground hover:text-foreground hover:border-solid hover:bg-muted/50",
                                                            dir.isCloudSync && "border-purple-500/30"
                                                        )}
                                                    >
                                                        {dir.isCloudSync ? (
                                                            <Cloud className="h-4 w-4" />
                                                        ) : (
                                                            <Folder className="h-4 w-4" />
                                                        )}
                                                        <span>{dir.label}</span>
                                                        <Plus className="h-3 w-3" />
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-sm font-medium">Exclusion Rules</h3>
                                <div className="rounded-lg border bg-card p-4 space-y-4">
                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={scanScope.useRecommendedExclusions}
                                            onChange={(e) => saveScanScope({ ...scanScope, useRecommendedExclusions: e.target.checked })}
                                            className="rounded border-gray-300 text-primary focus:ring-primary"
                                        />
                                        <div>
                                            <span className="text-sm font-medium">Use recommended exclusions</span>
                                            <p className="text-xs text-muted-foreground">
                                                Skip system directories, caches, and development folders
                                            </p>
                                        </div>
                                    </label>

                                    <button
                                        onClick={() => setShowExclusions(!showExclusions)}
                                        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
                                    >
                                        <Settings2 className="h-3 w-3" />
                                        <span>View exclusion list</span>
                                        <ChevronRight className={cn("h-3 w-3 transition-transform", showExclusions && "rotate-90")} />
                                    </button>

                                    {showExclusions && (
                                        <div className="p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground space-y-2">
                                            <p className="font-medium text-foreground">System directories:</p>
                                            <p>/System, /Library, ~/Library, AppData, Program Files, Windows</p>
                                            <p className="font-medium text-foreground pt-2">Development directories:</p>
                                            <p>node_modules, .git, __pycache__, venv, dist, build, target, .next</p>
                                            <p className="font-medium text-foreground pt-2">Cache directories:</p>
                                            <p>Caches, Temp, .cache, .npm, .yarn</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
