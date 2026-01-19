"""
Internationalization (i18n) support for backend prompts and messages.
Supports 8 languages: English, Chinese, Japanese, Korean, French, German, Spanish, Russian.
"""
from typing import Literal

SupportedLanguage = Literal["en", "zh", "ja", "ko", "fr", "de", "es", "ru"]

# Default language
DEFAULT_LANGUAGE: SupportedLanguage = "en"


class I18nPrompts:
    """Multilingual prompt templates for VLM and LLM models."""
    
    # VLM Prompts for image description
    IMAGE_PROMPTS = {
        "en": "You are a vision assistant. Describe the image precisely, focusing on visible text, objects, and context.",
        "zh": "你是一个视觉助手。准确描述图像，重点关注可见文本、物体和上下文。",
        "ja": "あなたはビジョンアシスタントです。画像を正確に説明し、可視テキスト、オブジェクト、およびコンテキストに焦点を当ててください。",
        "ko": "당신은 비전 어시스턴트입니다. 보이는 텍스트, 객체 및 컨텍스트에 초점을 맞춰 이미지를 정확하게 설명하세요.",
        "fr": "Vous êtes un assistant vision. Décrivez l'image avec précision, en vous concentrant sur le texte visible, les objets et le contexte.",
        "de": "Sie sind ein Vision-Assistent. Beschreiben Sie das Bild präzise und konzentrieren Sie sich auf sichtbaren Text, Objekte und Kontext.",
        "es": "Eres un asistente de visión. Describe la imagen con precisión, enfocándote en el texto visible, objetos y contexto.",
        "ru": "Вы ассистент по зрению. Опишите изображение точно, сосредоточив внимание на видимом тексте, объектах и контексте.",
    }
    
    # VLM Prompts for PDF page OCR
    PDF_PAGE_PROMPTS = {
        "en": (
            "You are an OCR assistant. Extract everything from this page as Markdown. \n\n"
            "Rules:\n"
            "1. Extract all text exactly as shown.\n"
            "2. Start from the top. Use # for titles, ## for sections, ### for sub-sections.\n"
            "3. For multi-column layouts (e.g., two columns): read the LEFT column completely from top to bottom FIRST, then read the RIGHT column from top to bottom. Do NOT read across columns horizontally.\n"
            "4. For charts, list 2–4 key visible facts as bullet points (numbers, trends, labels).\n"
            "5. Organize the output comprehensively and in a logical and readable manner.\n"
            "Only Markdown. No guessing. No explanations. Do not show page number."
        ),
        "zh": (
            "你是一个OCR助手。将此页面的所有内容提取为Markdown格式。\n\n"
            "规则：\n"
            "1. 准确提取所有文本。\n"
            "2. 从顶部开始。使用 # 表示标题，## 表示章节，### 表示子章节。\n"
            "3. 对于多列布局（如两列）：首先从上到下完整阅读左列，然后从上到下阅读右列。不要水平跨列阅读。\n"
            "4. 对于图表，以项目符号列出2-4个关键可见事实（数字、趋势、标签）。\n"
            "5. 以全面、合乎逻辑且易读的方式组织输出。\n"
            "仅输出Markdown。不要猜测。不要解释。不要显示页码。"
        ),
        "ja": (
            "あなたはOCRアシスタントです。このページのすべてをMarkdownとして抽出してください。\n\n"
            "ルール：\n"
            "1. 表示されているすべてのテキストを正確に抽出します。\n"
            "2. 上から始めます。タイトルには#、セクションには##、サブセクションには###を使用します。\n"
            "3. 複数列レイアウト（2列など）の場合：まず左列を上から下まで完全に読み、次に右列を上から下まで読みます。列をまたいで水平に読まないでください。\n"
            "4. グラフの場合、2〜4つの主要な可視事実を箇条書きでリストします（数値、トレンド、ラベル）。\n"
            "5. 包括的で論理的かつ読みやすい方法で出力を整理します。\n"
            "Markdownのみ。推測しないでください。説明しないでください。ページ番号を表示しないでください。"
        ),
        "ko": (
            "당신은 OCR 어시스턴트입니다. 이 페이지의 모든 내용을 Markdown으로 추출하세요.\n\n"
            "규칙:\n"
            "1. 표시된 모든 텍스트를 정확하게 추출합니다.\n"
            "2. 상단에서 시작합니다. 제목에는 #, 섹션에는 ##, 하위 섹션에는 ###를 사용합니다.\n"
            "3. 다중 열 레이아웃(예: 두 열)의 경우: 먼저 왼쪽 열을 위에서 아래로 완전히 읽은 다음 오른쪽 열을 위에서 아래로 읽습니다. 열을 가로질러 수평으로 읽지 마세요.\n"
            "4. 차트의 경우 2-4개의 주요 가시적 사실을 글머리 기호로 나열합니다(숫자, 추세, 레이블).\n"
            "5. 포괄적이고 논리적이며 읽기 쉬운 방식으로 출력을 구성합니다.\n"
            "Markdown만 사용하세요. 추측하지 마세요. 설명하지 마세요. 페이지 번호를 표시하지 마세요."
        ),
        "fr": (
            "Vous êtes un assistant OCR. Extrayez tout de cette page en Markdown.\n\n"
            "Règles:\n"
            "1. Extrayez tout le texte exactement comme indiqué.\n"
            "2. Commencez par le haut. Utilisez # pour les titres, ## pour les sections, ### pour les sous-sections.\n"
            "3. Pour les mises en page à plusieurs colonnes (par exemple, deux colonnes): lisez la colonne de GAUCHE complètement de haut en bas EN PREMIER, puis lisez la colonne de DROITE de haut en bas. NE lisez PAS horizontalement entre les colonnes.\n"
            "4. Pour les graphiques, listez 2 à 4 faits clés visibles sous forme de points (chiffres, tendances, étiquettes).\n"
            "5. Organisez la sortie de manière complète, logique et lisible.\n"
            "Markdown uniquement. Pas de supposition. Pas d'explications. N'affichez pas le numéro de page."
        ),
        "de": (
            "Sie sind ein OCR-Assistent. Extrahieren Sie alles von dieser Seite als Markdown.\n\n"
            "Regeln:\n"
            "1. Extrahieren Sie allen Text genau wie angezeigt.\n"
            "2. Beginnen Sie oben. Verwenden Sie # für Titel, ## für Abschnitte, ### für Unterabschnitte.\n"
            "3. Bei mehrspaltigem Layout (z.B. zwei Spalten): Lesen Sie die LINKE Spalte zuerst vollständig von oben nach unten, dann die RECHTE Spalte von oben nach unten. Lesen Sie NICHT horizontal über Spalten hinweg.\n"
            "4. Bei Diagrammen listen Sie 2-4 wichtige sichtbare Fakten als Aufzählungspunkte auf (Zahlen, Trends, Beschriftungen).\n"
            "5. Organisieren Sie die Ausgabe umfassend, logisch und lesbar.\n"
            "Nur Markdown. Keine Vermutungen. Keine Erklärungen. Zeigen Sie keine Seitenzahl an."
        ),
        "es": (
            "Eres un asistente OCR. Extrae todo de esta página como Markdown.\n\n"
            "Reglas:\n"
            "1. Extrae todo el texto exactamente como se muestra.\n"
            "2. Comienza desde arriba. Usa # para títulos, ## para secciones, ### para subsecciones.\n"
            "3. Para diseños de múltiples columnas (por ejemplo, dos columnas): lee la columna IZQUIERDA completamente de arriba a abajo PRIMERO, luego lee la columna DERECHA de arriba a abajo. NO leas horizontalmente entre columnas.\n"
            "4. Para gráficos, enumera 2-4 hechos clave visibles como viñetas (números, tendencias, etiquetas).\n"
            "5. Organiza la salida de manera comprensiva, lógica y legible.\n"
            "Solo Markdown. Sin adivinar. Sin explicaciones. No muestres el número de página."
        ),
        "ru": (
            "Вы ассистент OCR. Извлеките все с этой страницы в формате Markdown.\n\n"
            "Правила:\n"
            "1. Извлекайте весь текст в точности как показано.\n"
            "2. Начните сверху. Используйте # для заголовков, ## для разделов, ### для подразделов.\n"
            "3. Для многоколоночных макетов (например, два столбца): прочитайте ЛЕВЫЙ столбец полностью сверху вниз СНАЧАЛА, затем прочитайте ПРАВЫЙ столбец сверху вниз. НЕ читайте горизонтально через столбцы.\n"
            "4. Для диаграмм перечислите 2-4 ключевых видимых факта в виде маркированного списка (цифры, тренды, метки).\n"
            "5. Организуйте вывод всесторонне, логично и удобочитаемо.\n"
            "Только Markdown. Без догадок. Без объяснений. Не показывайте номер страницы."
        ),
    }
    
    # VLM Prompts for video segment description
    VIDEO_SEGMENT_PROMPTS = {
        "en": "You are a video analyst. Describe what happens in this video segment. Focus on actions, objects, people, and any visible text. Be concise and specific.",
        "zh": "你是一个视频分析师。描述此视频片段中发生的事情。关注动作、物体、人物和任何可见文本。要简洁具体。",
        "ja": "あなたはビデオアナリストです。このビデオセグメントで何が起こるかを説明してください。アクション、オブジェクト、人々、および表示されているテキストに焦点を当ててください。簡潔かつ具体的にしてください。",
        "ko": "당신은 비디오 분석가입니다. 이 비디오 세그먼트에서 일어나는 일을 설명하세요. 동작, 객체, 사람 및 보이는 텍스트에 초점을 맞추세요. 간결하고 구체적으로 작성하세요.",
        "fr": "Vous êtes un analyste vidéo. Décrivez ce qui se passe dans ce segment vidéo. Concentrez-vous sur les actions, les objets, les personnes et tout texte visible. Soyez concis et précis.",
        "de": "Sie sind ein Videoanalyst. Beschreiben Sie, was in diesem Videosegment passiert. Konzentrieren Sie sich auf Aktionen, Objekte, Personen und sichtbaren Text. Seien Sie prägnant und spezifisch.",
        "es": "Eres un analista de video. Describe lo que sucede en este segmento de video. Concéntrate en acciones, objetos, personas y cualquier texto visible. Sé conciso y específico.",
        "ru": "Вы видеоаналитик. Опишите, что происходит в этом видеосегменте. Сосредоточьтесь на действиях, объектах, людях и любом видимом тексте. Будьте лаконичны и конкретны.",
    }
    
    # Document summary prompts
    SUMMARY_PROMPTS = {
        "en": (
            "Write a plain, objective summary of this document in 2-3 sentences (around 60 words). "
            "Include: the filename, document title, author or organization if known, and what the document is about. "
            "Use simple language. Do not use markdown formatting, bold, or bullet points."
        ),
        "zh": (
            "用2-3句话（约60字）写一个简单、客观的文档摘要。"
            "包括：文件名、文档标题、作者或组织（如果已知）以及文档内容。"
            "使用简单语言。不要使用markdown格式、粗体或项目符号。"
        ),
        "ja": (
            "この文書の簡潔で客観的な要約を2-3文（約60語）で書いてください。"
            "含めるもの：ファイル名、文書タイトル、既知の場合は著者または組織、文書の内容。"
            "簡単な言葉を使用してください。Markdown形式、太字、箇条書きを使用しないでください。"
        ),
        "ko": (
            "이 문서의 간단하고 객관적인 요약을 2-3문장(약 60단어)으로 작성하세요."
            "포함 사항: 파일 이름, 문서 제목, 알려진 경우 저자 또는 조직, 문서 내용."
            "간단한 언어를 사용하세요. Markdown 형식, 굵게 또는 글머리 기호를 사용하지 마세요."
        ),
        "fr": (
            "Rédigez un résumé simple et objectif de ce document en 2-3 phrases (environ 60 mots). "
            "Incluez : le nom du fichier, le titre du document, l'auteur ou l'organisation si connu, et le sujet du document. "
            "Utilisez un langage simple. N'utilisez pas de formatage markdown, de gras ou de puces."
        ),
        "de": (
            "Schreiben Sie eine einfache, objektive Zusammenfassung dieses Dokuments in 2-3 Sätzen (ca. 60 Wörter). "
            "Enthalten: den Dateinamen, Dokumenttitel, Autor oder Organisation falls bekannt, und worum es im Dokument geht. "
            "Verwenden Sie einfache Sprache. Verwenden Sie keine Markdown-Formatierung, Fettdruck oder Aufzählungszeichen."
        ),
        "es": (
            "Escribe un resumen simple y objetivo de este documento en 2-3 oraciones (alrededor de 60 palabras). "
            "Incluye: el nombre del archivo, título del documento, autor u organización si se conoce, y de qué trata el documento. "
            "Usa lenguaje simple. No uses formato markdown, negrita o viñetas."
        ),
        "ru": (
            "Напишите простое, объективное резюме этого документа в 2-3 предложениях (около 60 слов). "
            "Включите: имя файла, название документа, автора или организацию, если известно, и о чем документ. "
            "Используйте простой язык. Не используйте форматирование markdown, жирный шрифт или маркированные списки."
        ),
    }
    
    # Chunk question generation prompts
    CHUNK_QUESTIONS_PROMPTS = {
        "en": (
            "Write ONE concise, self-contained question (no more than 10 words) about this content. "
            "Be highly specific about the subject of the question—do not use pronouns, and ensure the question can stand alone without additional context.\n\n"
            "Examples:\n"
            "- What is the Q3 revenue of the company XXXX?\n"
            "- When is the deadline of the conference on XXXX?\n"
            "Write only the question. Do not include any explanations or extra text."
        ),
        "zh": (
            "针对此内容写一个简洁、独立的问题（不超过10个词）。"
            "明确具体地说明问题的主题——不要使用代词，确保问题可以单独理解，无需额外上下文。\n\n"
            "示例：\n"
            "- XXXX公司第三季度的收入是多少？\n"
            "- XXXX会议的截止日期是什么时候？\n"
            "只写问题。不要包含任何解释或额外文本。"
        ),
        "ja": (
            "このコンテンツについて、簡潔で自己完結型の質問を1つ書いてください（10語以内）。"
            "質問の主題について非常に具体的にし、代名詞を使用せず、追加のコンテキストなしで質問が独立できることを確認してください。\n\n"
            "例：\n"
            "- XXXX社の第3四半期の収益は？\n"
            "- XXXXに関する会議の締切はいつですか？\n"
            "質問のみを書いてください。説明や余分なテキストは含めないでください。"
        ),
        "ko": (
            "이 내용에 대해 간결하고 독립적인 질문을 하나 작성하세요(10단어 이내)."
            "질문의 주제에 대해 매우 구체적으로 작성하세요. 대명사를 사용하지 말고 추가 컨텍스트 없이 질문이 독립적으로 이해될 수 있도록 하세요.\n\n"
            "예시:\n"
            "- XXXX 회사의 3분기 수익은 얼마인가요?\n"
            "- XXXX 회의의 마감일은 언제인가요?\n"
            "질문만 작성하세요. 설명이나 추가 텍스트를 포함하지 마세요."
        ),
        "fr": (
            "Rédigez UNE question concise et autonome (pas plus de 10 mots) sur ce contenu. "
            "Soyez très précis sur le sujet de la question—n'utilisez pas de pronoms et assurez-vous que la question peut être comprise seule sans contexte supplémentaire.\n\n"
            "Exemples:\n"
            "- Quel est le chiffre d'affaires du T3 de l'entreprise XXXX?\n"
            "- Quelle est la date limite de la conférence sur XXXX?\n"
            "Écrivez uniquement la question. N'incluez aucune explication ou texte supplémentaire."
        ),
        "de": (
            "Schreiben Sie EINE prägnante, eigenständige Frage (nicht mehr als 10 Wörter) zu diesem Inhalt. "
            "Seien Sie sehr spezifisch über das Thema der Frage—verwenden Sie keine Pronomen und stellen Sie sicher, dass die Frage ohne zusätzlichen Kontext verstanden werden kann.\n\n"
            "Beispiele:\n"
            "- Was ist der Q3-Umsatz des Unternehmens XXXX?\n"
            "- Wann ist die Frist für die Konferenz über XXXX?\n"
            "Schreiben Sie nur die Frage. Fügen Sie keine Erklärungen oder zusätzlichen Text hinzu."
        ),
        "es": (
            "Escribe UNA pregunta concisa y autocontenida (no más de 10 palabras) sobre este contenido. "
            "Sé muy específico sobre el tema de la pregunta: no uses pronombres y asegúrate de que la pregunta pueda entenderse sola sin contexto adicional.\n\n"
            "Ejemplos:\n"
            "- ¿Cuáles son los ingresos del tercer trimestre de la empresa XXXX?\n"
            "- ¿Cuándo es la fecha límite de la conferencia sobre XXXX?\n"
            "Escribe solo la pregunta. No incluyas explicaciones ni texto adicional."
        ),
        "ru": (
            "Напишите ОДИН краткий, самодостаточный вопрос (не более 10 слов) об этом контенте. "
            "Будьте очень конкретны в отношении темы вопроса—не используйте местоимения и убедитесь, что вопрос может быть понят без дополнительного контекста.\n\n"
            "Примеры:\n"
            "- Каков доход компании XXXX за третий квартал?\n"
            "- Когда крайний срок конференции по XXXX?\n"
            "Напишите только вопрос. Не включайте объяснения или дополнительный текст."
        ),
    }

    @classmethod
    def get_image_prompt(cls, language: SupportedLanguage = DEFAULT_LANGUAGE) -> str:
        """Get image description prompt in specified language."""
        return cls.IMAGE_PROMPTS.get(language, cls.IMAGE_PROMPTS[DEFAULT_LANGUAGE])
    
    @classmethod
    def get_pdf_page_prompt(cls, language: SupportedLanguage = DEFAULT_LANGUAGE) -> str:
        """Get PDF page OCR prompt in specified language."""
        return cls.PDF_PAGE_PROMPTS.get(language, cls.PDF_PAGE_PROMPTS[DEFAULT_LANGUAGE])
    
    @classmethod
    def get_video_segment_prompt(cls, language: SupportedLanguage = DEFAULT_LANGUAGE) -> str:
        """Get video segment description prompt in specified language."""
        return cls.VIDEO_SEGMENT_PROMPTS.get(language, cls.VIDEO_SEGMENT_PROMPTS[DEFAULT_LANGUAGE])
    
    @classmethod
    def get_summary_prompt(cls, language: SupportedLanguage = DEFAULT_LANGUAGE) -> str:
        """Get document summary prompt in specified language."""
        return cls.SUMMARY_PROMPTS.get(language, cls.SUMMARY_PROMPTS[DEFAULT_LANGUAGE])
    
    @classmethod
    def get_chunk_questions_prompt(cls, language: SupportedLanguage = DEFAULT_LANGUAGE) -> str:
        """Get chunk question generation prompt in specified language."""
        return cls.CHUNK_QUESTIONS_PROMPTS.get(language, cls.CHUNK_QUESTIONS_PROMPTS[DEFAULT_LANGUAGE])


def get_prompt(prompt_type: str, language: SupportedLanguage = DEFAULT_LANGUAGE) -> str:
    """
    Get a prompt in the specified language.
    
    Args:
        prompt_type: Type of prompt ("image", "pdf_page", "video_segment", "summary", "chunk_questions")
        language: Language code
    
    Returns:
        Prompt string in the specified language
    """
    prompt_methods = {
        "image": I18nPrompts.get_image_prompt,
        "pdf_page": I18nPrompts.get_pdf_page_prompt,
        "video_segment": I18nPrompts.get_video_segment_prompt,
        "summary": I18nPrompts.get_summary_prompt,
        "chunk_questions": I18nPrompts.get_chunk_questions_prompt,
    }
    
    method = prompt_methods.get(prompt_type)
    if method:
        return method(language)
    
    # Fallback to English default
    return I18nPrompts.get_image_prompt(DEFAULT_LANGUAGE)

