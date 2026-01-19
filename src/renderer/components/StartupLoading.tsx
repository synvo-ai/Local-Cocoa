import { Loader2, Settings, Download, Sparkles, Coffee } from 'lucide-react';
import logo from '../assets/local_cocoa_logo_full.png';
import { useEffect } from 'react';

interface StartupLoadingProps {
    onOpenModelManager: () => void;
    statusMessage?: string;
    modelsReady: boolean;
}

export function StartupLoading({ onOpenModelManager, statusMessage, modelsReady }: StartupLoadingProps) {
    // Auto-open model manager if models are missing after a short delay
    useEffect(() => {
        if (!modelsReady) {
            const timer = setTimeout(() => {
                onOpenModelManager();
            }, 1500);
            return () => clearTimeout(timer);
        }
    }, [modelsReady, onOpenModelManager]);

    return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-gradient-to-br from-amber-50 via-orange-50/50 to-background dark:from-amber-950/20 dark:via-orange-950/10 dark:to-background text-foreground relative overflow-hidden">
            {/* Decorative background circles */}
            <div className="absolute top-1/4 -left-20 w-64 h-64 bg-amber-200/20 dark:bg-amber-800/10 rounded-full blur-3xl" />
            <div className="absolute bottom-1/4 -right-20 w-64 h-64 bg-orange-200/20 dark:bg-orange-800/10 rounded-full blur-3xl" />

            <div className="absolute top-0 left-0 right-0 h-12 z-50" style={{ WebkitAppRegion: 'drag' } as any} />
            <div className="flex flex-col items-center gap-8 p-8 animate-in fade-in duration-700 relative z-10">
                <div className="relative">
                    <div className="h-28 w-auto flex items-center justify-center">
                        <img src={logo} alt="Local Cocoa Logo" className="h-full w-auto object-contain drop-shadow-lg" />
                    </div>
                    <div className="absolute -bottom-2 -right-2">
                        <div className="h-10 w-10 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg flex items-center justify-center">
                            {modelsReady ? (
                                <Loader2 className="h-5 w-5 animate-spin text-white" />
                            ) : (
                                <Coffee className="h-5 w-5 text-white" />
                            )}
                        </div>
                    </div>
                </div>

                <div className="text-center space-y-3">
                    <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-amber-700 to-orange-600 dark:from-amber-300 dark:to-orange-400 bg-clip-text text-transparent">
                        Local Cocoa
                    </h1>
                    <p className="text-muted-foreground text-base">
                        {modelsReady ? 'Warming up your private AI...' : 'Welcome! Let\'s get you set up'}
                    </p>
                </div>

                <div className="flex flex-col items-center gap-3">
                    {!modelsReady ? (
                        <div className="flex flex-col items-center gap-5">
                            <div className="flex items-center gap-2 rounded-full bg-amber-100 dark:bg-amber-900/30 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                                <Sparkles className="h-4 w-4" />
                                First-time Setup
                            </div>
                            <p className="text-sm text-muted-foreground max-w-sm text-center leading-relaxed">
                                Local Cocoa runs AI entirely on your device.
                                <br />
                                Let&apos;s download the models you&apos;ll need.
                            </p>
                            <button
                                onClick={onOpenModelManager}
                                className="mt-2 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 px-6 py-3 text-sm font-semibold text-white shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105"
                            >
                                <Download className="h-4 w-4" />
                                Complete AI Setup
                            </button>
                        </div>
                    ) : (
                        <>
                            <div className="rounded-full bg-amber-100 dark:bg-amber-900/30 px-5 py-2 text-sm font-medium text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                                {statusMessage || 'Starting AI services...'}
                            </div>
                            <p className="text-xs text-muted-foreground">This takes a moment on first launch</p>
                        </>
                    )}
                </div>

                {modelsReady && (
                    <div className="mt-6">
                        <button
                            onClick={onOpenModelManager}
                            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                        >
                            <Settings className="h-4 w-4" />
                            <span>Model Settings</span>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
