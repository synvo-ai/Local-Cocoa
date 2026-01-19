import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, RefreshCw, Mail, Calendar, User, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from '../lib/utils';
import type { EmailMessageSummary, EmailMessageContent } from '../types';

interface EmailBrowserProps {
    messages: EmailMessageSummary[];
    selectedMessageId: string | null;
    onSelectMessage: (messageId: string) => void;
    messageContent: EmailMessageContent | null;
    loading: boolean;
    loadingContent: boolean;
    onBack: () => void;
    onRefresh: () => void;
    accountLabel: string;
    onCloseMessage?: () => void;
}

export function EmailBrowser({
    messages,
    selectedMessageId,
    onSelectMessage,
    messageContent,
    loading,
    loadingContent,
    onBack,
    onRefresh,
    accountLabel,
    onCloseMessage
}: EmailBrowserProps) {
    const [listHeight, setListHeight] = useState(40); // Percentage
    const [isDragging, setIsDragging] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const handleMouseDown = (e: React.MouseEvent) => {
        setIsDragging(true);
        e.preventDefault();
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging || !containerRef.current) return;
            const containerRect = containerRef.current.getBoundingClientRect();
            const relativeY = e.clientY - containerRect.top;
            const percentage = (relativeY / containerRect.height) * 100;
            // Clamp between 20% and 80%
            const clamped = Math.min(Math.max(percentage, 20), 80);
            setListHeight(clamped);
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
        } else {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [isDragging]);

    return (
        <div className="flex h-full flex-col max-w-5xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between border-b px-0 py-3 shrink-0">
                <div className="flex items-center gap-3">
                    <button
                        onClick={onBack}
                        className="rounded-full p-1.5 hover:bg-muted transition-colors"
                        title="Back to accounts"
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-full bg-primary/10 text-primary">
                            <Mail className="h-4 w-4" />
                        </div>
                        <h2 className="font-semibold text-sm">{accountLabel}</h2>
                        <span className="text-xs text-muted-foreground">
                            {messages.length} messages
                        </span>
                    </div>
                </div>
                <button
                    onClick={onRefresh}
                    disabled={loading}
                    className="p-2 hover:bg-muted rounded-md transition-colors disabled:opacity-50"
                    title="Refresh messages"
                >
                    <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                </button>
            </div>

            {/* Split View */}
            <div ref={containerRef} className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Top: Message List */}
                <div 
                    className={cn("overflow-y-auto bg-muted/10")}
                    style={{ height: selectedMessageId ? `${listHeight}%` : '100%' }}
                >
                    {messages.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center text-muted-foreground p-8">
                            {loading ? (
                                <div className="flex flex-col items-center gap-2">
                                    <RefreshCw className="h-8 w-8 animate-spin opacity-50" />
                                    <p>Loading messages...</p>
                                </div>
                            ) : (
                                <>
                                    <Mail className="h-12 w-12 opacity-20 mb-2" />
                                    <p>No messages found</p>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="divide-y">
                            {messages.map((message) => (
                                <div
                                    key={message.id}
                                    onClick={() => onSelectMessage(message.id)}
                                    className={cn(
                                        "flex cursor-pointer gap-3 px-4 py-3 transition-colors hover:bg-muted/50",
                                        selectedMessageId === message.id ? "bg-primary/5 hover:bg-primary/10" : ""
                                    )}
                                >
                                    <div className={cn(
                                        "mt-1 h-2 w-2 rounded-full shrink-0 bg-transparent"
                                    )} />
                                    <div className="flex-1 min-w-0 space-y-1">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-sm truncate font-medium text-foreground">
                                                {message.sender || 'Unknown Sender'}
                                            </span>
                                            <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                                                {message.sentAt ? new Date(message.sentAt).toLocaleDateString() : ''}
                                            </span>
                                        </div>
                                        <p className="text-sm truncate font-medium text-foreground">
                                            {message.subject || '(No Subject)'}
                                        </p>
                                        <p className="text-xs text-muted-foreground truncate">
                                            {message.preview || ''}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Resizer & Content */}
                {selectedMessageId && (
                    <>
                        <div
                            className="h-1.5 bg-border hover:bg-primary/50 cursor-row-resize transition-colors shrink-0 flex items-center justify-center"
                            onMouseDown={handleMouseDown}
                        >
                            <div className="w-8 h-0.5 bg-muted-foreground/20 rounded-full" />
                        </div>
                        
                        <div className="flex-1 flex flex-col min-h-0 bg-background overflow-hidden">
                            {loadingContent ? (
                                <div className="flex h-full items-center justify-center text-muted-foreground">
                                    <RefreshCw className="h-6 w-6 animate-spin mr-2" />
                                    Loading content...
                                </div>
                            ) : messageContent ? (
                                <div className="flex-1 overflow-y-auto p-6">
                                    <div className="mb-6 space-y-4 border-b pb-6 relative">
                                        <div className="flex items-start justify-between gap-4 pr-8">
                                            <h1 className="text-xl font-semibold leading-tight">
                                                {messageContent.subject || '(No Subject)'}
                                            </h1>
                                            {onCloseMessage && (
                                                <button 
                                                    onClick={onCloseMessage}
                                                    className="absolute right-0 top-0 p-1.5 hover:bg-muted rounded-full text-muted-foreground hover:text-foreground transition-colors"
                                                    title="Close preview"
                                                >
                                                    <X className="h-4 w-4" />
                                                </button>
                                            )}
                                        </div>
                                        
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex items-center gap-3">
                                                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                                    <User className="h-5 w-5" />
                                                </div>
                                                <div>
                                                    <div className="font-medium text-sm">{messageContent.sender || 'Unknown Sender'}</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        To: {messageContent.recipients?.join(', ') || 'Me'}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex flex-col items-end text-xs text-muted-foreground">
                                                <div className="flex items-center gap-1.5">
                                                    <Calendar className="h-3.5 w-3.5" />
                                                    {messageContent.sentAt ? new Date(messageContent.sentAt).toLocaleString() : ''}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="prose prose-sm dark:prose-invert max-w-none">
                                        <ReactMarkdown>
                                            {messageContent.markdown || ''}
                                        </ReactMarkdown>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex h-full items-center justify-center text-muted-foreground">
                                    Select a message to view content
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
