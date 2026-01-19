/**
 * PluginWebview - Renders an external plugin in an isolated webview
 * 
 * This component provides CSS/JS isolation for third-party plugins.
 * Communication happens via contextBridge + IPC through pluginPreload.ts
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';

interface PluginWebviewProps {
    pluginId: string;
    className?: string;
    onLoad?: () => void;
    onError?: (error: string) => void;
}

export function PluginWebview({ 
    pluginId, 
    className,
    onLoad,
    onError 
}: PluginWebviewProps) {
    const webviewRef = useRef<HTMLWebViewElement | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [frontendUrl, setFrontendUrl] = useState<string | null>(null);

    // Load plugin frontend URL
    useEffect(() => {
        async function loadUrl() {
            try {
                const url = await window.api.getPluginFrontendUrl(pluginId);
                if (url) {
                    setFrontendUrl(url);
                    setError(null);
                } else {
                    setError(`Plugin "${pluginId}" has no frontend`);
                    onError?.(`Plugin "${pluginId}" has no frontend`);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setError(message);
                onError?.(message);
            }
        }
        loadUrl();
    }, [pluginId, onError]);

    // Handle webview events
    useEffect(() => {
        const webview = webviewRef.current;
        if (!webview || !frontendUrl) return;

        const handleLoadStart = () => {
            setIsLoading(true);
            setError(null);
        };

        const handleLoadStop = () => {
            setIsLoading(false);
            onLoad?.();
        };

        const handleError = (event: Event) => {
            const e = event as ErrorEvent;
            const message = e.message || 'Failed to load plugin';
            setError(message);
            setIsLoading(false);
            onError?.(message);
        };

        const handleConsoleMessage = (event: Event) => {
            const e = event as CustomEvent;
            // Forward plugin console messages with prefix
            const level = e.detail?.level || 'log';
            const message = e.detail?.message || '';
            console[level as 'log' | 'warn' | 'error'](`[Plugin:${pluginId}]`, message);
        };

        webview.addEventListener('did-start-loading', handleLoadStart);
        webview.addEventListener('did-stop-loading', handleLoadStop);
        webview.addEventListener('did-fail-load', handleError);
        webview.addEventListener('console-message', handleConsoleMessage);

        return () => {
            webview.removeEventListener('did-start-loading', handleLoadStart);
            webview.removeEventListener('did-stop-loading', handleLoadStop);
            webview.removeEventListener('did-fail-load', handleError);
            webview.removeEventListener('console-message', handleConsoleMessage);
        };
    }, [frontendUrl, pluginId, onLoad, onError]);

    // Reload webview
    const handleReload = useCallback(() => {
        const webview = webviewRef.current;
        if (webview) {
            (webview as any).reload();
        }
    }, []);

    if (error) {
        return (
            <div className={cn(
                "flex flex-col items-center justify-center gap-4 p-8 text-center",
                className
            )}>
                <AlertCircle className="h-12 w-12 text-destructive/60" />
                <div className="space-y-1">
                    <p className="font-medium text-destructive">Plugin Error</p>
                    <p className="text-sm text-muted-foreground">{error}</p>
                </div>
                <button
                    onClick={handleReload}
                    className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-muted hover:bg-muted/80 transition-colors"
                >
                    <RefreshCw className="h-4 w-4" />
                    Retry
                </button>
            </div>
        );
    }

    if (!frontendUrl) {
        return (
            <div className={cn(
                "flex items-center justify-center",
                className
            )}>
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className={cn("relative", className)}>
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
            )}
            <webview
                ref={webviewRef as any}
                src={frontendUrl}
                style={{ width: '100%', height: '100%' }}
                // @ts-expect-error - webview attributes
                partition={`plugin:${pluginId}`}
                webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
            />
        </div>
    );
}

// Type declaration for webview element
declare global {
    namespace JSX {
        interface IntrinsicElements {
            webview: React.DetailedHTMLProps<
                React.HTMLAttributes<HTMLElement> & {
                    src?: string;
                    partition?: string;
                    webpreferences?: string;
                    preload?: string;
                },
                HTMLElement
            >;
        }
    }
}

