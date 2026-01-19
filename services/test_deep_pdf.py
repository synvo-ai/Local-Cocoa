import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.absolute()
sys.path.append(str(PROJECT_ROOT))

from services.parser.pdf_deep import PdfDeepParser


file_path = "/Users/catillzhang/Downloads/1411768744065_.pdf"
parser = PdfDeepParser()
result = parser.parse(file_path)
print(result.metadata['page_texts'])



