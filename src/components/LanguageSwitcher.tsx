import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n/config';
import { Check } from 'lucide-react';

// Language flags mapping using emoji flags
const LANGUAGE_FLAGS: Record<SupportedLanguage, string> = {
    en: '🇺🇸',
    zh: '🇨🇳',
    ja: '🇯🇵',
    ko: '🇰🇷',
    fr: '🇫🇷',
    de: '🇩🇪',
    es: '🇪🇸',
    ru: '🇷🇺'
};

export function LanguageSwitcher() {
    const { i18n } = useTranslation();

    // Normalize language code (e.g., 'en-US' -> 'en')
    const normalizeLanguage = (lang: string): SupportedLanguage => {
        const base = lang.split('-')[0].toLowerCase();
        return (base in SUPPORTED_LANGUAGES ? base : 'en') as SupportedLanguage;
    };

    const currentLanguage = normalizeLanguage(i18n.language);

    const changeLanguage = (lng: SupportedLanguage) => {
        i18n.changeLanguage(lng);
    };

    return (
        <div className="grid grid-cols-4 gap-3">
            {(Object.entries(SUPPORTED_LANGUAGES) as [SupportedLanguage, string][]).map(([code, name]) => (
                <button
                    key={code}
                    onClick={() => changeLanguage(code)}
                    className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border p-4 transition-all hover:shadow-md ${
                        currentLanguage === code
                            ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                            : 'bg-card hover:bg-accent/50'
                    }`}
                >
                    {/* Selection indicator */}
                    {currentLanguage === code && (
                        <div className="absolute top-2 right-2">
                            <Check className="h-4 w-4 text-primary" />
                        </div>
                    )}
                    
                    {/* Flag */}
                    <span className="text-3xl" role="img" aria-label={name}>
                        {LANGUAGE_FLAGS[code]}
                    </span>
                    
                    {/* Language name */}
                    <span className={`text-xs font-medium text-center ${
                        currentLanguage === code ? 'text-primary' : 'text-muted-foreground'
                    }`}>
                        {name}
                    </span>
                </button>
            ))}
        </div>
    );
}

