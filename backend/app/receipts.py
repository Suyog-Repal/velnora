"""
Authenticated receipt storage. Images are stored in the application's own database (no external/paid storage).
- POST /api/v1/receipts?transaction_id=...   raw image bytes as the request body (Content-Type: image/jpeg|png|webp)
- GET  /api/v1/receipts/{receipt_id}         the image, only for its owner
- DELETE /api/v1/receipts/{receipt_id}

Transaction attachments (several photos / scanned pages per transaction):
- PUT    /api/v1/receipts/attachments/{id}?transaction_id=...&attachment_type=photo|scan&page_index=..  idempotent upload
- GET    /api/v1/receipts/attachments?transaction_id=...  metadata of active attachments + ids deleted since
- GET    /api/v1/receipts/attachments/{id}                the original image bytes
- DELETE /api/v1/receipts/attachments/{id}                idempotent delete (tombstone kept, bytes cleared)

Every query is scoped to the authenticated user; another user's ids behave as "not found". Nothing is ever served
from a public URL: every download needs the owner's bearer token.
"""
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db.models import Attachment as AttachmentModel
from app.db.models import Receipt as ReceiptModel
from app.db.models import Transaction as TransactionModel
from app.db.models import User as UserModel
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/receipts", tags=["receipts"])

MAX_RECEIPT_BYTES = 5 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
MAX_ATTACHMENTS_PER_TX = 10
ATTACHMENT_TYPES = {"photo", "scan"}
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


# ==============================================================================
# Transaction attachments (registered before /{receipt_id} so "attachments" is never parsed as a receipt id)
# ==============================================================================

def _attachment_meta(row: AttachmentModel) -> dict:
    return {
        "id": str(row.id),
        "transaction_id": str(row.transaction_id),
        "attachment_type": row.attachment_type,
        "page_index": row.page_index,
        "content_type": row.content_type,
        "size_bytes": row.size_bytes,
        "width": row.width,
        "height": row.height,
        "created_at": row.created_at.isoformat(),
    }


@router.put("/attachments/{attachment_id}")
async def put_attachment(
    attachment_id: UUID,
    request: Request,
    response: Response,
    transaction_id: UUID,
    attachment_type: str = Query(default="photo"),
    page_index: int = Query(default=0, ge=0, le=1000),
    width: int | None = Query(default=None, ge=1, le=100_000),
    height: int | None = Query(default=None, ge=1, le=100_000),
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """
    Idempotent upload keyed by the client-generated attachment id.
    - first upload: 201 with metadata
    - retry of an upload the server already stored: 200 with the same metadata (no second copy is stored)
    - the attachment was deleted (tombstone): 410, the client must not resurrect it
    - the id belongs to another account / another transaction, or the transaction is not the caller's: 404
    """
    if attachment_type not in ATTACHMENT_TYPES:
        raise HTTPException(status_code=422, detail="attachment_type must be 'photo' or 'scan'")

    existing = db.scalar(select(AttachmentModel).where(AttachmentModel.id == attachment_id))
    if existing is not None:
        if existing.user_id != user.id or existing.transaction_id != transaction_id:
            raise HTTPException(status_code=404, detail="Attachment not found")
        if existing.deleted_at is not None:
            raise HTTPException(status_code=410, detail="Attachment was deleted")
        response.status_code = status.HTTP_200_OK
        return _attachment_meta(existing)

    declared = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if declared not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported image type")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=422, detail="Empty upload")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Attachment is larger than 15 MB")
    sniffed = _sniff(data)
    if sniffed is None:
        raise HTTPException(status_code=422, detail="File content is not a supported image")

    tx = db.scalar(select(TransactionModel).where(
        TransactionModel.id == transaction_id,
        TransactionModel.user_id == user.id,
    ))
    if tx is None or tx.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Transaction not found")

    active = db.scalar(select(func.count(AttachmentModel.id)).where(
        AttachmentModel.transaction_id == transaction_id,
        AttachmentModel.user_id == user.id,
        AttachmentModel.deleted_at.is_(None),
    )) or 0
    if active >= MAX_ATTACHMENTS_PER_TX:
        raise HTTPException(status_code=422, detail=f"Maximum {MAX_ATTACHMENTS_PER_TX} attachments per transaction")

    row = AttachmentModel(
        id=attachment_id,
        transaction_id=transaction_id,
        user_id=user.id,
        attachment_type=attachment_type,
        page_index=page_index,
        content_type=sniffed,
        size_bytes=len(data),
        width=width,
        height=height,
        data=data,
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Two concurrent retries of the same upload: the other one stored it; report that row.
        db.rollback()
        stored = db.scalar(select(AttachmentModel).where(AttachmentModel.id == attachment_id, AttachmentModel.user_id == user.id))
        if stored is None:
            raise HTTPException(status_code=404, detail="Attachment not found")
        response.status_code = status.HTTP_200_OK
        return _attachment_meta(stored)
    response.status_code = status.HTTP_201_CREATED
    return _attachment_meta(row)


@router.get("/attachments")
def list_attachments(
    transaction_id: UUID,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Active attachments of one of the caller's transactions, plus deleted ids (so other devices drop them)."""
    rows = db.scalars(
        select(AttachmentModel).where(
            AttachmentModel.transaction_id == transaction_id,
            AttachmentModel.user_id == user.id,
        ).order_by(AttachmentModel.page_index.asc(), AttachmentModel.created_at.asc())
    ).all()
    return {
        "attachments": [_attachment_meta(r) for r in rows if r.deleted_at is None],
        "deleted_ids": [str(r.id) for r in rows if r.deleted_at is not None],
    }


@router.get("/attachments/{attachment_id}")
def download_attachment(
    attachment_id: UUID,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The original bytes, only for the owner. Another user's or a deleted attachment is "not found"."""
    row = db.scalar(select(AttachmentModel).where(
        AttachmentModel.id == attachment_id,
        AttachmentModel.user_id == user.id,
        AttachmentModel.deleted_at.is_(None),
    ))
    if row is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return Response(content=row.data, media_type=row.content_type, headers={"Cache-Control": "private, no-store"})


@router.delete("/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_attachment(
    attachment_id: UUID,
    user: UserModel = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    """
    Idempotent delete. Keeps a tombstone (a stale retry cannot re-create it, and other devices learn about it)
    and clears the stored bytes. Unknown ids and other users' ids are a no-op 204 that changes nothing.
    """
    row = db.scalar(select(AttachmentModel).where(
        AttachmentModel.id == attachment_id,
        AttachmentModel.user_id == user.id,
    ))
    if row is not None and row.deleted_at is None:
        row.deleted_at = datetime.now(timezone.utc)
        row.data = b""
        row.size_bytes = 0
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ==============================================================================
# Single-receipt endpoints (legacy, unchanged)
# ==============================================================================

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
