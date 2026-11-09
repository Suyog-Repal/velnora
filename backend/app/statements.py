"""
Bank statement PDF reading. The app sends the PDF it picked (after the person agreed); this returns the text with its
position on the page, row by row. Nothing is parsed into transactions here and nothing is stored or logged: the bytes
live in memory for the length of the request.
- POST /api/v1/statements/extract   raw PDF bytes as the request body (Content-Type: application/pdf)
"""
import io
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from pypdf import PdfReader
from pypdf.errors import PyPdfError

from app.auth import current_user
from app.db.models import User as UserModel

router = APIRouter(prefix="/api/v1/statements", tags=["statements"])

MAX_STATEMENT_PDF_BYTES = 10 * 1024 * 1024
MAX_PAGES = 200


class ExtractResponse(BaseModel):
    # text: usable text found. scanned: pages exist but carry no text (needs OCR, which this server does not do).
    # encrypted: password protected. invalid: not a readable PDF. empty: no pages.
    status: Literal["text", "scanned", "encrypted", "invalid", "empty"]
    page_count: int = 0
    # One list of printed rows per page. Columns are kept as runs of spaces (pypdf "layout" mode), so the app can tell
    # a debit column from a credit column by where on the row an amount sits.
    pages: list[list[str]] = []


def extract_lines(data: bytes) -> ExtractResponse:
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            return ExtractResponse(status="encrypted")
        count = len(reader.pages)
        if count == 0:
            return ExtractResponse(status="empty")
        if count > MAX_PAGES:
            raise HTTPException(status_code=413, detail=f"Statement has more than {MAX_PAGES} pages")
        pages: list[list[str]] = []
        for index in range(count):
            text = reader.pages[index].extract_text(extraction_mode="layout") or ""
            pages.append([line.rstrip() for line in text.splitlines() if line.strip()])
    except HTTPException:
        raise
    except (PyPdfError, ValueError, KeyError, TypeError, IndexError, AttributeError, NotImplementedError, OSError, RecursionError):
        return ExtractResponse(status="invalid")
    has_text = any(page for page in pages)
    return ExtractResponse(status="text" if has_text else "scanned", page_count=count, pages=pages)


@router.post("/extract", response_model=ExtractResponse)
async def extract_statement(request: Request, user: UserModel = Depends(current_user)) -> ExtractResponse:
    declared = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if declared != "application/pdf":
        raise HTTPException(status_code=415, detail="Only PDF files are accepted")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=422, detail="Empty upload")
    if len(data) > MAX_STATEMENT_PDF_BYTES:
        raise HTTPException(status_code=413, detail="Statement is larger than 10 MB")
    if not data.lstrip()[:5] == b"%PDF-":
        raise HTTPException(status_code=422, detail="File content is not a PDF")
    return extract_lines(data)  # the bytes and the text are never logged or persisted
