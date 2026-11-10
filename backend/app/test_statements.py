import io

import pytest

from fastapi.testclient import TestClient
from pypdf import PdfWriter

from .auth import current_user
from .main import app

pytestmark = pytest.mark.no_db  # extraction is stateless; authentication is the only dependency and is overridden below

client = TestClient(app)


def _auth() -> dict:
    app.dependency_overrides[current_user] = lambda: object()
    return {}


def _pdf(pages: list[list[tuple[int, int, str]]]) -> bytes:
    """A tiny valid PDF with Helvetica text at exact positions (invented sample data)."""
    objs: list[bytes] = []
    n = len(pages)
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(n))
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    font_id = 3 + n * 2
    for i, texts in enumerate(pages):
        content = "BT /F1 9 Tf " + " ".join(f"1 0 0 1 {x} {y} Tm ({t}) Tj" for x, y, t in texts) + " ET"
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {4 + i * 2} 0 R >>".encode())
        objs.append(f"<< /Length {len(content)} >>\nstream\n{content}\nendstream".encode())
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = io.BytesIO(); out.write(b"%PDF-1.4\n"); offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell()); out.write(f"{i} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return out.getvalue()


def _post(data: bytes, headers: dict, content_type: str = 'application/pdf'):
    return client.post('/api/v1/statements/extract', content=data, headers={**headers, 'Content-Type': content_type})


def test_extracts_rows_with_positions_across_pages() -> None:
    headers = _auth()
    pdf = _pdf([
        [(40, 700, 'Date'), (200, 700, 'Narration'), (400, 700, 'Debit'), (480, 700, 'Credit'),
         (40, 680, '01/11/2026'), (200, 680, 'UPI SWIGGY'), (400, 680, '1,250.00'),
         (40, 660, '02/11/2026'), (200, 660, 'SALARY ACME'), (480, 660, '1,25,000.00')],
        [(40, 700, '03/11/2026'), (200, 700, 'ATM WDL'), (400, 700, '2,000.00')],
    ])
    r = _post(pdf, headers)
    assert r.status_code == 200
    body = r.json()
    assert body['status'] == 'text' and body['page_count'] == 2
    first, second = body['pages']
    assert len(first) == 3 and len(second) == 1
    row = first[1]
    assert row.split() == ['01/11/2026', 'UPI', 'SWIGGY', '1,250.00']
    # layout is approximate, but each amount still sits nearer its own column heading than the other one
    head = first[0]
    d, c = head.index('Debit'), head.index('Credit')
    assert abs(row.index('1,250.00') - d) < abs(row.index('1,250.00') - c)
    assert abs(first[2].index('1,25,000.00') - c) < abs(first[2].index('1,25,000.00') - d)


def test_scanned_encrypted_invalid_and_rejected_uploads() -> None:
    headers = _auth()
    blank = PdfWriter(); blank.add_blank_page(width=200, height=200)
    buf = io.BytesIO(); blank.write(buf)
    assert _post(buf.getvalue(), headers).json()['status'] == 'scanned'

    locked = PdfWriter(); locked.add_blank_page(width=200, height=200); locked.encrypt('secret')
    buf = io.BytesIO(); locked.write(buf)
    assert _post(buf.getvalue(), headers).json()['status'] == 'encrypted'

    assert _post(b'%PDF-1.4 this is not really a pdf', headers).json()['status'] == 'invalid'
    assert _post(b'not a pdf at all', headers).status_code == 422
    assert _post(b'', headers).status_code == 422
    assert _post(b'%PDF-1.4', headers, 'text/plain').status_code == 415
    assert _post(b'%PDF-1.4' + b'0' * (10 * 1024 * 1024), headers).status_code == 413


def test_requires_authentication() -> None:
    app.dependency_overrides.pop(current_user, None)
    assert client.post('/api/v1/statements/extract', content=b'%PDF-1.4', headers={'Content-Type': 'application/pdf'}).status_code in (401, 403)


def teardown_module() -> None:
    app.dependency_overrides.pop(current_user, None)


def test_every_page_is_reported_and_a_page_that_cannot_be_read_is_named() -> None:
    """Pages are read one by one. A damaged page is listed (page number, fixed reason, no text) instead of silently shortening the statement."""
    from . import statements

    headers = _auth()
    pdf = _pdf([[(40, 700, 'one')], [(40, 700, 'two')], [(40, 700, 'three')]])
    body = _post(pdf, headers).json()
    assert body['status'] == 'text' and body['page_count'] == 3 and body['pages_processed'] == 3 and body['page_issues'] == []

    class Boom:
        def get_text(self, *_a, **_k):
            raise RuntimeError('damaged page')

    class Doc:
        needs_pass = False
        page_count = 3

        def load_page(self, i):
            if i == 1:
                return Boom()
            return real.load_page(i)

        def close(self):
            real.close()

    import fitz  # the same library the endpoint uses

    real = fitz.open(stream=pdf, filetype='pdf')
    original = statements.fitz.open
    statements.fitz.open = lambda **_k: Doc()
    try:
        broken = _post(pdf, headers).json()
    finally:
        statements.fitz.open = original
    assert broken['page_count'] == 3 and broken['pages_processed'] == 2
    assert broken['page_issues'] == [{'page': 2, 'reason': 'page could not be read', 'recovered': False}]
    assert broken['pages'][1] == [] and broken['pages'][0] and broken['pages'][2]


def test_reading_order_comes_from_coordinates_not_the_content_stream() -> None:
    headers = _auth()
    # drawn bottom-up and right-to-left: the rows must still come back top-down and left-to-right
    pdf = _pdf([[(300, 600, 'Amount'), (40, 600, 'Date'), (300, 680, '43'), (40, 680, '01 Oct'), (120, 680, 'Paid to Shop')]])
    rows = _post(pdf, headers).json()['pages'][0]
    assert [r.split() for r in rows] == [['01', 'Oct', 'Paid', 'to', 'Shop', '43'], ['Date', 'Amount']]


def test_page_and_size_limits_are_configurable_and_enforced(monkeypatch) -> None:
    from . import statements

    headers = _auth()
    monkeypatch.setattr(statements, 'MAX_PAGES', 2)
    assert _post(_pdf([[(40, 700, 'a')], [(40, 700, 'b')], [(40, 700, 'c')]]), headers).status_code == 413
    assert _post(_pdf([[(40, 700, 'a')], [(40, 700, 'b')]]), headers).status_code == 200
    monkeypatch.setattr(statements, 'MAX_STATEMENT_PDF_BYTES', 1024)
    assert _post(b'%PDF-1.4' + b'0' * 2048, headers).status_code == 413


def test_a_hundred_page_statement_is_read_page_by_page() -> None:
    headers = _auth()
    pdf = _pdf([[(40, 700, f'Page {i}'), (200, 700, f'{i}.00')] for i in range(1, 101)])
    body = _post(pdf, headers).json()
    assert body['page_count'] == 100 and body['pages_processed'] == 100 and all(len(p) == 1 for p in body['pages'])
    assert body['pages'][99][0].split() == ['Page', '100', '100.00']


def test_the_pypdf_fallback_still_works_without_pymupdf(monkeypatch) -> None:
    from . import statements

    headers = _auth()
    monkeypatch.setattr(statements, 'fitz', None)
    body = _post(_pdf([[(40, 700, 'Date'), (200, 700, 'Amount')], [(40, 700, '01/11/2026')]]), headers).json()
    assert body['status'] == 'text' and body['page_count'] == 2 and body['pages_processed'] == 2
    blank = PdfWriter(); blank.add_blank_page(width=200, height=200)
    buf = io.BytesIO(); blank.write(buf)
    assert _post(buf.getvalue(), headers).json()['status'] == 'scanned'
