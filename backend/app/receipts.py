"""
Authenticated receipt storage. Images are stored in the application's own database (no external/paid storage).
- POST /api/v1/receipts?transaction_id=...   raw image bytes as the request body (Content-Type: image/jpeg|png|webp)
- GET  /api/v1/receipts/{receipt_id}         the image, only for its owner
- DELETE /api/v1/receipts/{receipt_id}
Every query is scoped to the authenticated user; another user's ids behave as "not found".
"""
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db.models import Receipt as ReceiptModel
from app.db.models import Transaction as TransactionModel
from app.db.models import User as UserModel
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/receipts", tags=["receipts"])

MAX_RECEIPT_BYTES = 5 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _sniff(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@router.post("", status_code=status.HTTP_201_CREATED)
async def upload_receipt(
    request: Request,
    transaction_id: UUID,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    declared = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if declared not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported image type")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=422, detail="Empty upload")
    if len(data) > MAX_RECEIPT_BYTES:
        raise HTTPException(status_code=413, detail="Receipt is larger than 5 MB")
    if _sniff(data) is None:
        raise HTTPException(status_code=422, detail="File content is not a supported image")

    tx = db.scalar(select(TransactionModel).where(TransactionModel.id == transaction_id, TransactionModel.user_id == user.id))
    if tx is None:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # One receipt per transaction: replacing removes the previous image.
    for old in db.scalars(select(ReceiptModel).where(ReceiptModel.transaction_id == transaction_id, ReceiptModel.user_id == user.id)).all():
        db.delete(old)
    receipt = ReceiptModel(
        id=uuid4(), user_id=user.id, transaction_id=transaction_id,
        content_type=_sniff(data), size_bytes=len(data), data=data, created_at=datetime.now(timezone.utc),
    )
    db.add(receipt)
    db.commit()
    return {"id": str(receipt.id), "transaction_id": str(transaction_id), "size_bytes": receipt.size_bytes}


@router.get("/{receipt_id}")
def download_receipt(receipt_id: UUID, user: UserModel = Depends(current_user), db: Session = Depends(get_db)) -> Response:
    row = db.scalar(select(ReceiptModel).where(ReceiptModel.id == receipt_id, ReceiptModel.user_id == user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="Receipt not found")
    return Response(content=row.data, media_type=row.content_type, headers={"Cache-Control": "private, no-store"})


@router.delete("/{receipt_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_receipt(receipt_id: UUID, user: UserModel = Depends(current_user), db: Session = Depends(get_db)) -> Response:
    row = db.scalar(select(ReceiptModel).where(ReceiptModel.id == receipt_id, ReceiptModel.user_id == user.id))
    if row is not None:
        db.delete(row)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
