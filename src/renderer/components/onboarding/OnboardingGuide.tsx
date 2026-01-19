import { useState, useEffect, useMemo } from 'react';
import { X, ChevronRight, ChevronLeft, Download, Folder, Mail, FileText, Activity, Command, Box, CheckCircle2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ModelDownloadEvent } from '../../types';
import bannerImage from '../../../../assets/banner/banner.png';

interface OnboardingGuideProps {
    isOpen: boolean;
    onClose: () => void;
    onComplete: () => void;
    onNavigate: (view: 'chat' | 'knowledge' | 'models' | 'settings' | 'extensions') => void;
    modelsReady?: boolean;
    onDownloadModels?: () => void;
    modelDownloadEvent?: ModelDownloadEvent | null;
}

function BoxIcon({ className }: { className?: string }) {
    return <Box className={className} />;
}

function FolderIcon({ className }: { className?: string }) {
    return <Folder className={className} />;
}

function ActivityIcon({ className }: { className?: string }) {
    return <Activity className={className} />;
}

function CommandIcon({ className }: { className?: string }) {
    return <Command className={className} />;
}

export function OnboardingGuide({
    isOpen,
    onClose,
    onComplete,
    onNavigate,
    modelsReady = false,
    onDownloadModels,
    modelDownloadEvent
}: OnboardingGuideProps) {
    const [currentStep, setCurrentStep] = useState(0);

    useEffect(() => {
        if (isOpen) {
            setCurrentStep(0);
        }
    }, [isOpen]);

    const steps = useMemo(() => [
        {
            id: 'welcome',
            title: 'Welcome!',
            description: 'Your private AI workspace that runs entirely on your device. Your data never leaves your machine.',
            content: (
                <div className="space-y-4 text-sm text-muted-foreground">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                            <span className="text-lg">🔒</span>
                            <span className="text-foreground font-medium">100% Private</span>
                        </div>
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                            <span className="text-lg">💻</span>
                            <span className="text-foreground font-medium">Runs Locally</span>
                        </div>
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                            <span className="text-lg">📁</span>
                            <span className="text-foreground font-medium">All Your Files</span>
                        </div>
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                            <span className="text-lg">🤖</span>
                            <span className="text-foreground font-medium">AI Powered</span>
                        </div>
                    </div>
                    <p className="text-center text-xs pt-2">
                        Let&apos;s get you set up in just a few steps.
                    </p>
                </div>
            ),
            icon: null
        },
        {
            id: 'models',
            title: 'Download AI Models',
            description: 'Local Cocoa uses AI models that run privately on your device. Let\'s get them set up.',
            content: (
                <div className="space-y-4 text-sm">
                    {modelsReady ? (
                        <div className="flex items-center gap-3 p-4 border rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-5 w-5" />
                            <span className="font-medium">All AI models are ready!</span>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="p-4 border rounded-lg bg-amber-50 dark:bg-amber-900/20 space-y-3">
                                <div className="flex items-start gap-3">
                                    <Download className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5" />
                                    <div className="space-y-1">
                                        <p className="font-medium text-amber-900 dark:text-amber-100">Download Required Models</p>
                                        <p className="text-xs text-amber-700 dark:text-amber-300">
                                            Includes vision, embedding, and reranker models (~2GB total).
                                        </p>
                                    </div>
                                </div>

                                {modelDownloadEvent?.state === 'downloading' || modelDownloadEvent?.state === 'checking' ? (
                                    <div className="space-y-2 pt-2">
                                        <div className="flex items-center justify-between text-xs">
                                            <span>{modelDownloadEvent.message || 'Downloading...'}</span>
                                            <span>{modelDownloadEvent.percent ? `${modelDownloadEvent.percent.toFixed(1)}%` : ''}</span>
                                        </div>
                                        <div className="h-1.5 w-full bg-amber-200 dark:bg-amber-800 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-amber-500 transition-all duration-300"
                                                style={{ width: `${modelDownloadEvent.percent || 0}%` }}
                                            />
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        onClick={onDownloadModels}
                                        className="w-full flex items-center justify-center gap-2 rounded-md bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-sm font-medium text-white hover:from-amber-600 hover:to-orange-600 transition-colors"
                                    >
                                        <Download className="h-4 w-4" />
                                        Download AI Models
                                    </button>
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground text-center">
                                You can also bring your own GGUF models in the Models tab later.
                            </p>
                        </div>
                    )}
                </div>
            ),
            icon: <BoxIcon className="h-8 w-8 text-primary" />,
            action: { label: 'Manage Models', view: 'models' as const }
        },
        {
            id: 'knowledge',
            title: 'Connect Your Data',
            description: 'Make your AI smarter by connecting your local files and accounts.',
            content: (
                <div className="grid gap-3 text-sm">
                    <div className="flex items-center gap-3 p-3 border rounded bg-card">
                        <Folder className="h-5 w-5 text-blue-500" />
                        <div>
                            <div className="font-medium">Local Folders</div>
                            <div className="text-xs text-muted-foreground">Index documents for search & QA</div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 p-3 border rounded bg-card">
                        <Mail className="h-5 w-5 text-red-500" />
                        <div>
                            <div className="font-medium">Email Accounts</div>
                            <div className="text-xs text-muted-foreground">Connect IMAP accounts</div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 p-3 border rounded bg-card">
                        <FileText className="h-5 w-5 text-yellow-500" />
                        <div>
                            <div className="font-medium">Notes</div>
                            <div className="text-xs text-muted-foreground">Built-in markdown notes</div>
                        </div>
                    </div>
                </div>
            ),
            icon: <FolderIcon className="h-8 w-8 text-blue-500" />,
            action: { label: 'Configure Knowledge', view: 'knowledge' as const }
        },
        {
            id: 'extensions',
            title: 'Extensions',
            description: 'Explore installed extensions like Activity Tracking, Email, and Notes.',
            content: (
                <div className="space-y-2 text-sm text-muted-foreground">
                    <p>Go to the <strong>Extensions</strong> tab to access all your installed plugins.</p>
                    <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/30">
                        <Activity className="h-5 w-5 text-green-500" />
                        <span>Track activity, connect emails, and manage notes in one place.</span>
                    </div>
                </div>
            ),
            icon: <ActivityIcon className="h-8 w-8 text-green-500" />,
            action: { label: 'Go to Extensions', view: 'extensions' as const }
        },
        {
            id: 'shortcuts',
            title: 'Power User Shortcuts',
            description: 'Access Local Cocoa from anywhere.',
            content: (
                <div className="space-y-4 text-sm">
                    <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
                        <span className="font-medium">Quick Search / QA</span>
                        <kbd className="pointer-events-none inline-flex h-6 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                            <span className="text-xs">⌘</span>+<span className="text-xs">Shift</span>+<span className="text-xs">Space</span>
                        </kbd>
                    </div>
                    <p className="text-muted-foreground text-xs">
                        Use this shortcut to quickly search your files or ask questions without opening the main window.
                    </p>
                </div>
            ),
            icon: <CommandIcon className="h-8 w-8 text-purple-500" />
        }
    ], [modelsReady, modelDownloadEvent, onDownloadModels]);

    if (!isOpen) return null;

    const step = steps[currentStep];
    const isLastStep = currentStep === steps.length - 1;

    const handleNext = () => {
        if (isLastStep) {
            onComplete();
        } else {
            setCurrentStep(prev => prev + 1);
        }
    };

    const handleBack = () => {
        setCurrentStep(prev => Math.max(0, prev - 1));
    };

    const handleAction = () => {
        if (step.action) {
            onNavigate(step.action.view);
            onClose();
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="relative w-full max-w-lg overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                <button
                    onClick={onClose}
                    className={cn(
                        "absolute right-4 top-4 z-10 rounded-full p-1.5 transition-all focus:outline-none focus:ring-2 focus:ring-ring",
                        step.id === 'welcome'
                            ? "bg-black/30 hover:bg-black/50 text-white backdrop-blur-sm"
                            : "opacity-70 hover:opacity-100"
                    )}
                >
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close</span>
                </button>

                <div className="flex flex-col h-[600px]">
                    {/* Header Image/Icon Area */}
                    {step.id === 'welcome' ? (
                        <div className="shrink-0 w-full overflow-hidden" style={{ height: '200px' }}>
                            <img
                                src={bannerImage}
                                alt="Local Cocoa - Your Private File Caretaker"
                                className="w-full h-full object-cover object-center"
                            />
                        </div>
                    ) : (
                        <div className="shrink-0 flex items-center justify-center bg-muted/20 p-6 h-[160px]">
                            {step.icon}
                        </div>
                    )}

                    {/* Content Area */}
                    <div className={cn("flex-1 p-8 flex flex-col overflow-hidden", step.id === 'welcome' && "pt-6")}>
                        <div className="mb-6 shrink-0">
                            <h2 className="text-2xl font-bold tracking-tight mb-2">{step.title}</h2>
                            <p className="text-muted-foreground">{step.description}</p>
                        </div>

                        <div className="flex-1 overflow-y-auto -mr-4 pr-4">
                            {step.content}
                        </div>

                        {/* Footer / Navigation */}
                        <div className="mt-6 pt-6 flex items-center justify-between shrink-0 border-t">
                            <div className="flex gap-1">
                                {steps.map((_, idx) => (
                                    <div
                                        key={idx}
                                        className={cn(
                                            "h-1.5 w-1.5 rounded-full transition-colors",
                                            idx === currentStep ? "bg-primary" : "bg-muted"
                                        )}
                                    />
                                ))}
                            </div>

                            <div className="flex items-center gap-2">
                                {step.action && (
                                    <button
                                        onClick={handleAction}
                                        className="mr-2 text-sm font-medium text-primary hover:underline"
                                    >
                                        {step.action.label}
                                    </button>
                                )}

                                {currentStep > 0 && (
                                    <button
                                        onClick={handleBack}
                                        className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2"
                                    >
                                        <ChevronLeft className="mr-2 h-4 w-4" />
                                        Back
                                    </button>
                                )}
                                <button
                                    onClick={handleNext}
                                    className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2"
                                >
                                    {isLastStep ? (
                                        "Get Started"
                                    ) : (
                                        <>
                                            Next
                                            <ChevronRight className="ml-2 h-4 w-4" />
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
