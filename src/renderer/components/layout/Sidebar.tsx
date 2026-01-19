import { Plus, MessageSquare, Settings, Database, Puzzle, Trash2, HelpCircle, BarChart3, User } from 'lucide-react';
import { CSSProperties } from 'react';
import { cn } from '../../lib/utils';
import { useSkin } from '../skin-provider';
import type { ChatSession, IndexProgressUpdate } from '../../types';

interface SidebarProps {
    sessions: ChatSession[];
    currentSessionId: string | null;
    onSelectSession: (id: string) => void;
    onCreateSession: () => void;
    onDeleteSession: (id: string) => void;
    activeView: 'chat' | 'knowledge' | 'models' | 'settings' | 'extensions' | 'scan' | 'mbti' | 'memory';
    onSelectView: (view: 'chat' | 'knowledge' | 'models' | 'settings' | 'extensions' | 'scan' | 'mbti' | 'memory') => void;
    onOpenIndexProgress?: () => void;
    isIndexing?: boolean;
    indexStatus?: IndexProgressUpdate['status'] | null;
    onOpenGuide?: () => void;
}

export function Sidebar({
    sessions,
    currentSessionId,
    onSelectSession,
    onCreateSession,
    onDeleteSession,
    activeView,
    onSelectView,
    onOpenIndexProgress,
    isIndexing = false,
    indexStatus = null,
    onOpenGuide
}: SidebarProps) {
    const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
    const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;
    const { skin } = useSkin();
    const isCocoaSkin = skin === 'local-cocoa';

    const showIndexingShortcut = Boolean(
        onOpenIndexProgress && (isIndexing || indexStatus === 'failed' || indexStatus === 'paused')
    );

    return (
        <div className={cn(
            "flex h-full w-[260px] flex-col border-r",
            isCocoaSkin ? "cocoa-sidebar" : "bg-muted/30"
        )}>
            <div className="p-4 pt-12 space-y-2" style={dragStyle}>
                {/* Local Cocoa Logo */}
                <div className="mb-4 text-center">
                    <span className={isCocoaSkin ? "cocoa-sidebar-logo" : "minimalist-sidebar-logo"}>
                        Local Cocoa
                    </span>
                </div>
                <button
                    onClick={() => {
                        onCreateSession();
                        onSelectView('chat');
                    }}
                    className={cn(
                        "flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-sm transition-colors",
                        isCocoaSkin 
                            ? "cocoa-primary-btn" 
                            : "bg-primary text-primary-foreground hover:bg-primary/90"
                    )}
                    style={noDragStyle}
                >
                    <Plus className="h-4 w-4" />
                    New Chat
                </button>
                {onOpenGuide && (
                    <button
                        onClick={onOpenGuide}
                        className={cn(
                            "flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2 text-xs font-medium transition-colors",
                            isCocoaSkin
                                ? "border-[#3d2f1c] bg-[#1f1610] text-[#c9a87c] hover:bg-[#2a1f14] hover:text-[#e8d4bc]"
                                : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
                        )}
                        style={noDragStyle}
                    >
                        <HelpCircle className="h-3.5 w-3.5" />
                        Guide
                    </button>
                )}
            </div>

            {/* Chat history with fade-out effect at bottom */}
            <div className="relative flex-1 min-h-0">
                <div className="h-full overflow-y-auto px-2 pb-8">
                    <div className={cn(
                        "mb-2 px-2 text-xs font-semibold uppercase tracking-wider",
                        isCocoaSkin ? "text-[#8b6914]" : "text-muted-foreground"
                    )}>
                        Chats
                    </div>
                    <div className="space-y-1">
                        {sessions.map((session) => (
                            <div
                                key={session.id}
                                className={cn(
                                    "group flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer",
                                    isCocoaSkin
                                        ? currentSessionId === session.id && activeView === 'chat'
                                            ? "bg-[#3d2f1c]/50 text-[#e8d4bc] font-medium"
                                            : "text-[#c9a87c] hover:bg-[#3d2f1c]/30 hover:text-[#e8d4bc]"
                                        : currentSessionId === session.id && activeView === 'chat'
                                            ? "bg-accent text-accent-foreground font-medium"
                                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                                )}
                                onClick={() => {
                                    onSelectView('chat');
                                    onSelectSession(session.id);
                                }}
                            >
                                <div className="flex items-center gap-3 overflow-hidden">
                                    <MessageSquare className="h-4 w-4 shrink-0" />
                                    <span className="truncate">{session.title}</span>
                                </div>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDeleteSession(session.id);
                                    }}
                                    className={cn(
                                        "opacity-0 group-hover:opacity-100 p-1 transition-opacity",
                                        isCocoaSkin ? "hover:text-red-400" : "hover:text-destructive"
                                    )}
                                >
                                    <Trash2 className="h-3 w-3" />
                                </button>
                            </div>
                        ))}
                        {sessions.length === 0 && (
                            <div className={cn(
                                "px-3 py-4 text-center text-xs",
                                isCocoaSkin ? "text-[#8b6914]" : "text-muted-foreground"
                            )}>
                                No recent chats
                            </div>
                        )}
                    </div>
                </div>
                {/* Gradient fade overlay at bottom */}
                <div 
                    className="pointer-events-none absolute bottom-0 left-0 right-0 h-16"
                    style={{
                        background: isCocoaSkin 
                            ? 'linear-gradient(to bottom, transparent 0%, #1f1610 100%)'
                            : 'linear-gradient(to bottom, transparent 0%, hsl(var(--muted) / 0.3) 100%)'
                    }}
                />
            </div>

            {/* Decorative separator line */}
            <div className="px-4 py-1">
                <div 
                    className="h-px"
                    style={{
                        background: isCocoaSkin 
                            ? 'linear-gradient(90deg, transparent 0%, #8b6914 20%, #c9a227 50%, #8b6914 80%, transparent 100%)'
                            : 'linear-gradient(90deg, transparent 0%, hsl(var(--border)) 20%, hsl(var(--border)) 80%, transparent 100%)'
                    }}
                />
            </div>
            <div className="p-2 space-y-1">
                <button
                    onClick={() => onSelectView('knowledge')}
                    className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isCocoaSkin
                            ? activeView === 'knowledge'
                                ? "bg-[#3d2f1c]/50 text-[#e8d4bc]"
                                : "text-[#c9a87c] hover:bg-[#3d2f1c]/30 hover:text-[#e8d4bc]"
                            : activeView === 'knowledge'
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                >
                    <Database className="h-4 w-4" />
                    Files
                </button>
                <button
                    onClick={() => onSelectView('memory')}
                    className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isCocoaSkin
                            ? activeView === 'memory'
                                ? "bg-[#3d2f1c]/50 text-[#e8d4bc]"
                                : "text-[#c9a87c] hover:bg-[#3d2f1c]/30 hover:text-[#e8d4bc]"
                            : activeView === 'memory'
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                >
                    <User className="h-4 w-4" />
                    Memory
                </button>
                <button
                    onClick={() => onSelectView('extensions')}
                    className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isCocoaSkin
                            ? activeView === 'extensions'
                                ? "bg-[#3d2f1c]/50 text-[#e8d4bc]"
                                : "text-[#c9a87c] hover:bg-[#3d2f1c]/30 hover:text-[#e8d4bc]"
                            : activeView === 'extensions'
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                >
                    <Puzzle className="h-4 w-4" />
                    Extensions
                </button>
                <button
                    onClick={() => onSelectView('settings')}
                    className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isCocoaSkin
                            ? activeView === 'settings'
                                ? "bg-[#3d2f1c]/50 text-[#e8d4bc]"
                                : "text-[#c9a87c] hover:bg-[#3d2f1c]/30 hover:text-[#e8d4bc]"
                            : activeView === 'settings'
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                >
                    <Settings className="h-4 w-4" />
                    Models & Settings
                </button>

                {showIndexingShortcut ? (
                    <button
                        onClick={() => onOpenIndexProgress?.()}
                        className={cn(
                            "mt-1 flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                            "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        )}
                        title="Open index progress"
                        style={noDragStyle}
                    >
                        <span className="inline-flex items-center gap-2">
                            <BarChart3 className="h-3.5 w-3.5" />
                            {indexStatus === 'failed' ? 'Indexing failed' : indexStatus === 'paused' ? 'Indexing paused' : 'Indexing…'}
                        </span>
                        <span
                            className={cn(
                                "h-2 w-2 rounded-full",
                                indexStatus === 'failed' ? 'bg-destructive' : isIndexing ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground'
                            )}
                        />
                    </button>
                ) : null}
            </div>
        </div>
    );
}
