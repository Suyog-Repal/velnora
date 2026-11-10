"""
Bank statement PDF reading. The app sends the PDF it picked (after the person agreed); this returns the text with its
position on the page, row by row. Nothing is parsed into transactions here and nothing is stored or logged: the bytes
live in memory for the length of the request, and no text is written anywhere.
- POST /api/v1/statements/extract   raw PDF bytes as the request body (Content-Type: application/pdf)

Extraction is page by page, each page on its own: a page that cannot be read is reported (page number and reason) instead
of silently shortening the statement, so the app can say the import is incomplete. Reading order is rebuilt from word
coordinates (never trusted from the content stream), and every row keeps its columns as runs of spaces, so the app can tell
a debit column from a credit column by where on the row an amount sits.

PyMuPDF is used when installed (clean words, real coordinates); pypdf "layout" mode is the fallback.
Limits come from the environment: STATEMENT_MAX_PDF_MB (default 10) and STATEMENT_MAX_PAGES (default 200).
"""
import io
import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from pypdf import PdfReader
from pypdf.errors import PyPdfError

from app.auth import current_user
from app.db.models import User as UserModel

try:  # optional: better text. The service works without it.
    import fitz  # type: ignore[import-not-found]  # PyMuPDF
except Exception:  # pragma: no cover - depends on the environment
    fitz = None

router = APIRouter(prefix="/api/v1/statements", tags=["statements"])


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
        return value if value > 0 else default
    except ValueError:
        return default


MAX_STATEMENT_PDF_BYTES = _env_int("STATEMENT_MAX_PDF_MB", 10) * 1024 * 1024
MAX_PAGES = _env_int("STATEMENT_MAX_PAGES", 200)

_READ_ERRORS = (PyPdfError, ValueError, KeyError, TypeError, IndexError, AttributeError, NotImplementedError, OSError, RecursionError)


class PageIssue(BaseModel):
    page: int  # 1-based
    reason: str  # a short fixed phrase, never statement text
    recovered: bool = False  # True when some rows of the page were still read


class ExtractResponse(BaseModel):
    # text: usable text found. scanned: pages exist but carry no text (needs OCR, which this server does not do).
    # encrypted: password protected. invalid: not a readable PDF. empty: no pages.
    status: Literal["text", "scanned", "encrypted", "invalid", "empty"]
    page_count: int = 0
    # One list of printed rows per page (empty for a blank page, and for a page listed in page_issues).
    pages: list[list[str]] = []
    # Pages that could not be read completely. Empty means every page was processed; anything else means incomplete.
    page_issues: list[PageIssue] = []
    pages_processed: int = 0


# A gap wider than this (points) starts a new column: it becomes two or more spaces in the row text.
_WORD_GAP = 7.0
_COLUMN_UNIT = 4.2  # points per character of the row text; only used to place columns relative to each other
_LINE_TOLERANCE = 3.0


def _rows_from_words(words: list[tuple[float, float, float, float, str]]) -> list[str]:
    """(x0, y0, x1, y1, text) -> rows top to bottom, words left to right, wide gaps kept as runs of spaces."""
    words = [w for w in words if w[4].strip()]
    words.sort(key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    lines: list[list[tuple[float, float, float, float, str]]] = []
    for word in words:
        middle = (word[1] + word[3]) / 2
        if lines and abs(middle - sum((w[1] + w[3]) / 2 for w in lines[-1]) / len(lines[-1])) <= _LINE_TOLERANCE:
            lines[-1].append(word)
        else:
            lines.append([word])
    rows: list[str] = []
    for line in lines:
        line.sort(key=lambda w: w[0])
        text = ""
        previous_end = None
        for x0, _y0, x1, _y1, token in line:
            if previous_end is None:
                text = " " * int(x0 / _COLUMN_UNIT) + token
            else:
                gap = x0 - previous_end
                target = int(x0 / _COLUMN_UNIT)
                pad = 1 if gap < _WORD_GAP else max(2, target - len(text))
                text += " " * pad + token
            previous_end = x1
        rows.append(text.rstrip())
    return rows


def _extract_with_fitz(data: bytes) -> ExtractResponse:
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception:
        return ExtractResponse(status="invalid")
    try:
        if doc.needs_pass and not doc.authenticate(""):
            return ExtractResponse(status="encrypted")
        count = doc.page_count
        if count == 0:
            return ExtractResponse(status="empty")
        if count > MAX_PAGES:
            raise HTTPException(status_code=413, detail=f"Statement has more than {MAX_PAGES} pages")
        pages: list[list[str]] = []
        issues: list[PageIssue] = []
        for index in range(count):
            try:
                page = doc.load_page(index)
                words = [(w[0], w[1], w[2], w[3], w[4]) for w in page.get_text("words")]
                pages.append(_rows_from_words(words))
            except Exception:  # one bad page must not hide the others
                pages.append([])
                issues.append(PageIssue(page=index + 1, reason="page could not be read"))
        if len(issues) == count:
            return ExtractResponse(status="invalid", page_count=count)
        has_text = any(pages)
        return ExtractResponse(status="text" if has_text else "scanned", page_count=count, pages=pages, page_issues=issues, pages_processed=count - len(issues))
    finally:
        doc.close()


def _extract_with_pypdf(data: bytes) -> ExtractResponse:
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            return ExtractResponse(status="encrypted")
        count = len(reader.pages)
    except _READ_ERRORS:
        return ExtractResponse(status="invalid")
    if count == 0:
        return ExtractResponse(status="empty")
    if count > MAX_PAGES:
        raise HTTPException(status_code=413, detail=f"Statement has more than {MAX_PAGES} pages")
    pages: list[list[str]] = []
    issues: list[PageIssue] = []
    for index in range(count):
        try:
            text = reader.pages[index].extract_text(extraction_mode="layout") or ""
            pages.append([line.rstrip() for line in text.splitlines() if line.strip()])
        except KeyError:  # a page object with no /Contents is a blank page, not a failure
            pages.append([])
        except _READ_ERRORS:
            pages.append([])
            issues.append(PageIssue(page=index + 1, reason="page could not be read"))
    if len(issues) == count:
        return ExtractResponse(status="invalid", page_count=count)
    has_text = any(pages)
    return ExtractResponse(status="text" if has_text else "scanned", page_count=count, pages=pages, page_issues=issues, pages_processed=count - len(issues))


def extract_lines(data: bytes) -> ExtractResponse:
    try:
        return _extract_with_fitz(data) if fitz is not None else _extract_with_pypdf(data)
    except HTTPException:
        raise
    except _READ_ERRORS:
        return ExtractResponse(status="invalid")


@router.post("/extract", response_model=ExtractResponse)
async def extract_statement(request: Request, user: UserModel = Depends(current_user)) -> ExtractResponse:
    declared = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if declared != "application/pdf":
        raise HTTPException(status_code=415, detail="Only PDF files are accepted")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=422, detail="Empty upload")
    if len(data) > MAX_STATEMENT_PDF_BYTES:
        raise HTTPException(status_code=413, detail=f"Statement is larger than {MAX_STATEMENT_PDF_BYTES // (1024 * 1024)} MB")
    if not data.lstrip()[:5] == b"%PDF-":
        raise HTTPException(status_code=422, detail="File content is not a PDF")
    return extract_lines(data)  # the bytes and the text are never logged or persisted
