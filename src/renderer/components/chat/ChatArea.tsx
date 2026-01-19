import type { AgentContext, SearchMode } from '../ConversationPanel';
import { ConversationPanel } from '../ConversationPanel';
import type { IndexedFile, SearchHit, ConversationMessage, ModelAssetStatus } from '../../types';

interface ChatAreaProps {
    messages: ConversationMessage[];
    loading: boolean;
    onSend: (text: string, mode?: SearchMode) => Promise<void>;
    model: string;
    availableModels?: ModelAssetStatus[];
    onModelChange?: (modelId: string) => void;
    onAddLocalModel?: () => void;
    onReferenceOpen?: (reference: SearchHit) => void;
    className?: string;
    agentContext?: AgentContext | null;
    onResetConversation?: () => void;
    currentSessionId?: string | null;
    title?: string;
    files?: IndexedFile[];
    onResume?: (mode?: SearchMode) => Promise<void>;
}

export function ChatArea({
    messages,
    loading,
    onSend,
    model,
    availableModels,
    onModelChange,
    onAddLocalModel,
    onReferenceOpen,
    className,
    agentContext,
    onResetConversation,
    title,
    files,
    onResume
}: ChatAreaProps) {
    // We don't need internal preview state anymore as it's handled by the parent layout
    // But ConversationPanel expects onPreviewReference.
    // We can pass a handler that bubbles up to the parent if we want, 
    // or just use the onReferenceOpen to trigger the right panel.

    // For now, let's assume onReferenceOpen opens the file/hit in the right panel.

    return (
        <div className={`flex h-full flex-col overflow-hidden relative bg-background ${className ?? ''}`.trim()}>
            <ConversationPanel
                className="flex-1"
                messages={messages}
                loading={loading}
                onSend={onSend}
                model={model}
                availableModels={availableModels}
                onModelChange={onModelChange}
                onAddLocalModel={onAddLocalModel}
                title={title || "Workspace Agent"}
                onPreviewReference={(reference) => onReferenceOpen?.(reference)}
                onResetConversation={onResetConversation}
                agentContext={agentContext}
                files={files}
                onResume={onResume}
            />
        </div>
    );
}
