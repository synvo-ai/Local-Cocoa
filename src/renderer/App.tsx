import { QuickSearchShell } from './components/QuickSearchShell';
import { MainAppView } from './components/MainAppView';
import { ThemeProvider } from './components/theme-provider';
import { SkinProvider } from './components/skin-provider';

// Import plugin system (frontend registry for dynamic plugin components)
import './plugins';

// Import i18n configuration
import '../i18n/config';

export default function App() {
    const viewParam =
        typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('view') : null;

    if (viewParam === 'spotlight') {
        return (
            <ThemeProvider defaultTheme="system" storageKey="local-cocoa-theme">
                <SkinProvider defaultSkin="local-cocoa" storageKey="local-cocoa-skin">
                    <QuickSearchShell />
                </SkinProvider>
            </ThemeProvider>
        );
    }

    return (
        <ThemeProvider defaultTheme="system" storageKey="local-cocoa-theme">
            <SkinProvider defaultSkin="local-cocoa" storageKey="local-cocoa-skin">
                <MainAppView />
            </SkinProvider>
        </ThemeProvider>
    );
}
