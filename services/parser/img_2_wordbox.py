from rapidocr import RapidOCR
import time

class IMG2WORDS():
    def __init__(self):
        self.engine = RapidOCR()
    def ocr_chars_to_fitz_words(self,ocr_chars):
        """
    Convert OCR single-char results to PyMuPDF 'words' format.

    Input:
        ocr_chars: iterable of (char, score, quad)
            quad = [[x,y], [x,y], [x,y], [x,y]]

    Output:
        list of tuples:
            (x0, y0, x1, y1, text, block_no, line_no, word_no)
        """

        words = []

        for block_no, block in enumerate(ocr_chars):
            for word_no,(char,score,quad) in enumerate(block):
                xs = [p[0] for p in quad]
                ys = [p[1] for p in quad]

                x0 = float(min(xs))
                y0 = float(min(ys))
                x1 = float(max(xs))
                y1 = float(max(ys))

                words.append((
                x0, y0, x1, y1,
                char,          # original character
                block_no,      # block_no by enumerate
                0,             # line_no placeholder
                word_no,             # word_no placeholder
                ))

        return words
    
    def run(self,img_dir):
        try:
            result = self.engine(img_dir, return_word_box=True, return_single_char_box=True)
            ocr_chars = result.word_results
            words = self.ocr_chars_to_fitz_words(ocr_chars)
            return words
        except Exception as e:
            print(e)
            return []
        


