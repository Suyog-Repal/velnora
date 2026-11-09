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
