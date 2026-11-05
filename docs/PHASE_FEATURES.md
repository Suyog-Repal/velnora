# Velnora feature set: guest mode, details sheet, receipts, categories, aliases, budgets, analytics, location

## Data model (local SQLite migrations v3 and v4, additive)
- `transactions`: `merchant_phone` (E.164), `payment_method`, `receipt_local_path` (device-private, never synced), `receipt_remote_id`,
  `receipt_upload_pending`, `location_lat/lng/name/address/confirmed`.
- `categories`: `color`, `archived_at`, `is_custom` (custom categories are owned by one account, or by the guest scope).
- New tables: `merchant_aliases` (per user, exact normalized key), `budgets` (integer paise; `category` NULL = overall).
- `sync_queue` is rebuilt (copy, drop, rename) to allow `budget` and `merchant_alias` entities; existing rows are preserved.
- Backend: Alembic `d3a9b7c2e1f4` adds the matching nullable columns and the `merchant_aliases`, `budgets`, `receipts` tables.

## Sync
The existing engine is extended, not duplicated: transactions carry the new fields; categories, budgets and merchant aliases use the same
queue, ownership checks, retry/backoff and acknowledgement rules. Receipt images upload (`POST /api/v1/receipts`) only after the transaction
itself is on the server; the remote id is then saved and synced as ordinary transaction metadata. Guest data is never uploaded until the
user confirms the import after signing in.

## OpenStreetMap provider limits and configuration
- Map tiles come from `tile.openstreetmap.org` through Leaflet 1.9.4 (loaded from unpkg inside a WebView). The OSM Tile Usage Policy applies:
  attribution is shown, usage must be light and interactive; bulk downloading or offline tile caching is not allowed.
- Place search and reverse geocoding use Nominatim (`nominatim.openstreetmap.org`): maximum 1 request/second, identifying `User-Agent`,
  no autocomplete, results may be cached. The app only searches when the user submits and throttles requests to one per 1.1 s.
- There is no SLA and no guaranteed capacity. For production traffic, use a self-hosted Nominatim/tile server or a commercial OSM-based
  provider and change `NOMINATIM`/tile URL in `src/screens/LocationPicker.tsx`. No API key is needed for the public servers.
- Location permission (foreground only) is requested only when the user taps "Use my location". There is no background location and no
  tracking. Location is never set automatically from the phone's position.

## OCR
Receipt text is read on the device with Google ML Kit text recognition (`@react-native-ml-kit/text-recognition`, free, offline). The result is
a suggestion only: totals prefer "grand total / amount payable" lines and never fall back to "the last number"; ambiguous or missing values are
flagged for the user and nothing is saved without confirmation.

## Receipt storage
Images are copied into the app's private `documentDirectory/receipts/`. On the server they are stored in the application database (max 5 MB,
JPEG/PNG/WebP, content sniffed) and only the owning user can read or delete them. No external storage service is used.

## Expected payments ("who owes me")
- Local table `expected_payments` (migration v5) and backend table `expected_payments` (Alembic `e5b2c8d4a7f1`); syncs through the same queue as
  budgets and merchant names (`entity_type = 'expected_payment'`).
- Each item has a person, direction (`receive` = they pay me, `pay` = I pay them), amount and paid amount (integer paise), an optional
  reason/note and due date, a status (`pending`/`settled`) and a payment history.
- A payment can be recorded by hand (optionally also creating the income/expense transaction) or arrives on its own: when an incoming
  transaction (SMS or manual) has the *exact* same normalized name and the *exact* outstanding amount, the item is settled and linked.
  Anything fuzzier (different amount, similar name) is never auto-linked: manual entry asks, SMS leaves it for the user.
- Overdue = pending with a due date before today.

## People
Aggregates (sum and count of incoming/outgoing, net) are computed from saved transactions in integer paise. People are grouped by exact
normalized name. Tapping a person opens their full history with All/Incoming/Outgoing and All time/This month filters.

## OCR details
Dates: numeric (day-first unless the digits prove month-first), ISO, "5 Nov 2026", "Nov 5, 2026", ordinals, 2-digit years, OCR digit
confusions (O/l for 0/1), and a time of day when present. Expiry/validity dates are ignored. Payment screenshots (UPI/bank): who was paid or
who paid, direction, reference/UTR and status are read; amounts are only taken from a total line or, on payment screens, the first
currency-marked amount. Images can come from the camera, the gallery or a file picker. PDFs are not read.

## Currency
The Currency setting changes the symbol and number format only. Velnora does not convert between currencies.
