-- 001 — integrity constraints and indexes on top of the provided database.sql.
-- Rationale for each change: README, section "Base de datos".
BEGIN;

-- orders: the database rejects what the application should never write.
ALTER TABLE orders
  ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN userid SET NOT NULL,
  ALTER COLUMN size SET NOT NULL,
  ALTER COLUMN price SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN side SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN datetime SET NOT NULL,
  -- Stored in UTC; the column type has no time zone. clock_timestamp(), not now():
  -- now() is the transaction start, before waiting on the user's lock, so an order
  -- that waited could get an earlier datetime than the one that executed first.
  ALTER COLUMN datetime SET DEFAULT (clock_timestamp() AT TIME ZONE 'utc'),
  ADD CONSTRAINT orders_size_positive CHECK (size > 0),
  ADD CONSTRAINT orders_price_positive CHECK (price > 0),
  ADD CONSTRAINT orders_side_valid CHECK (side IN ('BUY', 'SELL', 'CASH_IN', 'CASH_OUT')),
  ADD CONSTRAINT orders_type_valid CHECK (type IN ('MARKET', 'LIMIT')),
  ADD CONSTRAINT orders_status_valid CHECK (status IN ('NEW', 'FILLED', 'REJECTED', 'CANCELLED')),
  -- Client-supplied Idempotency-Key: a retried POST /orders returns the original order.
  ADD COLUMN idempotencykey varchar(64),
  -- sha256 of the request, to refuse a key reused with a different body.
  ADD COLUMN idempotencyhash char(64);

CREATE UNIQUE INDEX orders_userid_idempotencykey_key
  ON orders (userid, idempotencykey) WHERE idempotencykey IS NOT NULL;

-- Portfolio and order validation replay one user's orders chronologically.
CREATE INDEX orders_userid_datetime_idx ON orders (userid, datetime, id);

-- One price row per instrument per day; also serves "latest price per instrument".
ALTER TABLE marketdata
  ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN close SET NOT NULL,
  ALTER COLUMN previousclose SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ADD CONSTRAINT marketdata_instrumentid_date_key UNIQUE (instrumentid, date);

-- instruments: tickers are identifiers; search uses ILIKE '%q%', which only trigram indexes serve.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER TABLE instruments
  ALTER COLUMN ticker SET NOT NULL,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,
  ADD CONSTRAINT instruments_ticker_key UNIQUE (ticker);
CREATE INDEX instruments_ticker_trgm_idx ON instruments USING gin (ticker gin_trgm_ops);
CREATE INDEX instruments_name_trgm_idx ON instruments USING gin (name gin_trgm_ops);

COMMIT;
