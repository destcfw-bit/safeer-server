import pg from "pg";
import bcrypt from "bcryptjs";
import { normalizeWhatsappEventTimestamp } from "./whatsapp-timestamp.js";
import { sanitizeAuditDetails, systemSettingAuditSummary } from "./audit-security.js";
import { CLEAN_SLATE_OPERATIONAL_TABLES, CLEAN_SLATE_SETTING, CLEAN_SLATE_VERSION, buildCleanSlateState } from "./clean-slate-reset.js";
const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing");

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : undefined,
  max: Number(process.env.PG_POOL_MAX || 10),
  connectionTimeoutMillis:Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  query_timeout:Number(process.env.PG_QUERY_TIMEOUT_MS || 120000),
  statement_timeout:Number(process.env.PG_STATEMENT_TIMEOUT_MS || 110000)
});

export async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS captains (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','frozen','disabled')),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','accountant','captain')),
      captain_id BIGINT REFERENCES captains(id) ON DELETE SET NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );


    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;


    -- Legacy Apps Script migration metadata.
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS legacy_id TEXT;
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS payout_name TEXT;
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS payout_method TEXT;
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS payout_identifier TEXT;
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS balance_mode TEXT NOT NULL DEFAULT 'PREPAID';
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS protect_from_group_removal BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS group_state TEXT;
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS status_reason TEXT;
    ALTER TABLE captains ADD COLUMN IF NOT EXISTS legacy_last_login_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS captains_legacy_id_unique
      ON captains(legacy_id) WHERE legacy_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS captain_group_enforcement (
      captain_id BIGINT PRIMARY KEY REFERENCES captains(id) ON DELETE CASCADE,
      strike_count INTEGER NOT NULL DEFAULT 0,
      removed_from_group BOOLEAN NOT NULL DEFAULT FALSE,
      last_message_id TEXT,
      first_strike_at TIMESTAMPTZ,
      second_strike_at TIMESTAMPTZ,
      removed_at TIMESTAMPTZ,
      restored_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS captain_group_enforcement_removed_idx
      ON captain_group_enforcement(removed_from_group,updated_at DESC);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_legacy_id_unique
      ON users(legacy_id) WHERE legacy_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id BIGSERIAL PRIMARY KEY,
      captain_id BIGINT NOT NULL REFERENCES captains(id) ON DELETE RESTRICT,
      amount NUMERIC(12,3) NOT NULL,
      entry_type TEXT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      description TEXT,
      created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reversed_entry_id BIGINT REFERENCES ledger_entries(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Safe migrations for databases created by V2 Foundation.
    ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS direction TEXT;
    ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

    UPDATE ledger_entries
      SET direction = CASE WHEN amount >= 0 THEN 'credit' ELSE 'debit' END
      WHERE direction IS NULL;

    ALTER TABLE ledger_entries ALTER COLUMN direction SET NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='ledger_entries_direction_check'
      ) THEN
        ALTER TABLE ledger_entries
          ADD CONSTRAINT ledger_entries_direction_check
          CHECK (direction IN ('credit','debit'));
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS ledger_unique_reference
      ON ledger_entries(captain_id, entry_type, reference_type, reference_id)
      WHERE reference_id IS NOT NULL;


    CREATE UNIQUE INDEX IF NOT EXISTS ledger_legacy_reference_unique
      ON ledger_entries(reference_type,reference_id)
      WHERE reference_type IN ('legacy_sheet','migration_balance')
        AND reference_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS ledger_captain_created
      ON ledger_entries(captain_id, created_at DESC);

    -- V3.8.4: normalize old Google UNDO_OF rows into the same reversal model used by Railway.
    -- Balance is unchanged because amounts are untouched; only report semantics are unified.
    UPDATE ledger_entries reversal
       SET entry_type='REVERSAL',
           reversed_entry_id=original.id,
           metadata=COALESCE(reversal.metadata,'{}'::jsonb) || jsonb_build_object(
             'originalEntryType',original.entry_type,'normalizedLegacyReversal',true
           )
      FROM ledger_entries original
     WHERE reversal.reference_type='legacy_sheet'
       AND original.reference_type='legacy_sheet'
       AND reversal.reversed_entry_id IS NULL
       AND original.reference_id = substring(COALESCE(reversal.description,'') from 'UNDO_OF:([^ ]+)');

    -- Older Railway versions inserted a REVERSAL row but did not mark the original row as
    -- reversed. Backfill every linked original after the legacy normalization above.
    UPDATE ledger_entries original
       SET reversed_at = reversal.created_at
      FROM ledger_entries reversal
     WHERE reversal.reversed_entry_id = original.id
       AND original.reversed_at IS NULL;


    CREATE TABLE IF NOT EXISTS recharge_portal_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      code_prefix TEXT NOT NULL,
      next_code_number BIGINT NOT NULL DEFAULT 1,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS recharge_codes (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      amount NUMERIC(12,3) NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','used','cancelled')),
      created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      used_by_captain_id BIGINT REFERENCES captains(id) ON DELETE SET NULL,
      used_ledger_entry_id BIGINT REFERENCES ledger_entries(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    );


    ALTER TABLE recharge_codes ADD COLUMN IF NOT EXISTS legacy_id TEXT;
    ALTER TABLE recharge_codes ADD COLUMN IF NOT EXISTS assigned_captain_id BIGINT REFERENCES captains(id) ON DELETE SET NULL;
    ALTER TABLE recharge_codes ADD COLUMN IF NOT EXISTS issued_by_portal_user_id BIGINT REFERENCES recharge_portal_users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS recharge_codes_assigned_captain_idx
      ON recharge_codes(assigned_captain_id,status,created_at DESC);
    CREATE INDEX IF NOT EXISTS recharge_codes_portal_issuer_idx
      ON recharge_codes(issued_by_portal_user_id,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS recharge_codes_legacy_id_unique
      ON recharge_codes(legacy_id) WHERE legacy_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS recharge_codes_status_idx
      ON recharge_codes(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS recharge_requests (
      id BIGSERIAL PRIMARY KEY,
      captain_id BIGINT NOT NULL REFERENCES captains(id) ON DELETE RESTRICT,
      amount NUMERIC(12,3) NOT NULL CHECK (amount > 0),
      method TEXT,
      reference_text TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      ledger_entry_id BIGINT REFERENCES ledger_entries(id) ON DELETE SET NULL
    );


    ALTER TABLE recharge_requests ADD COLUMN IF NOT EXISTS legacy_id TEXT;
    ALTER TABLE recharge_requests ADD COLUMN IF NOT EXISTS legacy_image_url TEXT;
    ALTER TABLE recharge_requests ADD COLUMN IF NOT EXISTS legacy_code TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS recharge_requests_legacy_id_unique
      ON recharge_requests(legacy_id) WHERE legacy_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS recharge_requests_status_idx
      ON recharge_requests(status, created_at DESC);


    CREATE TABLE IF NOT EXISTS weekly_settlements (
      id BIGSERIAL PRIMARY KEY,
      week_start DATE NOT NULL,
      week_end DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','closed','archived')),
      created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      UNIQUE(week_start, week_end)
    );

    CREATE TABLE IF NOT EXISTS weekly_settlement_items (
      id BIGSERIAL PRIMARY KEY,
      settlement_id BIGINT NOT NULL REFERENCES weekly_settlements(id) ON DELETE CASCADE,
      captain_id BIGINT NOT NULL REFERENCES captains(id) ON DELETE RESTRICT,
      production NUMERIC(12,3) NOT NULL DEFAULT 0,
      consumption NUMERIC(12,3) NOT NULL DEFAULT 0,
      order_commission NUMERIC(12,3) NOT NULL DEFAULT 0,
      rider_commission NUMERIC(12,3) NOT NULL DEFAULT 0,
      recharge NUMERIC(12,3) NOT NULL DEFAULT 0,
      refund NUMERIC(12,3) NOT NULL DEFAULT 0,
      manual_adjustment NUMERIC(12,3) NOT NULL DEFAULT 0,
      net NUMERIC(12,3) NOT NULL DEFAULT 0,
      movement_count INTEGER NOT NULL DEFAULT 0,
      order_count INTEGER NOT NULL DEFAULT 0,
      rider_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'due'
        CHECK (status IN ('due','transferred','archived')),
      transferred_at TIMESTAMPTZ,
      transferred_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(settlement_id,captain_id)
    );


    ALTER TABLE weekly_settlement_items ADD COLUMN IF NOT EXISTS legacy_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS weekly_settlement_items_legacy_id_unique
      ON weekly_settlement_items(legacy_id) WHERE legacy_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS weekly_settlement_items_status_idx
      ON weekly_settlement_items(status, settlement_id);


    CREATE TABLE IF NOT EXISTS inventory_reconciliations (
      id BIGSERIAL PRIMARY KEY,
      business_date DATE NOT NULL,
      captain_id BIGINT NOT NULL REFERENCES captains(id) ON DELETE RESTRICT,
      manual_production_passengers INTEGER NOT NULL DEFAULT 0,
      manual_production_orders INTEGER NOT NULL DEFAULT 0,
      auto_production_passengers INTEGER NOT NULL DEFAULT 0,
      auto_production_orders INTEGER NOT NULL DEFAULT 0,
      added_passengers INTEGER NOT NULL DEFAULT 0,
      added_orders INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS inventory_reconciliations_date_captain_idx
      ON inventory_reconciliations(business_date,captain_id,created_at DESC);



    CREATE TABLE IF NOT EXISTS full_migration_runs (
      id BIGSERIAL PRIMARY KEY,
      run_key TEXT NOT NULL UNIQUE,
      spreadsheet_id TEXT,
      source_title TEXT,
      status TEXT NOT NULL DEFAULT 'uploading'
        CHECK(status IN ('uploading','uploaded','applying','completed','failed')),
      expected_sheets JSONB NOT NULL DEFAULT '[]'::jsonb,
      uploaded_sheets JSONB NOT NULL DEFAULT '{}'::jsonb,
      apply_phase TEXT NOT NULL DEFAULT 'captains',
      apply_offset INTEGER NOT NULL DEFAULT 0,
      apply_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_text TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      upload_completed_at TIMESTAMPTZ,
      apply_started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS full_migration_stage_rows (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES full_migration_runs(id) ON DELETE CASCADE,
      sheet_name TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      row_data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(run_id,sheet_name,row_number)
    );

    CREATE INDEX IF NOT EXISTS full_migration_stage_sheet_idx
      ON full_migration_stage_rows(run_id,sheet_name,row_number);

    ALTER TABLE full_migration_runs ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'full';
    ALTER TABLE full_migration_runs ADD COLUMN IF NOT EXISTS cutover_at TIMESTAMPTZ;
    ALTER TABLE full_migration_runs ADD COLUMN IF NOT EXISTS repair_from_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS migration_snapshots (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'google_sheets',
      spreadsheet_id TEXT,
      captain_count INTEGER NOT NULL DEFAULT 0,
      total_balance NUMERIC(16,3) NOT NULL DEFAULT 0,
      movement_count INTEGER NOT NULL DEFAULT 0,
      inventory_count INTEGER NOT NULL DEFAULT 0,
      source_updated_at TIMESTAMPTZ,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS migration_snapshots_received_idx
      ON migration_snapshots(received_at DESC);

    -- V3.3.2 operational feature tables.
    ALTER TABLE recharge_requests ADD COLUMN IF NOT EXISTS image_data BYTEA;
    ALTER TABLE recharge_requests ADD COLUMN IF NOT EXISTS image_mime TEXT;
    ALTER TABLE recharge_requests ADD COLUMN IF NOT EXISTS image_token TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS recharge_requests_image_token_unique
      ON recharge_requests(image_token) WHERE image_token IS NOT NULL;

    ALTER TABLE weekly_settlement_items ADD COLUMN IF NOT EXISTS amount_due NUMERIC(12,3) NOT NULL DEFAULT 0;
    ALTER TABLE weekly_settlement_items ADD COLUMN IF NOT EXISTS reserve_amount NUMERIC(12,3) NOT NULL DEFAULT 0;
    ALTER TABLE weekly_settlement_items ADD COLUMN IF NOT EXISTS balance_before NUMERIC(12,3);
    ALTER TABLE weekly_settlement_items ADD COLUMN IF NOT EXISTS balance_after NUMERIC(12,3);
    ALTER TABLE weekly_settlement_items ADD COLUMN IF NOT EXISTS payment_note TEXT;
    ALTER TABLE weekly_settlement_items ADD COLUMN IF NOT EXISTS friday_debit_entry_id BIGINT REFERENCES ledger_entries(id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS system_issues (
      id BIGSERIAL PRIMARY KEY,
      dedup_key TEXT UNIQUE,
      origin TEXT NOT NULL DEFAULT 'SYSTEM',
      issue_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'WARNING',
      status TEXT NOT NULL DEFAULT 'OPEN',
      source_id TEXT,
      related_id TEXT,
      summary TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      suggested_action TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      resolution_note TEXT
    );
    CREATE INDEX IF NOT EXISTS system_issues_status_idx ON system_issues(status,severity,created_at DESC);

    CREATE TABLE IF NOT EXISTS whatsapp_pending_movements (
      id BIGSERIAL PRIMARY KEY,
      whatsapp_message_id TEXT,
      group_id TEXT,
      sender_phone TEXT,
      sender_name TEXT,
      captain_id BIGINT REFERENCES captains(id) ON DELETE SET NULL,
      source_type TEXT,
      transcript TEXT,
      direction TEXT,
      movement_type TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      error TEXT,
      reviewed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      ledger_entry_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pending_movement_message_unique
      ON whatsapp_pending_movements(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS inventory_cancellation_numbers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      updated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory_reaction_cancellations (
      id BIGSERIAL PRIMARY KEY,
      done_message_id TEXT NOT NULL,
      original_message_id TEXT,
      reaction_message_id TEXT,
      authorized_phone TEXT,
      authorized_name TEXT,
      status TEXT NOT NULL DEFAULT 'LOCKED',
      mode TEXT NOT NULL DEFAULT 'FULL',
      producer_id BIGINT REFERENCES captains(id) ON DELETE SET NULL,
      consumer_id BIGINT REFERENCES captains(id) ON DELETE SET NULL,
      movement_type TEXT,
      original_quantity INTEGER,
      cancel_quantity INTEGER NOT NULL DEFAULT 0,
      remaining_quantity INTEGER,
      delta_quantity INTEGER,
      reversed_ledger_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reopened_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      reopened_at TIMESTAMPTZ,
      reopen_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS reaction_cancel_done_idx ON inventory_reaction_cancellations(done_message_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS friday_group_sessions (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'IDLE',
      period_key TEXT,
      requested_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      requested_by TEXT,
      group_id TEXT,
      group_name TEXT,
      group_open BOOLEAN,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deadline_at TIMESTAMPTZ,
      cutoff_at TIMESTAMPTZ,
      close_attempts INTEGER NOT NULL DEFAULT 0,
      producers INTEGER NOT NULL DEFAULT 0,
      total_due NUMERIC(12,3) NOT NULL DEFAULT 0,
      cleanup_removed INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      final_note TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS whatsapp_cleanup_sessions (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'IDLE',
      group_open BOOLEAN,
      removed INTEGER NOT NULL DEFAULT 0,
      kept INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      final_note TEXT,
      started_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Older builds copied complete provider settings (including API/OpenAI
    -- keys and webhook secrets) into audit_logs. Remove those historical
    -- values once; the current audit format no longer writes a value field.
    UPDATE audit_logs
       SET details='{"changed":true,"legacySecretValueRemoved":true}'::jsonb
     WHERE action='system_setting.update'
       AND entity_id IN ('green_api','waha_api','green_webhook_secret','waha_webhook_secret')
       AND details ? 'value';

    CREATE TABLE IF NOT EXISTS whatsapp_events (
      id BIGSERIAL PRIMARY KEY,
      id_message TEXT NOT NULL UNIQUE,
      webhook_type TEXT,
      chat_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      message_type TEXT,
      message_text TEXT,
      event_timestamp BIGINT,
      webhook_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      queued_at TIMESTAMPTZ,
      processing_started_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'received',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      raw_payload JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_events_status
      ON whatsapp_events(status);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_events_received_at
      ON whatsapp_events(webhook_received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_events_chat_id_id
      ON whatsapp_events(chat_id,id DESC);

    ALTER TABLE whatsapp_events ADD COLUMN IF NOT EXISTS duplicate_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE whatsapp_events ADD COLUMN IF NOT EXISTS last_duplicate_at TIMESTAMPTZ;
    ALTER TABLE whatsapp_events ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE whatsapp_events ADD COLUMN IF NOT EXISTS last_replayed_at TIMESTAMPTZ;
    ALTER TABLE whatsapp_events ADD COLUMN IF NOT EXISTS processing_mode TEXT;

    -- Safe parallel trial ledger. Automatic WhatsApp calculations live here and
    -- never touch ledger_entries or captain balances while manual inventory is authoritative.
    CREATE TABLE IF NOT EXISTS whatsapp_comparison_jobs (
      done_message_id TEXT PRIMARY KEY,
      canonical_done_id TEXT,
      original_message_id TEXT,
      canonical_original_id TEXT,
      reaction_message_id TEXT,
      producer_id BIGINT NOT NULL REFERENCES captains(id) ON DELETE RESTRICT,
      consumer_id BIGINT NOT NULL REFERENCES captains(id) ON DELETE RESTRICT,
      passenger_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      order_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      effective_passenger_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      effective_order_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      partial_cancel_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
      request_text TEXT,
      event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      cancel_reason TEXT,
      cancelled_by_event_id TEXT,
      cancelled_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_comparison_jobs_canonical_unique
      ON whatsapp_comparison_jobs(canonical_done_id)
      WHERE canonical_done_id IS NOT NULL AND canonical_done_id<>'';
    CREATE INDEX IF NOT EXISTS whatsapp_comparison_jobs_period_idx
      ON whatsapp_comparison_jobs(event_at DESC,status);
    CREATE INDEX IF NOT EXISTS whatsapp_comparison_jobs_original_idx
      ON whatsapp_comparison_jobs(canonical_original_id,updated_at DESC);

    CREATE TABLE IF NOT EXISTS whatsapp_comparison_locks (
      target_message_id TEXT PRIMARY KEY,
      canonical_target_id TEXT,
      lock_type TEXT NOT NULL,
      event_id TEXT,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_comparison_locks_canonical_unique
      ON whatsapp_comparison_locks(canonical_target_id)
      WHERE canonical_target_id IS NOT NULL AND canonical_target_id<>'';

    CREATE TABLE IF NOT EXISTS whatsapp_delete_everyone_markers (
      target_message_id TEXT PRIMARY KEY,
      canonical_target_id TEXT,
      first_delete_event_id TEXT,
      last_delete_event_id TEXT,
      delete_count INTEGER NOT NULL DEFAULT 1,
      reversed_count INTEGER NOT NULL DEFAULT 0,
      related_done_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      comparison_mode BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS whatsapp_delete_everyone_canonical_idx
      ON whatsapp_delete_everyone_markers(canonical_target_id,updated_at DESC);

    CREATE TABLE IF NOT EXISTS whatsapp_dead_letters (
      id BIGSERIAL PRIMARY KEY,
      id_message TEXT NOT NULL UNIQUE,
      payload JSONB NOT NULL,
      last_error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','replayed','resolved')),
      failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      replayed_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      resolved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS whatsapp_dead_letters_status_idx
      ON whatsapp_dead_letters(status, failed_at DESC);

    CREATE TABLE IF NOT EXISTS whatsapp_event_traces (
      id BIGSERIAL PRIMARY KEY,
      id_message TEXT NOT NULL,
      stage TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS whatsapp_event_traces_message_idx
      ON whatsapp_event_traces(id_message, created_at DESC);

    CREATE TABLE IF NOT EXISTS whatsapp_repair_runs (
      id BIGSERIAL PRIMARY KEY,
      run_key TEXT NOT NULL UNIQUE,
      from_at TIMESTAMPTZ NOT NULL,
      cutoff_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUING'
        CHECK (status IN ('QUEUING','RUNNING','COMPLETED','FAILED','CANCELLED')),
      total_events INTEGER NOT NULL DEFAULT 0,
      snapshot_max_event_id BIGINT NOT NULL DEFAULT 0,
      queued_events INTEGER NOT NULL DEFAULT 0,
      processed_events INTEGER NOT NULL DEFAULT 0,
      repaired_events INTEGER NOT NULL DEFAULT 0,
      duplicate_events INTEGER NOT NULL DEFAULT 0,
      preserved_deleted_jobs INTEGER NOT NULL DEFAULT 0,
      failed_events INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      started_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE whatsapp_repair_runs ADD COLUMN IF NOT EXISTS snapshot_max_event_id BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE whatsapp_repair_runs ADD COLUMN IF NOT EXISTS time_basis TEXT NOT NULL DEFAULT 'event';

    CREATE INDEX IF NOT EXISTS whatsapp_repair_runs_status_idx
      ON whatsapp_repair_runs(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS legacy_week_bridge_runs (
      id BIGSERIAL PRIMARY KEY,
      run_key TEXT NOT NULL UNIQUE,
      from_at TIMESTAMPTZ NOT NULL,
      cutoff_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'UPLOADING'
        CHECK (status IN ('UPLOADING','READY','REPAIR_RUNNING','COMPLETED','FAILED','CANCELLED')),
      source_spreadsheet_id TEXT,
      received_rows INTEGER NOT NULL DEFAULT 0,
      inserted_events INTEGER NOT NULL DEFAULT 0,
      duplicate_events INTEGER NOT NULL DEFAULT 0,
      invalid_events INTEGER NOT NULL DEFAULT 0,
      balance_sync_rows INTEGER NOT NULL DEFAULT 0,
      balance_sync_delta NUMERIC(14,3) NOT NULL DEFAULT 0,
      repair_run_id BIGINT REFERENCES whatsapp_repair_runs(id) ON DELETE SET NULL,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS legacy_week_bridge_runs_status_idx
      ON legacy_week_bridge_runs(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // V3.8.5.77 — one-time quality-center reset. This clears only historical
  // system issue cards when this version is deployed for the first time.
  // It does NOT touch ledger entries, WhatsApp events, balances, reactions,
  // audit logs, or any accounting data. Future issues can still be created.
  await db.query(`
    WITH marker AS (
      INSERT INTO system_settings(key,value)
      VALUES('quality_center_reset_v38577',$1::jsonb)
      ON CONFLICT(key) DO NOTHING
      RETURNING key
    )
    DELETE FROM system_issues
    WHERE EXISTS (SELECT 1 FROM marker)
  `,[JSON.stringify({clearedAt:new Date().toISOString(),version:'3.8.5.77'})]);

  await ensureInitialAdmin();
  await ensureRechargePortalUsers();
}

async function ensureInitialAdmin() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  const existing = await db.query(`SELECT id FROM users WHERE username=$1`, [username]);
  if (existing.rowCount) return;

  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO users(username,password_hash,role) VALUES($1,$2,'admin')`,
    [username, hash]
  );
}

async function ensureRechargePortalUsers() {
  const defaults = [
    {
      username:String(process.env.RECHARGE_PORTAL_FARES_USERNAME || "F1").trim(),
      password:String(process.env.RECHARGE_PORTAL_FARES_PASSWORD || ""),
      displayName:String(process.env.RECHARGE_PORTAL_FARES_NAME || "فارس").trim(),
      prefix:String(process.env.RECHARGE_PORTAL_FARES_PREFIX || "F1").trim().toUpperCase()
    },
    {
      username:String(process.env.RECHARGE_PORTAL_QADRI_USERNAME || "Q1").trim(),
      password:String(process.env.RECHARGE_PORTAL_QADRI_PASSWORD || ""),
      displayName:String(process.env.RECHARGE_PORTAL_QADRI_NAME || "قدري").trim(),
      prefix:String(process.env.RECHARGE_PORTAL_QADRI_PREFIX || "Q1").trim().toUpperCase()
    },
    {
      username:String(process.env.RECHARGE_PORTAL_T1_USERNAME || "T1").trim(),
      password:String(process.env.RECHARGE_PORTAL_T1_PASSWORD || ""),
      displayName:String(process.env.RECHARGE_PORTAL_T1_NAME || "T1").trim(),
      prefix:String(process.env.RECHARGE_PORTAL_T1_PREFIX || "T1").trim().toUpperCase()
    },
    {
      username:String(process.env.RECHARGE_PORTAL_A1_USERNAME || "A1").trim(),
      password:String(process.env.RECHARGE_PORTAL_A1_PASSWORD || ""),
      displayName:String(process.env.RECHARGE_PORTAL_A1_NAME || "A1").trim(),
      prefix:String(process.env.RECHARGE_PORTAL_A1_PREFIX || "A1").trim().toUpperCase()
    }
  ];

  for (const item of defaults) {
    if (!item.username || !item.password || !item.prefix) continue;
    if (item.password.length < 8 || item.password === "12345678") {
      console.warn(`Recharge portal user ${item.username} was not provisioned: configure a non-default password of at least 8 characters.`);
      continue;
    }
    const exists = await db.query(`SELECT id,password_hash FROM recharge_portal_users WHERE username=$1`, [item.username]);
    if (exists.rowCount) {
      // Environment variables are the supported rotation mechanism for these
      // fixed portal accounts. Update only when the configured password changed.
      if (!(await bcrypt.compare(item.password,exists.rows[0].password_hash))) {
        const hash=await bcrypt.hash(item.password,12);
        await db.query(`UPDATE recharge_portal_users SET password_hash=$2,updated_at=NOW() WHERE id=$1`,[exists.rows[0].id,hash]);
      }
      continue;
    }
    const hash = await bcrypt.hash(item.password, 12);
    await db.query(`
      INSERT INTO recharge_portal_users(username,password_hash,display_name,code_prefix)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(username) DO NOTHING
    `, [item.username,hash,item.displayName || item.username,item.prefix]);
  }
}

export async function findUserByUsername(username) {
  const value = String(username || "").trim();
  const phoneDigits = normalizeJordanPhone(value);

  const r = await db.query(`
    SELECT u.id,u.username,u.password_hash,u.role,u.captain_id,u.is_active
    FROM users u
    LEFT JOIN captains c ON c.id=u.captain_id
    WHERE u.username=$1
       OR (
         u.role='captain'
         AND length($2::text)>=8
         AND RIGHT(regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g'),9)=RIGHT($2::text,9)
       )
    ORDER BY CASE WHEN u.username=$1 THEN 0 ELSE 1 END
    LIMIT 1
  `, [value,phoneDigits]);

  return r.rows[0] || null;
}

export async function getUserPublic(id) {
  const r = await db.query(
    `SELECT id,username,role,captain_id,is_active FROM users WHERE id=$1`,
    [id]
  );
  return r.rows[0] || null;
}


export async function findRechargePortalUserByUsername(username) {
  const r=await db.query(`
    SELECT id,username,password_hash,display_name,code_prefix,next_code_number,is_active,last_login_at
    FROM recharge_portal_users
    WHERE lower(username)=lower($1)
    LIMIT 1
  `,[String(username||"").trim()]);
  return r.rows[0]||null;
}

export async function getRechargePortalUserPublic(id) {
  const r=await db.query(`
    SELECT id,username,display_name,code_prefix,is_active,last_login_at
    FROM recharge_portal_users WHERE id=$1
  `,[id]);
  return r.rows[0]||null;
}

export async function touchRechargePortalUserLogin(id) {
  await db.query(`UPDATE recharge_portal_users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1`,[id]);
}

export async function searchRechargePortalCaptains(search="",limit=30) {
  const value=String(search||"").trim();
  const like=`%${value}%`;
  const safeLimit=Math.min(50,Math.max(1,Number(limit)||30));
  const r=await db.query(`
    SELECT c.id,c.name,c.phone,c.legacy_id,c.status,c.group_state,
           COALESCE(SUM(le.amount),0)::numeric(12,3) AS balance
    FROM captains c
    LEFT JOIN ledger_entries le ON le.captain_id=c.id
    WHERE ($1='' OR c.name ILIKE $2 OR c.phone ILIKE $2 OR COALESCE(c.legacy_id,'') ILIKE $2)
    GROUP BY c.id
    ORDER BY CASE WHEN c.name ILIKE $2 THEN 0 ELSE 1 END,c.name ASC
    LIMIT $3
  `,[value,like,safeLimit]);
  return r.rows;
}

function rechargePortalAllowedAmounts(username){
  const u=String(username||"").trim().toUpperCase();
  return (u==="A1"||u==="Q1") ? [0.5,1,5,10,15,20,30] : [10,15,20,30];
}
function rechargePortalCanCustomAmount(username){
  return String(username||"").trim().toUpperCase()==="T1";
}
function rechargePortalAmountAllowed(username,value){
  const amount=Number(value);
  if(!Number.isFinite(amount)||amount<=0||amount>999999999.999)return false;
  if(rechargePortalCanCustomAmount(username)){
    const rounded=Math.round(amount*1000)/1000;
    return Math.abs(amount-rounded)<1e-9;
  }
  return rechargePortalAllowedAmounts(username).includes(amount);
}

export async function createRechargePortalCode({portalUserId,captainId,packageValue}) {
  const amount=Number(packageValue);
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const issuer=await client.query(`
      SELECT id,username,display_name,code_prefix,next_code_number,is_active
      FROM recharge_portal_users WHERE id=$1 FOR UPDATE
    `,[portalUserId]);
    if (!issuer.rowCount || !issuer.rows[0].is_active) {
      throw Object.assign(new Error("not_authenticated"),{statusCode:401});
    }
    if (!rechargePortalAmountAllowed(issuer.rows[0].username,amount)) {
      throw Object.assign(new Error("invalid_request"),{statusCode:400});
    }
    const captain=await client.query(`SELECT id,name,phone FROM captains WHERE id=$1`,[captainId]);
    if (!captain.rowCount) throw Object.assign(new Error("captain_not_found"),{statusCode:404});

    let next=Math.max(1,Number(issuer.rows[0].next_code_number||1));
    let created=null;
    for(let attempt=0;attempt<100;attempt++,next++){
      const code=`${String(issuer.rows[0].code_prefix||issuer.rows[0].username).toUpperCase()}-${String(next).padStart(6,"0")}`;
      try {
        const q=await client.query(`
          INSERT INTO recharge_codes(code,amount,assigned_captain_id,issued_by_portal_user_id)
          VALUES($1,$2,$3,$4)
          RETURNING *
        `,[code,amount,captainId,portalUserId]);
        created=q.rows[0];
        next+=1;
        break;
      } catch(e) {
        if(e.code!=="23505") throw e;
      }
    }
    if(!created) throw Object.assign(new Error("code_generation_failed"),{statusCode:500});
    await client.query(`UPDATE recharge_portal_users SET next_code_number=$2,updated_at=NOW() WHERE id=$1`,[portalUserId,next]);
    await client.query("COMMIT");
    await audit(null,"recharge_portal.code.create","recharge_code",created.id,{
      portalUserId:String(portalUserId),issuer:issuer.rows[0].username,captainId:String(captainId),amount,code:created.code
    });
    return {
      id:String(created.id),code:created.code,package_value:Number(created.amount),status:"UNUSED",
      captain_id:String(captain.rows[0].id),captain_name:captain.rows[0].name,captain_phone:captain.rows[0].phone,
      issued_by_username:issuer.rows[0].username,issued_by_name:issuer.rows[0].display_name,issued_at:created.created_at,used_at:null
    };
  } catch(e) {
    try{await client.query("ROLLBACK")}catch{}
    throw e;
  } finally {client.release()}
}

export async function listRechargePortalCodes({portalUserId,q="",status="",limit=250}={}) {
  const text=String(q||"").trim();
  const like=`%${text}%`;
  const map={UNUSED:"active",USED:"used",CANCELLED:"cancelled"};
  const dbStatus=map[String(status||"").toUpperCase()]||"";
  const safeLimit=Math.min(500,Math.max(1,Number(limit)||250));
  const r=await db.query(`
    SELECT rc.id,rc.code,rc.amount,rc.status,rc.created_at,rc.used_at,
           c.id AS captain_id,c.name AS captain_name,c.phone AS captain_phone,
           pu.username AS issued_by_username,pu.display_name AS issued_by_name
    FROM recharge_codes rc
    JOIN recharge_portal_users pu ON pu.id=rc.issued_by_portal_user_id
    LEFT JOIN captains c ON c.id=COALESCE(rc.assigned_captain_id,rc.used_by_captain_id)
    WHERE rc.issued_by_portal_user_id=$1
      AND ($2='' OR rc.status=$2)
      AND ($3='' OR rc.code ILIKE $4 OR COALESCE(c.name,'') ILIKE $4 OR COALESCE(c.phone,'') ILIKE $4)
    ORDER BY rc.created_at DESC
    LIMIT $5
  `,[portalUserId,dbStatus,text,like,safeLimit]);
  return r.rows.map(row=>({
    id:String(row.id),code:row.code,package_value:Number(row.amount),
    status:row.status==="active"?"UNUSED":row.status==="used"?"USED":"CANCELLED",
    captain_id:row.captain_id?String(row.captain_id):"",captain_name:row.captain_name||"",captain_phone:row.captain_phone||"",
    issued_by_username:row.issued_by_username,issued_by_name:row.issued_by_name,issued_at:row.created_at,used_at:row.used_at
  }));
}

export async function getRechargePortalStats(portalUserId) {
  const r=await db.query(`
    SELECT
      COUNT(*) FILTER(WHERE status='active')::int AS unused_count,
      COUNT(*) FILTER(WHERE status='used')::int AS used_count,
      COALESCE(SUM(amount) FILTER(WHERE status='active'),0)::numeric(12,3) AS unused_value,
      COALESCE(SUM(amount) FILTER(WHERE created_at >= date_trunc('day',NOW() AT TIME ZONE 'Asia/Amman') AT TIME ZONE 'Asia/Amman'),0)::numeric(12,3) AS today_value
    FROM recharge_codes
    WHERE issued_by_portal_user_id=$1
  `,[portalUserId]);
  const x=r.rows[0]||{};
  return {unused_count:Number(x.unused_count||0),used_count:Number(x.used_count||0),unused_value:Number(x.unused_value||0),today_value:Number(x.today_value||0)};
}


export async function touchUserLogin(userId) {
  await db.query(`UPDATE users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1`, [userId]);
}

export async function listStaffUsers() {
  const r=await db.query(`
    SELECT id,username,display_name,role,is_active,created_at,updated_at,last_login_at
    FROM users
    WHERE role IN ('admin','accountant')
    ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END, username
  `);
  return r.rows;
}

async function ensureCanChangeAdmin(client,userId,nextRole,nextActive) {
  const current=await client.query(`SELECT id,role,is_active FROM users WHERE id=$1 FOR UPDATE`,[userId]);
  if(!current.rowCount) throw Object.assign(new Error("user_not_found"),{statusCode:404});
  const u=current.rows[0];
  const removesAdmin=u.role==='admin' && u.is_active && (nextRole!=='admin' || nextActive===false);
  if(removesAdmin){
    const cnt=await client.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND is_active=TRUE AND id<>$1`,[userId]);
    if(Number(cnt.rows[0]?.n||0)<1){
      throw Object.assign(new Error("cannot_remove_last_admin"),{statusCode:409});
    }
  }
  return u;
}

export async function createStaffUser({username,password,role='accountant',displayName,createdBy}) {
  const cleanRole=String(role)==='admin'?'admin':'accountant';
  const cleanUsername=String(username||"").trim();
  const cleanPassword=String(password||"");
  if(!cleanUsername) throw Object.assign(new Error("username_required"),{statusCode:400});
  if(cleanPassword.length<8) throw Object.assign(new Error("password_too_short"),{statusCode:400});
  const hash=await bcrypt.hash(cleanPassword,12);
  try{
    const r=await db.query(`
      INSERT INTO users(username,password_hash,role,captain_id,is_active,display_name)
      VALUES($1,$2,$3,NULL,TRUE,$4)
      RETURNING id,username,display_name,role,is_active,created_at,updated_at,last_login_at
    `,[cleanUsername,hash,cleanRole,displayName||null]);
    await audit(createdBy,"staff_user.create","user",r.rows[0].id,{username:cleanUsername,role:cleanRole,displayName:displayName||null});
    return r.rows[0];
  }catch(e){
    if(e.code==="23505") throw Object.assign(new Error("username_already_exists"),{statusCode:409});
    throw e;
  }
}

export async function updateStaffUser({id,role,displayName,isActive,password,updatedBy}) {
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const current=await client.query(`
      SELECT id,username,display_name,role,is_active FROM users
      WHERE id=$1 AND role IN ('admin','accountant')
      FOR UPDATE
    `,[id]);
    if(!current.rowCount) throw Object.assign(new Error("staff_user_not_found"),{statusCode:404});
    const u=current.rows[0];
    const nextRole=role===undefined?u.role:(String(role)==='admin'?'admin':'accountant');
    const nextActive=isActive===undefined?u.is_active:Boolean(isActive);
    await ensureCanChangeAdmin(client,id,nextRole,nextActive);

    let passwordHash=null;
    if(password!==undefined && String(password)!==""){
      if(String(password).length<8) throw Object.assign(new Error("password_too_short"),{statusCode:400});
      passwordHash=await bcrypt.hash(String(password),12);
    }

    const r=await client.query(`
      UPDATE users SET
        role=$2,
        display_name=$3,
        is_active=$4,
        password_hash=COALESCE($5,password_hash),
        updated_at=NOW()
      WHERE id=$1
      RETURNING id,username,display_name,role,is_active,created_at,updated_at,last_login_at
    `,[id,nextRole,displayName===undefined?u.display_name:(displayName||null),nextActive,passwordHash]);

    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'staff_user.update','user',$2,$3::jsonb)
    `,[updatedBy||null,String(id),JSON.stringify({
      before:{role:u.role,isActive:u.is_active,displayName:u.display_name},
      after:{role:nextRole,isActive:nextActive,displayName:displayName===undefined?u.display_name:(displayName||null)},
      passwordChanged:Boolean(passwordHash)
    })]);

    await client.query("COMMIT");
    return r.rows[0];
  }catch(e){
    await client.query("ROLLBACK");
    throw e;
  }finally{client.release()}
}

export async function getSystemSetting(key, fallback=null) {
  const r=await db.query(`SELECT value FROM system_settings WHERE key=$1`,[String(key)]);
  return r.rowCount?r.rows[0].value:fallback;
}

export async function setSystemSetting(key,value,userId=null) {
  const r=await db.query(`
    INSERT INTO system_settings(key,value,updated_by_user_id)
    VALUES($1,$2::jsonb,$3)
    ON CONFLICT(key) DO UPDATE SET
      value=EXCLUDED.value,
      updated_by_user_id=EXCLUDED.updated_by_user_id,
      updated_at=NOW()
    RETURNING *
  `,[String(key),JSON.stringify(value),userId||null]);
  // Keep the audit event without copying API keys, webhook secrets, or tokens
  // from system_settings into a second long-lived table.
  await audit(userId,"system_setting.update","system_setting",key,systemSettingAuditSummary(value));
  return r.rows[0];
}

// V3.8.5.29 CAPTAIN SITE MAINTENANCE ---------------------------------------
// This state closes only the captain-facing site. The accountant and recharge
// portal remain available so maintenance can be managed and balances can still
// be recharged when needed.
const CAPTAIN_SITE_MAINTENANCE_SETTING="captain_site_maintenance_v1";

function captainSiteMaintenanceDefaultState(){
  return {
    version:1,
    enabled:false,
    progress:0,
    message:"نعمل حاليًا على تحسين موقع الكباتن. سنعود للعمل قريبًا.",
    startedAt:null,
    finishedAt:null,
    updatedAt:null,
    updatedByUserId:null
  };
}

export async function getCaptainSiteMaintenanceState(){
  const stored=await getSystemSetting(CAPTAIN_SITE_MAINTENANCE_SETTING,null);
  const state={...captainSiteMaintenanceDefaultState(),...(stored&&typeof stored==="object"?stored:{})};
  state.enabled=state.enabled===true;
  state.progress=Math.max(0,Math.min(100,Math.round(Number(state.progress)||0)));
  state.message=String(state.message||captainSiteMaintenanceDefaultState().message).trim().slice(0,240);
  return state;
}

export async function setCaptainSiteMaintenanceState(patch={},userId=null){
  const current=await getCaptainSiteMaintenanceState();
  const now=new Date().toISOString();
  const enabled=patch.enabled===undefined?current.enabled:patch.enabled===true;
  const progress=patch.progress===undefined
    ? current.progress
    : Math.max(0,Math.min(100,Math.round(Number(patch.progress)||0)));
  const requestedMessage=patch.message===undefined?current.message:String(patch.message||"").trim();
  const message=(requestedMessage||captainSiteMaintenanceDefaultState().message).slice(0,240);
  const state={
    ...current,
    version:1,
    enabled,
    progress,
    message,
    startedAt:enabled?(current.enabled&&current.startedAt?current.startedAt:now):current.startedAt,
    finishedAt:!enabled&&current.enabled?now:current.finishedAt,
    updatedAt:now,
    updatedByUserId:userId?String(userId):null
  };
  await setSystemSetting(CAPTAIN_SITE_MAINTENANCE_SETTING,state,userId);
  return state;
}

// V3.8.5.28 CLEAN START ------------------------------------------------------
// The accountant requested one new accounting epoch. Historical ledger rows are
// never deleted: a single auditable adjustment per captain makes the current
// balance equal to actually redeemed/approved RECHARGE entries only. Old work is
// then hidden from operational views by resetAt.
const CLEAN_START_SETTING="clean_start_v1";

function cleanStartDefaultState(){
  return {
    version:2,
    status:"REQUIRED",
    automaticStatus:"STOPPED",
    resetAt:null,
    autoCutoverAt:null,
    resetByUserId:null,
    resetCount:0,
    epochId:null,
    summary:null
  };
}

export async function getCleanStartState(){
  const saved=await getSystemSetting(CLEAN_START_SETTING,null);
  return {...cleanStartDefaultState(),...(saved&&typeof saved==="object"?saved:{})};
}

export async function getCleanStartOperationalCutover(){
  const state=await getCleanStartState();
  return state.status==="COMPLETED"&&state.resetAt?state.resetAt:null;
}

export async function getCleanSlateResetState(){
  return await getSystemSetting(CLEAN_SLATE_SETTING,null);
}

export async function isCleanSlateResetRequired(){
  const state=await getCleanSlateResetState();
  return state?.status!=="COMPLETED"||state?.version!==CLEAN_SLATE_VERSION;
}

export async function executeOneTimeCleanSlateReset(){
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[CLEAN_SLATE_SETTING]);
    const existing=(await client.query(`SELECT value FROM system_settings WHERE key=$1 FOR UPDATE`,[CLEAN_SLATE_SETTING])).rows[0]?.value||null;
    if(existing?.status==="COMPLETED"&&existing?.version===CLEAN_SLATE_VERSION){
      await client.query("COMMIT");
      return {applied:false,alreadyCompleted:true,state:existing};
    }

    const before=(await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM captains) AS captains,
        (SELECT COUNT(*)::int FROM ledger_entries) AS ledger_entries,
        (SELECT COALESCE(SUM(amount),0)::numeric(16,3) FROM ledger_entries) AS total_balance,
        (SELECT COUNT(*)::int FROM (SELECT captain_id FROM ledger_entries GROUP BY captain_id HAVING ABS(SUM(amount))>=0.0005) b) AS nonzero_balances,
        (SELECT COUNT(*)::int FROM whatsapp_events) AS whatsapp_events,
        (SELECT COUNT(*)::int FROM inventory_reconciliations) AS inventory_reconciliations,
        (SELECT COUNT(*)::int FROM weekly_settlement_items) AS settlement_items,
        (SELECT COUNT(*)::int FROM recharge_codes) AS recharge_codes,
        (SELECT COUNT(*)::int FROM recharge_requests) AS recharge_requests
    `)).rows[0]||{};
    const previousClean=(await client.query(`SELECT value FROM system_settings WHERE key=$1`,[CLEAN_START_SETTING])).rows[0]?.value||{};
    const resetAt=new Date().toISOString();
    const cleanStart=buildCleanSlateState({resetAt,captainCount:before.captains,previousResetCount:previousClean.resetCount});

    await client.query(`TRUNCATE TABLE ${CLEAN_SLATE_OPERATIONAL_TABLES.join(",")} RESTART IDENTITY`);

    // Keep account identity/profile data, but make every captain immediately
    // usable in the fresh epoch. Group strikes/removal state was truncated.
    await client.query(`
      UPDATE captains
         SET status='active',status_reason=NULL,group_state=NULL,updated_at=NOW()
    `);

    // Remove stale workflow snapshots while preserving provider credentials,
    // WhatsApp group configuration, staff/captain users, and portal users.
    await client.query(`DELETE FROM system_settings WHERE key=ANY($1::text[])`,[["final_takeover_state","storage_last_cleanup_v1"]]);
    await client.query(`
      INSERT INTO system_settings(key,value,updated_by_user_id,updated_at)
      VALUES($1,$2::jsonb,NULL,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by_user_id=NULL,updated_at=NOW()
    `,[CLEAN_START_SETTING,JSON.stringify(cleanStart)]);
    await client.query(`
      INSERT INTO system_settings(key,value,updated_by_user_id,updated_at)
      VALUES('whatsapp_live_cutover',$1::jsonb,NULL,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by_user_id=NULL,updated_at=NOW()
    `,[JSON.stringify({cutoverAt:resetAt,source:CLEAN_SLATE_SETTING})]);

    const summary={
      captains:Number(before.captains||0),
      clearedLedgerEntries:Number(before.ledger_entries||0),
      clearedWhatsappEvents:Number(before.whatsapp_events||0),
      clearedInventoryReconciliations:Number(before.inventory_reconciliations||0),
      clearedSettlementItems:Number(before.settlement_items||0),
      clearedRechargeCodes:Number(before.recharge_codes||0),
      clearedRechargeRequests:Number(before.recharge_requests||0),
      previousNonzeroBalances:Number(before.nonzero_balances||0),
      previousTotalBalance:Number(before.total_balance||0),
      preservedCaptains:Number(before.captains||0),
      preservedUsers:true,
      preservedProviderSettings:true,
      resetAt
    };
    const state={
      version:CLEAN_SLATE_VERSION,
      status:"COMPLETED",
      resetAt,
      cutoverAt:resetAt,
      queuePrepared:true,
      appliedOnce:true,
      summary
    };
    await client.query(`
      INSERT INTO system_settings(key,value,updated_by_user_id,updated_at)
      VALUES($1,$2::jsonb,NULL,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by_user_id=NULL,updated_at=NOW()
    `,[CLEAN_SLATE_SETTING,JSON.stringify(state)]);

    const mismatch=await client.query(`
      SELECT c.id,c.name,COALESCE(SUM(le.amount),0)::numeric(16,3) AS balance
        FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id
       GROUP BY c.id
      HAVING ABS(COALESCE(SUM(le.amount),0))>=0.0005
       LIMIT 1
    `);
    if(mismatch.rowCount)throw new Error("clean_slate_balance_verification_failed");

    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES(NULL,'clean_slate.v38572.completed','system',$1,$2::jsonb)
    `,[CLEAN_SLATE_SETTING,JSON.stringify(summary)]);
    await client.query("COMMIT");
    return {applied:true,alreadyCompleted:false,state,cleanStart,summary};
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{client.release()}
}

async function rechargeOnlyRows(client=db){
  return (await client.query(`
    WITH current_balances AS (
      SELECT captain_id,COALESCE(SUM(amount),0)::numeric(14,3) AS current_balance
      FROM ledger_entries
      GROUP BY captain_id
    ), redeemed_recharges AS (
      SELECT captain_id,COALESCE(SUM(amount),0)::numeric(14,3) AS recharge_balance,
             COUNT(*)::int AS recharge_count
      FROM ledger_entries
      WHERE entry_type='RECHARGE'
        AND reversed_at IS NULL
        AND amount>0
      GROUP BY captain_id
    )
    SELECT c.id AS captain_id,c.name,c.phone,c.status,
           COALESCE(cb.current_balance,0)::numeric(14,3) AS current_balance,
           COALESCE(rr.recharge_balance,0)::numeric(14,3) AS recharge_balance,
           COALESCE(rr.recharge_count,0)::int AS recharge_count,
           (COALESCE(rr.recharge_balance,0)-COALESCE(cb.current_balance,0))::numeric(14,3) AS adjustment
    FROM captains c
    LEFT JOIN current_balances cb ON cb.captain_id=c.id
    LEFT JOIN redeemed_recharges rr ON rr.captain_id=c.id
    ORDER BY c.name,c.id
  `)).rows;
}

function rechargeOnlySummary(rows=[]){
  return rows.reduce((out,row)=>{
    const current=Number(row.current_balance||0);
    const recharge=Number(row.recharge_balance||0);
    const adjustment=Number(row.adjustment||0);
    out.captains+=1;
    out.currentTotal+=current;
    out.preservedRechargeTotal+=recharge;
    out.adjustmentTotal+=adjustment;
    out.rechargeMovements+=Number(row.recharge_count||0);
    if(Math.abs(adjustment)>=0.0005)out.affectedCaptains+=1;
    if(recharge>0)out.captainsWithRecharge+=1;
    return out;
  },{captains:0,affectedCaptains:0,captainsWithRecharge:0,rechargeMovements:0,currentTotal:0,preservedRechargeTotal:0,adjustmentTotal:0});
}

export async function previewRechargeOnlyCleanStart(){
  const [state,rows]=await Promise.all([getCleanStartState(),rechargeOnlyRows()]);
  const summary=rechargeOnlySummary(rows);
  return {
    state,
    canReset:true,
    summary,
    captains:rows.map(row=>({
      captainId:String(row.captain_id),name:row.name,phone:row.phone,status:row.status,
      currentBalance:Number(row.current_balance||0),
      preservedRecharge:Number(row.recharge_balance||0),
      adjustment:Number(row.adjustment||0),
      rechargeCount:Number(row.recharge_count||0)
    }))
  };
}

export async function executeRechargeOnlyCleanStart({userId,confirmation}={}){
  if(String(confirmation||"").trim()!=="تصفير الحسابات"){
    throw Object.assign(new Error("اكتب عبارة التأكيد: تصفير الحسابات"),{statusCode:400});
  }
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(3852801)");
    await client.query(`
      INSERT INTO system_settings(key,value,updated_by_user_id)
      VALUES($1,$2::jsonb,$3)
      ON CONFLICT(key) DO NOTHING
    `,[CLEAN_START_SETTING,JSON.stringify(cleanStartDefaultState()),userId||null]);
    const locked=await client.query(`SELECT value FROM system_settings WHERE key=$1 FOR UPDATE`,[CLEAN_START_SETTING]);
    const previous={...cleanStartDefaultState(),...(locked.rows[0]?.value||{})};

    // V3.8.5.38: this reset is intentionally repeatable. Every execution opens a
    // new accounting epoch, while old ledger history remains untouched for audit.
    // The new reset row gets an epoch-scoped unique reference so PostgreSQL can
    // safely accept another reset for the same captain.

    // Keep captain creation and balance-changing transactions serialized while the
    // reset target is calculated and written.
    await client.query(`SELECT id FROM captains ORDER BY id FOR UPDATE`);
    const rows=await rechargeOnlyRows(client);
    const resetAt=new Date().toISOString();
    const resetCount=Number(previous.resetCount||0)+1;
    const epochId=`RESET-${resetCount}-${resetAt.replace(/[^0-9]/g,"")}`;
    for(const row of rows){
      const adjustment=Number(row.adjustment||0);
      if(Math.abs(adjustment)<0.0005)continue;
      await client.query(`
        INSERT INTO ledger_entries(
          captain_id,amount,entry_type,direction,reference_type,reference_id,
          description,metadata,created_by_user_id,created_at
        ) VALUES(
          $1,$2,'CLEAN_START_RESET',CASE WHEN $2::numeric>=0 THEN 'credit' ELSE 'debit' END,
          'clean_start_v2',$3,'إعادة بناء الجرد — تثبيت الرصيد على الشحن المستخدم فقط',$4::jsonb,$5,$6::timestamptz
        )
        ON CONFLICT(captain_id,entry_type,reference_type,reference_id)
          WHERE reference_id IS NOT NULL DO NOTHING
      `,[row.captain_id,adjustment,`${epochId}:${row.captain_id}`,JSON.stringify({
        operation:"RECHARGE_ONLY_RESET_REPEATABLE_V2",
        epochId,
        resetCount,
        previousResetAt:previous.resetAt||null,
        oldBalance:Number(row.current_balance||0),
        preservedRecharge:Number(row.recharge_balance||0),
        rechargeCount:Number(row.recharge_count||0),
        resetAt
      }),userId||null,resetAt]);
    }

    const mismatches=await client.query(`
      WITH balances AS (
        SELECT c.id,
          COALESCE(SUM(le.amount),0)::numeric(14,3) AS actual,
          COALESCE(SUM(le.amount) FILTER(WHERE le.entry_type='RECHARGE' AND le.reversed_at IS NULL AND le.amount>0),0)::numeric(14,3) AS expected
        FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id
        GROUP BY c.id
      )
      SELECT id,actual,expected FROM balances WHERE ABS(actual-expected)>=0.0005 LIMIT 20
    `);
    if(mismatches.rowCount)throw new Error(`clean_start_balance_verification_failed:${mismatches.rowCount}`);

    // A captain frozen automatically only because of the old negative balance must
    // become usable again after the recharge-only balance is installed. Administrative
    // DISABLED accounts are intentionally untouched.
    await client.query(`
      UPDATE captains c
         SET status='active',status_reason=NULL,updated_at=NOW()
       WHERE c.status='frozen'
         AND COALESCE(c.status_reason,'')='AUTO_LOW_BALANCE'
         AND (SELECT COALESCE(SUM(le.amount),0) FROM ledger_entries le WHERE le.captain_id=c.id)>-0.75
    `);

    const summary=rechargeOnlySummary(rows);
    const state={
      ...previous,
      version:2,status:"COMPLETED",automaticStatus:"LIVE",resetAt,
      autoCutoverAt:resetAt,lastStartedAt:resetAt,alwaysOn:true,resetByUserId:userId?String(userId):null,
      resetCount,epochId,
      summary:{...summary,completedAt:resetAt,resetCount,epochId}
    };
    await client.query(`
      UPDATE system_settings
         SET value=$2::jsonb,updated_by_user_id=$3,updated_at=NOW()
       WHERE key=$1
    `,[CLEAN_START_SETTING,JSON.stringify(state),userId||null]);
    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'clean_start.recharge_only_reset','system',$2,$3::jsonb)
    `,[userId||null,CLEAN_START_SETTING,JSON.stringify({summary,resetAt,resetCount,epochId,previousResetAt:previous.resetAt||null,preservedEntryType:"RECHARGE",historicalLedgerDeleted:false,repeatable:true})]);
    await client.query("COMMIT");
    return {alreadyCompleted:false,repeatable:true,state,summary,resetCount,epochId};
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{client.release()}
}


// V3.8.5.80 — silent operational balance zero.
// This is intentionally different from the recharge-only clean start above:
// it sets every CURRENT captain balance to exactly zero while preserving all
// historical ledger rows. The balancing rows use CLEAN_START_RESET so normal
// accountant/captain transaction feeds keep them hidden; only the audit log
// records that an administrator ran the operation.
export async function executeSilentAllBalancesZero({userId,confirmation}={}){
  if(String(confirmation||"").trim()!=="تصفير الأرصدة"){
    throw Object.assign(new Error("اكتب عبارة التأكيد: تصفير الأرصدة"),{statusCode:400});
  }
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(3852802)");

    // Serialize against all normal balance-changing movement transactions.
    // createMovement/createMovementBatch also lock the captain row, so a new
    // movement is guaranteed to land either before this reset (and be zeroed)
    // or after commit (and therefore start from zero).
    await client.query(`SELECT id FROM captains ORDER BY id FOR UPDATE`);

    const balances=await client.query(`
      SELECT c.id,c.name,c.phone,
             COALESCE(SUM(le.amount),0)::numeric(14,3) AS current_balance
      FROM captains c
      LEFT JOIN ledger_entries le ON le.captain_id=c.id
      GROUP BY c.id
      ORDER BY c.id
    `);
    const resetAt=new Date().toISOString();
    const epochId=`SILENT-ZERO-${resetAt.replace(/[^0-9]/g,"")}`;
    let affectedCaptains=0;
    let previousTotal=0;
    let absoluteAdjusted=0;

    for(const row of balances.rows){
      const current=Number(row.current_balance||0);
      previousTotal+=current;
      if(Math.abs(current)<0.0005)continue;
      const adjustment=Number((-current).toFixed(3));
      absoluteAdjusted+=Math.abs(adjustment);
      affectedCaptains++;
      await client.query(`
        INSERT INTO ledger_entries(
          captain_id,amount,entry_type,direction,reference_type,reference_id,
          description,metadata,created_by_user_id,created_at
        ) VALUES(
          $1,$2,'CLEAN_START_RESET',CASE WHEN $2::numeric>=0 THEN 'credit' ELSE 'debit' END,
          'silent_balance_zero',$3,'تصفير رصيد تشغيلي داخلي',$4::jsonb,$5,$6::timestamptz
        )
      `,[row.id,adjustment,`${epochId}:${row.id}`,JSON.stringify({
        operation:"SILENT_ALL_BALANCES_ZERO_V1",
        hiddenFromCaptain:true,
        hiddenFromTransactionFeeds:true,
        balanceBefore:Number(current.toFixed(3)),
        balanceAfter:0,
        resetAt,
        epochId
      }),userId||null,resetAt]);
    }

    const verify=await client.query(`
      SELECT c.id,c.name,COALESCE(SUM(le.amount),0)::numeric(14,3) AS balance
      FROM captains c
      LEFT JOIN ledger_entries le ON le.captain_id=c.id
      GROUP BY c.id
      HAVING ABS(COALESCE(SUM(le.amount),0))>=0.0005
      LIMIT 20
    `);
    if(verify.rowCount)throw new Error(`silent_balance_zero_verification_failed:${verify.rowCount}`);

    // A captain frozen only because of the former low balance should not stay
    // blocked after the balance has become zero. Administrative disables/freeze
    // reasons are intentionally left untouched.
    const unfrozen=await client.query(`
      UPDATE captains
         SET status='active',status_reason=NULL,updated_at=NOW()
       WHERE status='frozen'
         AND COALESCE(status_reason,'')='AUTO_LOW_BALANCE'
      RETURNING id
    `);

    const summary={
      captainCount:balances.rowCount,
      affectedCaptains,
      previousTotal:Number(previousTotal.toFixed(3)),
      finalTotal:0,
      absoluteAdjusted:Number(absoluteAdjusted.toFixed(3)),
      autoUnfrozen:Number(unfrozen.rowCount||0),
      resetAt,
      epochId
    };
    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'captain_balances.silent_zero','captains',$2,$3::jsonb)
    `,[userId||null,epochId,JSON.stringify(summary)]);

    await client.query("COMMIT");
    return {ok:true,summary};
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{
    client.release();
  }
}

export async function setCleanStartAutomaticState({status,cutoverAt=null,userId,details={}}={}){
  const clean=String(status||"").toUpperCase();
  if(!["LIVE","STOPPED"].includes(clean))throw Object.assign(new Error("invalid_clean_start_automatic_status"),{statusCode:400});
  const current=await getCleanStartState();
  if(current.status!=="COMPLETED")throw Object.assign(new Error("نفّذ تصفير البداية الجديدة أولًا"),{statusCode:409});
  const next={...current,automaticStatus:clean};
  if(clean==="LIVE"){
    next.autoCutoverAt=new Date(cutoverAt||Date.now()).toISOString();
    next.lastStartedAt=next.autoCutoverAt;
    next.startCount=Number(current.startCount||0)+1;
  }else{
    next.lastStoppedAt=new Date().toISOString();
  }
  await setSystemSetting(CLEAN_START_SETTING,next,userId||null);
  await audit(userId,clean==="LIVE"?"clean_start.automatic_live":"clean_start.automatic_stopped","system",CLEAN_START_SETTING,{...details,cutoverAt:next.autoCutoverAt||null});
  return next;
}

export async function markWebhookIgnoredByCleanStart(idMessage,cutoverAt){
  await db.query(`
    UPDATE whatsapp_events
       SET status='ignored',processed_at=NOW(),processing_mode='clean_start_ignored',
           last_error='تجاهل تلقائي: الرسالة أقدم من لحظة تشغيل الجرد الجديدة'
     WHERE id_message=$1
       AND COALESCE(
         CASE WHEN event_timestamp>100000000000 THEN to_timestamp(event_timestamp/1000.0)
              WHEN event_timestamp>0 THEN to_timestamp(event_timestamp::double precision)
              ELSE NULL END,
         webhook_received_at
       ) < $2::timestamptz
  `,[String(idMessage||""),new Date(cutoverAt).toISOString()]);
}

export async function getWebhookCleanStartReference(idMessage){
  const r=await db.query(`
    SELECT id_message,status,processing_mode,raw_payload,webhook_received_at,
      COALESCE(
        CASE WHEN event_timestamp>100000000000 THEN to_timestamp(event_timestamp/1000.0)
             WHEN event_timestamp>0 THEN to_timestamp(event_timestamp::double precision)
             ELSE NULL END,
        webhook_received_at
      ) AS effective_at
    FROM whatsapp_events WHERE id_message=$1 LIMIT 1
  `,[String(idMessage||"")]);
  return r.rows[0]||null;
}

export async function markWebhookIgnoredByCleanStartReference(idMessage,cutoverAt,referencedId){
  await db.query(`
    UPDATE whatsapp_events
       SET status='ignored',processed_at=NOW(),processing_mode='clean_start_ignored',
           last_error='تجاهل تلقائي: الحدث مرتبط برسالة أقدم من لحظة تشغيل الجرد الجديدة'
     WHERE id_message=$1
  `,[String(idMessage||"")]);
  await traceWebhookEvent(idMessage,"clean_start.old_reference_ignored",{cutoverAt,referencedId});
}

export async function listCleanStartReferenceIgnoredEvents(limit=5000){
  const safeLimit=Math.min(5000,Math.max(1,Number(limit)||5000));
  const r=await db.query(`
    SELECT id_message,raw_payload,webhook_received_at
      FROM whatsapp_events
     WHERE processing_mode='clean_start_ignored'
       AND last_error='تجاهل تلقائي: الحدث مرتبط برسالة أقدم من لحظة تشغيل الجرد الجديدة'
       AND webhook_received_at >= NOW()-INTERVAL '7 days'
     ORDER BY webhook_received_at ASC,id ASC
     LIMIT $1
  `,[safeLimit]);
  return r.rows;
}

export async function markPendingWebhooksIgnoredBeforeCleanStart(cutoverAt){
  const r=await db.query(`
    UPDATE whatsapp_events
       SET status='ignored',processed_at=NOW(),processing_mode='clean_start_ignored',
           last_error='تجاهل تلقائي: الرسالة وصلت قبل لحظة تشغيل الجرد الجديدة'
     WHERE webhook_received_at < $1::timestamptz
       AND status IN ('received','queued','processing','failed')
    RETURNING id_message
  `,[new Date(cutoverAt).toISOString()]);
  return r.rows.map(x=>String(x.id_message));
}

export async function listCaptains(search="", limit=5000) {
  const q = `%${search}%`;
  const safeLimit=Math.min(10000,Math.max(1,Number(limit)||5000));
  const r = await db.query(`
    SELECT c.*,
      COALESCE(SUM(l.amount),0)::numeric(12,3) AS balance
    FROM captains c
    LEFT JOIN ledger_entries l ON l.captain_id=c.id
    WHERE ($1='' OR c.name ILIKE $2 OR c.phone ILIKE $2)
    GROUP BY c.id
    ORDER BY c.name ASC
    LIMIT $3
  `, [search, q, safeLimit]);
  return r.rows;
}

export async function createCaptain({name, phone, notes}) {
  const cleanName=String(name||"").trim();
  if(!cleanName)throw Object.assign(new Error("captain_name_required"),{statusCode:400});
  const normalized=normalizeJordanPhone(phone);
  if(!normalized || normalized.length<8) throw Object.assign(new Error("invalid_phone"),{statusCode:400});
  const display=normalized.length===9?`0${normalized}`:String(phone||"").trim();
  const exists=await db.query(`SELECT id FROM captains WHERE RIGHT(regexp_replace(phone,'[^0-9]','','g'),9)=RIGHT($1,9) LIMIT 1`,[normalized]);
  if(exists.rowCount) throw Object.assign(new Error("captain_phone_exists"),{statusCode:409});
  const r = await db.query(
    `INSERT INTO captains(name,phone,notes)
     VALUES($1,$2,$3)
     RETURNING *`,
    [cleanName, display, notes || null]
  );
  return r.rows[0];
}

export async function updateCaptain(id, patch) {
  const current = await db.query(`SELECT * FROM captains WHERE id=$1`, [id]);
  if (!current.rowCount) return null;
  const c = current.rows[0];

  let nextPhone=patch.phone ?? c.phone;
  if(patch.phone!==undefined){
    const normalized=normalizeJordanPhone(nextPhone);
    if(!normalized || normalized.length<8) throw Object.assign(new Error("invalid_phone"),{statusCode:400});
    const dup=await db.query(`SELECT id FROM captains WHERE id<>$1 AND RIGHT(regexp_replace(phone,'[^0-9]','','g'),9)=RIGHT($2,9) LIMIT 1`,[id,normalized]);
    if(dup.rowCount) throw Object.assign(new Error("captain_phone_exists"),{statusCode:409});
    nextPhone=normalized.length===9?`0${normalized}`:String(nextPhone||"").trim();
  }
  const nextStatus=String(patch.status??c.status).toLowerCase();
  if(!["active","frozen","disabled"].includes(nextStatus))throw Object.assign(new Error("invalid_captain_status"),{statusCode:400});
  const nextName=String(patch.name??c.name).trim();
  if(!nextName)throw Object.assign(new Error("captain_name_required"),{statusCode:400});
  const r = await db.query(`
    UPDATE captains
    SET name=$2, phone=$3, status=$4, notes=$5, updated_at=NOW()
    WHERE id=$1
    RETURNING *
  `, [
    id,
    nextName,
    nextPhone,
    nextStatus,
    patch.notes ?? c.notes
  ]);
  return r.rows[0];
}

export async function getBalance(captainId, client=db) {
  const r = await client.query(
    `SELECT COALESCE(SUM(amount),0)::numeric(12,3) AS balance
     FROM ledger_entries WHERE captain_id=$1`,
    [captainId]
  );
  return r.rows[0]?.balance ?? "0.000";
}

// Set a captain's FINAL balance to an exact number without corrupting production/
// consumption statistics. The balance in this system is derived from the ledger,
// so we never UPDATE a stored balance column. Instead we post one auditable manual
// adjustment equal to (target - current) inside a captain-locked transaction.
export async function setCaptainBalanceExact({
  captainId, targetBalance, createdBy=null, reason="", referenceId=null
}={}) {
  const targetRaw=Number(targetBalance);
  if(!Number.isFinite(targetRaw)){
    throw Object.assign(new Error("invalid_target_balance"),{statusCode:400});
  }
  // ledger_entries.amount is NUMERIC(12,3): at most 9 integer digits + 3 decimals.
  if(Math.abs(targetRaw)>999999999.999){
    throw Object.assign(new Error("target_balance_out_of_range"),{statusCode:400});
  }
  const target=Number(targetRaw.toFixed(3));
  const cleanReason=String(reason||"").trim().slice(0,500);
  const ref=String(referenceId||`BALSET-${Date.now()}-${Math.random().toString(36).slice(2,10)}`).trim();

  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const captain=await client.query(`SELECT id,name,phone FROM captains WHERE id=$1 FOR UPDATE`,[captainId]);
    if(!captain.rowCount)throw Object.assign(new Error("captain_not_found"),{statusCode:404});

    const current=Number(await getBalance(captainId,client));
    const difference=Number((target-current).toFixed(3));

    if(Math.abs(difference)<0.0005){
      await client.query(`
        INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
        VALUES($1,'captain.balance.set.nochange','captain',$2,$3::jsonb)
      `,[createdBy||null,String(captainId),JSON.stringify({
        captainId,currentBalance:current,targetBalance:target,reason:cleanReason
      })]);
      await client.query("COMMIT");
      return {changed:false,entry:null,balance:target,balanceBefore:current,targetBalance:target,difference:0};
    }

    const entryType=difference>0?'MANUAL_CREDIT':'MANUAL_DEBIT';
    const direction=difference>0?'credit':'debit';
    const description=`تثبيت الرصيد يدويًا من المحاسب: ${current.toFixed(3)} → ${target.toFixed(3)}${cleanReason?` — ${cleanReason}`:''}`;
    const metadata={
      type:'BALANCE_SET',
      source:'ACCOUNTANT_EXACT_BALANCE',
      balanceBefore:current,
      targetBalance:target,
      difference,
      reason:cleanReason||null
    };
    const inserted=await client.query(`
      INSERT INTO ledger_entries(
        captain_id,amount,entry_type,direction,reference_type,reference_id,
        description,metadata,created_by_user_id
      ) VALUES($1,$2,$3,$4,'accountant_balance_set',$5,$6,$7::jsonb,$8)
      RETURNING *
    `,[captainId,difference,entryType,direction,ref,description,JSON.stringify(metadata),createdBy||null]);

    const finalBalance=Number(await getBalance(captainId,client));
    if(Math.abs(finalBalance-target)>0.0005){
      throw Object.assign(new Error("balance_set_verification_failed"),{statusCode:500});
    }

    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'captain.balance.set','captain',$2,$3::jsonb)
    `,[createdBy||null,String(captainId),JSON.stringify({
      captainId,captainName:captain.rows[0].name,phone:captain.rows[0].phone,
      balanceBefore:current,targetBalance:target,difference,ledgerEntryId:inserted.rows[0].id,
      reason:cleanReason,referenceId:ref
    })]);

    await client.query("COMMIT");
    return {
      changed:true,entry:inserted.rows[0],balance:finalBalance,balanceBefore:current,
      targetBalance:target,difference
    };
  }catch(error){
    await client.query("ROLLBACK");
    if(error.code==='23505')throw Object.assign(new Error("duplicate_balance_set"),{statusCode:409});
    throw error;
  }finally{
    client.release();
  }
}

export async function listLedger(captainId, limit=100) {
  const r = await db.query(`
    SELECT * FROM ledger_entries
    WHERE captain_id=$1
      AND entry_type<>'CLEAN_START_RESET'
    ORDER BY created_at DESC
    LIMIT $2
  `, [captainId, Math.min(Number(limit)||100,500)]);
  return r.rows;
}

const AMMAN_TIME_ZONE = "Asia/Amman";
const WEEKLY_FLOOR_AMOUNT = 1.5;

function ammanDateParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: AMMAN_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23"
  });
  return Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
}

function ammanDateKey(date = new Date()) {
  const p = ammanDateParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function shiftAmmanDateKey(key, days) {
  const d = new Date(`${key}T12:00:00+03:00`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return ammanDateKey(d);
}

function activeAmmanAccountingWeek(date = new Date()) {
  const p = ammanDateParts(date);
  const today = `${p.year}-${p.month}-${p.day}`;
  const fromFriday = {Fri:0,Sat:1,Sun:2,Mon:3,Tue:4,Wed:5,Thu:6};
  const back = fromFriday[p.weekday] ?? 0;
  const startKey = shiftAmmanDateKey(today, -back);
  return {startKey, endKey:shiftAmmanDateKey(startKey, 6)};
}

function lastCompletedAmmanAccountingWeek(date = new Date()) {
  const p = ammanDateParts(date);
  const today = `${p.year}-${p.month}-${p.day}`;
  // The accounting week is Friday -> Thursday. A Thursday that is still in progress
  // is not considered completed, so Thursday defaults to the previous week.
  const sinceThursday = {Fri:1,Sat:2,Sun:3,Mon:4,Tue:5,Wed:6,Thu:7};
  const endKey = shiftAmmanDateKey(today, -(sinceThursday[p.weekday] ?? 7));
  return {startKey:shiftAmmanDateKey(endKey, -6), endKey};
}

function normalizeAmmanDateKey(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return ammanDateKey(d);
}

export async function ensureWeeklyFloorCharge(client, {captainId, createdBy=null, at=new Date(), sourceReference=null}={}) {
  // V3.8.5.39: الأرضية لم تعد تُخصم عند أول إنتاج/استهلاك.
  // القاعدة الوحيدة الآن: 1.50 د.أ مرة واحدة يوم الخميس الساعة 21:00 بتوقيت عمّان.
  // نُبقي الدالة كـ no-op لتوافق الاستدعاءات القديمة ومنع أي مسار قديم من تنزيل أرضية فورية.
  const {startKey,endKey}=activeAmmanAccountingWeek(at instanceof Date?at:new Date(at));
  return {
    applied:false,
    scheduledOnly:true,
    captainId:captainId||null,
    weekStart:startKey,
    weekEnd:endKey,
    sourceReference:sourceReference||null,
    createdBy:createdBy||null,
    reason:"scheduled_thursday_21_only"
  };
}

const MOVEMENT_RULES = {
  recharge:        { sign:  1, entryType: "RECHARGE",        direction: "credit" },
  production:      { sign:  1, entryType: "PRODUCTION",      direction: "credit" },
  consumption:     { sign: -1, entryType: "CONSUMPTION",     direction: "debit"  },
  order_commission:{ sign: -1, entryType: "ORDER_COMMISSION",direction: "debit"  },
  rider_commission:{ sign: -1, entryType: "RIDER_COMMISSION",direction: "debit"  },
  weekly_deduction:{ sign: -1, entryType: "WEEKLY_DEDUCTION",direction: "debit"  },
  manual_credit:   { sign:  1, entryType: "MANUAL_CREDIT",   direction: "credit" },
  manual_debit:    { sign: -1, entryType: "MANUAL_DEBIT",    direction: "debit"  },
  reconciliation_rider:{ sign: 1, entryType: "RIDER_RECONCILIATION", direction: "credit" },
  reconciliation_order:{ sign: 1, entryType: "ORDER_RECONCILIATION", direction: "credit" }
};

export async function createMovement({
  captainId, kind, amount, referenceType, referenceId, description, metadata={}, createdBy, occurredAt=null
}) {
  const rule = MOVEMENT_RULES[kind];
  if (!rule) throw Object.assign(new Error("invalid_movement_kind"), {statusCode:400});

  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error("amount_must_be_positive"), {statusCode:400});
  }

  const signedAmount = Number((Math.abs(n) * rule.sign).toFixed(3));
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const captain = await client.query(`SELECT id FROM captains WHERE id=$1 FOR UPDATE`, [captainId]);
    if (!captain.rowCount) throw Object.assign(new Error("captain_not_found"), {statusCode:404});

    // V3.8.5.39: this compatibility call is intentionally a no-op.
    // The 1.50 JOD floor is scheduled only for Thursday 21:00 Asia/Amman.
    if ((kind === "production" || kind === "consumption") && !metadata?.skipWeeklyFloor) {
      await ensureWeeklyFloorCharge(client, {
        captainId,
        createdBy,
        at: occurredAt ? new Date(occurredAt) : new Date(),
        sourceReference: referenceId || referenceType || kind
      });
    }

    const entry = await client.query(`
      INSERT INTO ledger_entries
      (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,COALESCE($10::timestamptz,NOW()))
      RETURNING *
    `, [
      captainId, signedAmount, rule.entryType, rule.direction,
      referenceType || null, referenceId || null, description || null,
      JSON.stringify(metadata || {}), createdBy || null,
      occurredAt ? new Date(occurredAt).toISOString() : null
    ]);

    const balance = await getBalance(captainId, client);

    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'movement.create','ledger_entry',$2,$3::jsonb)
    `, [createdBy || null, String(entry.rows[0].id), JSON.stringify({
      captainId, kind, amount:n, signedAmount, balance, referenceType, referenceId
    })]);

    await client.query("COMMIT");
    return {entry:entry.rows[0], balance};
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23505") {
      throw Object.assign(new Error("duplicate_movement"), {statusCode:409});
    }
    throw e;
  } finally {
    client.release();
  }
}

// Batch movement helper used by the accountant manual inventory form and Excel import.
// It locks the captain once and inserts all passenger/order components in one PostgreSQL
// transaction. The weekly floor is NOT applied here; V3.8.5.39 schedules it Thursday 21:00.
// This prevents a combined manual entry from being half-applied if one component fails.
export async function createMovementBatch({
  captainId, movements=[], createdBy, occurredAt=null
}) {
  if(!Array.isArray(movements) || !movements.length){
    throw Object.assign(new Error("movements_required"), {statusCode:400});
  }
  const prepared=movements.map((movement,index)=>{
    const kind=String(movement?.kind||"");
    const rule=MOVEMENT_RULES[kind];
    if(!rule)throw Object.assign(new Error("invalid_movement_kind"),{statusCode:400});
    const n=Number(movement?.amount);
    if(!Number.isFinite(n)||n<=0)throw Object.assign(new Error("amount_must_be_positive"),{statusCode:400});
    return {
      ...movement,
      kind,
      rule,
      amount:n,
      signedAmount:Number((Math.abs(n)*rule.sign).toFixed(3)),
      index
    };
  });

  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const captain=await client.query(`SELECT id FROM captains WHERE id=$1 FOR UPDATE`,[captainId]);
    if(!captain.rowCount)throw Object.assign(new Error("captain_not_found"),{statusCode:404});

    const firstInventory=prepared.find(x=>(x.kind==="production"||x.kind==="consumption")&&!x.metadata?.skipWeeklyFloor);
    if(firstInventory){
      await ensureWeeklyFloorCharge(client,{
        captainId,
        createdBy,
        at:occurredAt?new Date(occurredAt):new Date(),
        sourceReference:firstInventory.referenceId||firstInventory.referenceType||firstInventory.kind
      });
    }

    let runningBalance=Number(await getBalance(captainId,client));
    const entries=[];
    for(const item of prepared){
      const before=runningBalance;
      const metadata={...(item.metadata||{}),balanceBefore:before};
      const after=Number((before+item.signedAmount).toFixed(3));
      metadata.balanceAfter=after;
      const inserted=await client.query(`
        INSERT INTO ledger_entries
        (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,COALESCE($10::timestamptz,NOW()))
        RETURNING *
      `,[
        captainId,item.signedAmount,item.rule.entryType,item.rule.direction,
        item.referenceType||null,item.referenceId||null,item.description||null,
        JSON.stringify(metadata),createdBy||null,
        occurredAt?new Date(occurredAt).toISOString():null
      ]);
      const entry={...inserted.rows[0],computed_balance_before:before,computed_balance_after:after};
      entries.push(entry);
      runningBalance=after;
    }

    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'movement.batch.create','captain',$2,$3::jsonb)
    `,[createdBy||null,String(captainId),JSON.stringify({
      captainId,
      count:entries.length,
      finalBalance:runningBalance,
      movements:prepared.map(x=>({kind:x.kind,amount:x.amount,referenceType:x.referenceType,referenceId:x.referenceId}))
    })]);

    await client.query("COMMIT");
    return {entries,balance:runningBalance};
  }catch(e){
    await client.query("ROLLBACK");
    if(e.code==="23505")throw Object.assign(new Error("duplicate_movement"),{statusCode:409});
    throw e;
  }finally{
    client.release();
  }
}


// V3.8.5.40 — Excel import is authoritative per captain inside the current clean-start epoch.
// Re-uploading the same file (or refreshing and uploading it again) must not add the same
// inventory twice. If an older V3.8.5.32-39 attempt partially/fully duplicated Excel rows,
// this helper reverses ONLY active Excel-import movements in the current epoch and writes the
// requested target once. Other ledger sources (recharge, automatic WhatsApp, floor, manual edits,
// penalties, settlements) are never touched.
export async function reconcileManualExcelMovements({
  captainId, movements=[], createdBy, epochId, resetAt, batchId
}={}) {
  const cid=String(captainId||'').trim();
  if(!/^\d+$/.test(cid))throw Object.assign(new Error('invalid_captain_id'),{statusCode:400});
  if(!Array.isArray(movements))throw Object.assign(new Error('movements_required'),{statusCode:400});
  const epoch=String(epochId||'').trim();
  const resetIso=resetAt?new Date(resetAt).toISOString():'';
  if(!epoch||!resetIso)throw Object.assign(new Error('excel_epoch_required'),{statusCode:409});
  const requestBatch=String(batchId||'').trim()||`XLSX-${Date.now()}`;

  const wanted={consumptionOrders:0,consumptionPassengers:0,productionOrders:0,productionPassengers:0};
  const prepared=[];
  for(const m0 of movements){
    const m={...m0};
    const kind=String(m.kind||'');
    const rule=MOVEMENT_RULES[kind];
    if(!rule||!['production','consumption'].includes(kind))throw Object.assign(new Error('invalid_movement_kind'),{statusCode:400});
    const amount=Number(m.amount);
    const qty=Number(m?.metadata?.workloadQuantity??m?.metadata?.quantity??0);
    const type=String(m?.metadata?.type||'').toUpperCase();
    if(!Number.isFinite(amount)||amount<=0||!Number.isInteger(qty)||qty<=0||!['PASSENGER','ORDER'].includes(type)){
      throw Object.assign(new Error('invalid_excel_component'),{statusCode:400});
    }
    const key=kind==='production'?(type==='PASSENGER'?'productionPassengers':'productionOrders'):(type==='PASSENGER'?'consumptionPassengers':'consumptionOrders');
    wanted[key]+=qty;
    prepared.push({...m,kind,rule,amount,signedAmount:Number((Math.abs(amount)*rule.sign).toFixed(3)),type,qty});
  }

  const sameQ=(a,b)=>Object.keys(wanted).every(k=>Number(a[k]||0)===Number(b[k]||0));
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    // Serialize Excel reconciliation for the captain even across multiple Railway instances.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`abshir-excel-v40:${cid}:${epoch}`]);
    const cap=await client.query('SELECT id FROM captains WHERE id=$1 FOR UPDATE',[cid]);
    if(!cap.rowCount)throw Object.assign(new Error('captain_not_found'),{statusCode:404});

    const active=await client.query(`
      SELECT le.*
        FROM ledger_entries le
       WHERE le.captain_id=$1
         AND le.reference_type='excel_manual_bulk'
         AND le.entry_type IN ('PRODUCTION','CONSUMPTION')
         AND le.reversed_at IS NULL
         AND le.created_at >= $2::timestamptz
         AND NOT EXISTS (SELECT 1 FROM ledger_entries rv WHERE rv.reversed_entry_id=le.id)
       ORDER BY le.id
       FOR UPDATE
    `,[cid,resetIso]);

    const current={consumptionOrders:0,consumptionPassengers:0,productionOrders:0,productionPassengers:0};
    for(const e of active.rows){
      const meta=e.metadata||{};
      const type=String(meta.type||'').toUpperCase();
      const kind=String(e.entry_type||'').toUpperCase()==='PRODUCTION'?'production':'consumption';
      let qty=Number(meta.workloadQuantity??meta.quantity??0);
      if(!Number.isFinite(qty)||qty<=0){
        const unit=Number(meta.unitCommission||(type==='PASSENGER'?0.75:1));
        qty=unit>0?Math.round(Math.abs(Number(e.amount||0))/unit):0;
      }
      if(!qty||!['PASSENGER','ORDER'].includes(type))continue;
      const key=kind==='production'?(type==='PASSENGER'?'productionPassengers':'productionOrders'):(type==='PASSENGER'?'consumptionPassengers':'consumptionOrders');
      current[key]+=qty;
    }

    if(sameQ(current,wanted)){
      const bal=await getBalance(cid,client);
      await client.query('COMMIT');
      return {status:'unchanged',captainId:cid,balance:Number(bal),reversedEntries:0,createdEntries:0,current,wanted};
    }

    // Reverse only the Excel entries from this accounting epoch. Historical entries before the
    // last recharge-only reset are intentionally left untouched because the reset already neutralized them.
    let reversedEntries=0;
    for(const e of active.rows){
      const reversal=await client.query(`
        INSERT INTO ledger_entries
        (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,reversed_entry_id)
        VALUES($1,$2,'REVERSAL',$3,'excel_manual_bulk_repair',$4,$5,$6::jsonb,$7,$8)
        ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL DO NOTHING
        RETURNING id,created_at
      `,[
        cid,-Number(e.amount),Number(e.amount)>0?'debit':'credit',
        `XLSX-REPAIR-REV-${e.id}`,
        `إصلاح استيراد Excel — عكس حركة مكررة/قديمة رقم ${e.id}`,
        JSON.stringify({manualExcelRepair:true,excelEpochId:epoch,repairBatchId:requestBatch,originalEntryType:e.entry_type,originalReferenceId:e.reference_id}),
        createdBy||null,e.id
      ]);
      const reversedAt=reversal.rows[0]?.created_at||new Date().toISOString();
      await client.query('UPDATE ledger_entries SET reversed_at=COALESCE(reversed_at,$2::timestamptz) WHERE id=$1',[e.id,reversedAt]);
      if(reversal.rowCount)reversedEntries++;
    }

    let running=Number(await getBalance(cid,client));
    let createdEntries=0;
    let seq=0;
    for(const item of prepared){
      seq++;
      const before=running;
      const after=Number((before+item.signedAmount).toFixed(3));
      const suffix=item.kind==='production'?(item.type==='PASSENGER'?'PRO-P':'PRO-O'):(item.type==='PASSENGER'?'CON-P':'CON-O');
      const refId=`${requestBatch}-${epoch}-${cid}-${suffix}-${seq}`;
      const metadata={...(item.metadata||{}),manualExcel:true,manualExcelReconciled:true,excelBatchId:requestBatch,excelEpochId:epoch,balanceBefore:before,balanceAfter:after};
      const ins=await client.query(`
        INSERT INTO ledger_entries
        (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id)
        VALUES($1,$2,$3,$4,'excel_manual_bulk',$5,$6,$7::jsonb,$8)
        ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL DO NOTHING
        RETURNING id
      `,[cid,item.signedAmount,item.rule.entryType,item.rule.direction,refId,item.description||'استيراد Excel مطابق',JSON.stringify(metadata),createdBy||null]);
      if(ins.rowCount){createdEntries++;running=after;}
    }

    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'movement.excel.reconcile','captain',$2,$3::jsonb)
    `,[createdBy||null,cid,JSON.stringify({epochId:epoch,batchId:requestBatch,current,wanted,reversedEntries,createdEntries,finalBalance:running})]);

    await client.query('COMMIT');
    return {status:active.rowCount?'repaired':'created',captainId:cid,balance:running,reversedEntries,createdEntries,current,wanted};
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{
    client.release();
  }
}


// V3.8.5.69 — safe rollback for the most recent Excel bulk import.
// This restores the exact Excel state that existed immediately before that batch:
//   1) reverse active entries created by the bad/latest batch;
//   2) recreate any older Excel entries that the batch itself had reversed during reconciliation.
// No recharge, WhatsApp, Friday settlement, floor, penalty, or non-Excel ledger row is touched.
export async function previewLatestManualExcelRollback(){
  const latest=await db.query(`
    SELECT a.id,a.entity_id AS batch_id,a.details,a.created_at
      FROM audit_logs a
     WHERE a.action='movement.excel.bulk.reconcile'
       AND COALESCE(a.entity_id,'')<>''
       AND NOT EXISTS (
         SELECT 1 FROM audit_logs r
          WHERE r.action='movement.excel.bulk.rollback'
            AND r.entity_id=a.entity_id
       )
     ORDER BY a.id DESC
     LIMIT 1
  `);
  if(!latest.rowCount)return {available:false,message:'لا يوجد رفع Excel حديث غير مُلغى'};
  const x=latest.rows[0],batchId=String(x.batch_id||'');
  const active=await db.query(`
    SELECT COUNT(*)::int AS entries,
           COUNT(DISTINCT captain_id)::int AS captains,
           COALESCE(SUM(amount),0)::numeric(12,3) AS net_amount,
           COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0)::numeric(12,3) AS credits,
           COALESCE(SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END),0)::numeric(12,3) AS debits
      FROM ledger_entries
     WHERE reference_type='excel_manual_bulk'
       AND COALESCE(metadata->>'excelBatchId','')=$1
       AND reversed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ledger_entries rv WHERE rv.reversed_entry_id=ledger_entries.id)
  `,[batchId]);
  const previous=await db.query(`
    SELECT COUNT(*)::int AS entries,
           COUNT(DISTINCT orig.captain_id)::int AS captains,
           COALESCE(SUM(orig.amount),0)::numeric(12,3) AS net_amount
      FROM ledger_entries rv
      JOIN ledger_entries orig ON orig.id=rv.reversed_entry_id
     WHERE rv.entry_type='REVERSAL'
       AND rv.reference_type='excel_manual_bulk_repair'
       AND COALESCE(rv.metadata->>'repairBatchId','')=$1
  `,[batchId]);
  const a=active.rows[0]||{},b=previous.rows[0]||{};
  return {
    available:Number(a.entries||0)>0||Number(b.entries||0)>0,
    batchId,
    uploadedAt:x.created_at,
    rows:Number(x.details?.rows||0),
    activeEntries:Number(a.entries||0),activeCaptains:Number(a.captains||0),
    activeNet:Number(a.net_amount||0),activeCredits:Number(a.credits||0),activeDebits:Number(a.debits||0),
    previousEntriesToRestore:Number(b.entries||0),previousCaptainsToRestore:Number(b.captains||0),previousNetToRestore:Number(b.net_amount||0),
    message:(Number(a.entries||0)>0||Number(b.entries||0)>0)?'جاهز لإلغاء آخر رفع Excel وإرجاع الحالة السابقة':'آخر رفع Excel لا يملك حركات فعالة تحتاج إلغاء'
  };
}

export async function rollbackLatestManualExcelImport({createdBy=null}={}){
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['abshir-excel-v69-rollback-latest']);
    const latest=await client.query(`
      SELECT a.id,a.entity_id AS batch_id,a.details,a.created_at
        FROM audit_logs a
       WHERE a.action='movement.excel.bulk.reconcile'
         AND COALESCE(a.entity_id,'')<>''
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs r
            WHERE r.action='movement.excel.bulk.rollback'
              AND r.entity_id=a.entity_id
         )
       ORDER BY a.id DESC
       LIMIT 1
    `);
    if(!latest.rowCount)throw Object.assign(new Error('no_excel_batch_to_rollback'),{statusCode:409});
    const batchId=String(latest.rows[0].batch_id||'');

    const active=await client.query(`
      SELECT le.*
        FROM ledger_entries le
       WHERE le.reference_type='excel_manual_bulk'
         AND COALESCE(le.metadata->>'excelBatchId','')=$1
         AND le.reversed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM ledger_entries rv WHERE rv.reversed_entry_id=le.id)
       ORDER BY le.captain_id,le.id
       FOR UPDATE
    `,[batchId]);

    // These are the exact Excel entries that the latest batch reversed while replacing
    // an older Excel target. Recreate copies of them so rollback returns to the true
    // pre-upload state even when this was not the first Excel import of the epoch.
    const previous=await client.query(`
      SELECT orig.*
        FROM ledger_entries rv
        JOIN ledger_entries orig ON orig.id=rv.reversed_entry_id
       WHERE rv.entry_type='REVERSAL'
         AND rv.reference_type='excel_manual_bulk_repair'
         AND COALESCE(rv.metadata->>'repairBatchId','')=$1
       ORDER BY orig.captain_id,orig.id
       FOR UPDATE OF orig
    `,[batchId]);

    const captainIds=[...new Set([...active.rows,...previous.rows].map(x=>String(x.captain_id)))].sort((a,b)=>Number(a)-Number(b));
    if(!captainIds.length)throw Object.assign(new Error('excel_batch_has_no_active_effect'),{statusCode:409});
    await client.query(`SELECT id FROM captains WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[captainIds]);

    let reversedEntries=0,restoredEntries=0;
    for(const e of active.rows){
      const ins=await client.query(`
        INSERT INTO ledger_entries
        (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,reversed_entry_id)
        VALUES($1,$2,'REVERSAL',$3,'excel_manual_bulk_rollback',$4,$5,$6::jsonb,$7,$8)
        ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL DO NOTHING
        RETURNING id,created_at
      `,[
        e.captain_id,-Number(e.amount),Number(e.amount)>0?'debit':'credit',
        `XLSX-BATCH-ROLLBACK-REV-${e.id}`,
        `إلغاء آخر رفع Excel — عكس الحركة رقم ${e.id}`,
        JSON.stringify({manualExcelRollback:true,rollbackBatchId:batchId,originalEntryType:e.entry_type,originalReferenceId:e.reference_id}),
        createdBy||null,e.id
      ]);
      const reversedAt=ins.rows[0]?.created_at||new Date().toISOString();
      await client.query(`UPDATE ledger_entries SET reversed_at=COALESCE(reversed_at,$2::timestamptz) WHERE id=$1`,[e.id,reversedAt]);
      if(ins.rowCount)reversedEntries++;
    }

    for(const e of previous.rows){
      const oldMeta=e.metadata||{};
      const metadata={...oldMeta,manualExcel:true,manualExcelRollbackRestore:true,rollbackBatchId:batchId,restoredFromEntryId:String(e.id)};
      // Give the restored copy a unique batch marker while preserving epoch/type/quantity
      // metadata and, critically, the ORIGINAL created_at so weekly views remain unchanged.
      metadata.excelBatchId=`ROLLBACK-${batchId}`;
      const ins=await client.query(`
        INSERT INTO ledger_entries
        (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,created_at)
        VALUES($1,$2,$3,$4,'excel_manual_bulk',$5,$6,$7::jsonb,$8,$9::timestamptz)
        ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL DO NOTHING
        RETURNING id
      `,[
        e.captain_id,Number(e.amount),e.entry_type,e.direction,
        `XLSX-BATCH-ROLLBACK-RESTORE-${batchId}-${e.id}`,
        `استرجاع حالة Excel قبل الرفع الملغى — ${String(e.description||'حركة Excel سابقة').slice(0,350)}`,
        JSON.stringify(metadata),createdBy||null,e.created_at
      ]);
      if(ins.rowCount)restoredEntries++;
    }

    const balances=[];
    for(const cid of captainIds){
      const b=await getBalance(cid,client);
      balances.push({captainId:cid,balance:Number(b)});
    }
    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'movement.excel.bulk.rollback','system',$2,$3::jsonb)
    `,[createdBy||null,batchId,JSON.stringify({batchId,sourceAuditId:latest.rows[0].id,sourceUploadedAt:latest.rows[0].created_at,affectedCaptains:captainIds.length,reversedEntries,restoredEntries,balances})]);
    await client.query('COMMIT');
    return {ok:true,batchId,affectedCaptains:captainIds.length,reversedEntries,restoredEntries,captainIds,balances};
  }catch(e){
    await client.query('ROLLBACK');
    throw e;
  }finally{client.release()}
}

export async function reverseLedgerEntry({entryId, createdBy, reason}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const original = await client.query(`
      SELECT * FROM ledger_entries
      WHERE id=$1
      FOR UPDATE
    `, [entryId]);

    if (!original.rowCount) throw Object.assign(new Error("entry_not_found"), {statusCode:404});
    const e = original.rows[0];

    const already = await client.query(
      `SELECT id FROM ledger_entries WHERE reversed_entry_id=$1 LIMIT 1`,
      [entryId]
    );
    if (already.rowCount) throw Object.assign(new Error("entry_already_reversed"), {statusCode:409});

    const reversal = await client.query(`
      INSERT INTO ledger_entries
      (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,reversed_entry_id)
      VALUES($1,$2,'REVERSAL',$3,'ledger_entry',$4,$5,$6::jsonb,$7,$8)
      RETURNING *
    `, [
      e.captain_id,
      -Number(e.amount),
      Number(e.amount) > 0 ? "debit" : "credit",
      `REV-${entryId}`,
      reason || `Reversal of ledger entry ${entryId}`,
      JSON.stringify({originalEntryType:e.entry_type}),
      createdBy || null,
      entryId
    ]);

    await client.query(`
      UPDATE ledger_entries
         SET reversed_at=COALESCE(reversed_at,NOW())
       WHERE id=$1
    `,[entryId]);

    const balance = await getBalance(e.captain_id, client);

    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'movement.reverse','ledger_entry',$2,$3::jsonb)
    `, [createdBy || null, String(entryId), JSON.stringify({
      reversalEntryId:reversal.rows[0].id,
      captainId:e.captain_id,
      balance,
      reason:reason || null
    })]);

    await client.query("COMMIT");
    return {entry:reversal.rows[0], original:e, balance};
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(userId, action, entityType, entityId, details={}) {
  const safeDetails=sanitizeAuditDetails(details);
  await db.query(`
    INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
    VALUES($1,$2,$3,$4,$5::jsonb)
  `, [userId || null, action, entityType || null, entityId ? String(entityId) : null, JSON.stringify(safeDetails)]);
}


export async function createCaptainUser({captainId, username, password, createdBy}) {
  const cleanUsername=String(username||"").trim();
  const cleanPassword=String(password||"");
  if(!cleanUsername)throw Object.assign(new Error("username_required"),{statusCode:400});
  if(cleanPassword.length<6)throw Object.assign(new Error("password_too_short"),{statusCode:400});
  const hash=await bcrypt.hash(cleanPassword,12);
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const captain=await client.query(`SELECT id,name,phone FROM captains WHERE id=$1 FOR UPDATE`,[captainId]);
    if(!captain.rowCount)throw Object.assign(new Error("captain_not_found"),{statusCode:404});

    const usernameOwner=await client.query(`SELECT * FROM users WHERE username=$1 FOR UPDATE`,[cleanUsername]);
    if(usernameOwner.rowCount){
      const owner=usernameOwner.rows[0];
      if(owner.role!=="captain"||String(owner.captain_id)!==String(captainId)){
        throw Object.assign(new Error("username_already_exists"),{statusCode:409});
      }
    }

    const current=await client.query(`
      SELECT * FROM users
       WHERE role='captain' AND captain_id=$1
       ORDER BY is_active DESC,updated_at DESC,id DESC
       LIMIT 1 FOR UPDATE
    `,[captainId]);
    const selected=usernameOwner.rows[0]||current.rows[0]||null;
    let row;
    if(selected){
      row=(await client.query(`
        UPDATE users
           SET username=$2,password_hash=$3,role='captain',captain_id=$4,is_active=TRUE,updated_at=NOW()
         WHERE id=$1
         RETURNING id,username,role,captain_id,is_active
      `,[selected.id,cleanUsername,hash,captainId])).rows[0];
    }else{
      row=(await client.query(`
        INSERT INTO users(username,password_hash,role,captain_id,is_active)
        VALUES($1,$2,'captain',$3,TRUE)
        RETURNING id,username,role,captain_id,is_active
      `,[cleanUsername,hash,captainId])).rows[0];
    }

    await client.query(`
      UPDATE users SET is_active=FALSE,updated_at=NOW()
       WHERE role='captain' AND captain_id=$1 AND id<>$2 AND is_active=TRUE
    `,[captainId,row.id]);
    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'captain_user.upsert','captain',$2,$3::jsonb)
    `,[createdBy||null,String(captainId),JSON.stringify({username:cleanUsername,userId:row.id})]);
    await client.query("COMMIT");
    return row;
  }catch(e){
    await client.query("ROLLBACK");
    if(e.code==="23505")throw Object.assign(new Error("username_already_exists"),{statusCode:409});
    throw e;
  }finally{client.release()}
}

export async function getCaptainProfile(captainId) {
  const r = await db.query(`
    SELECT c.id,c.name,c.phone,c.status,c.notes,c.created_at,
           COALESCE(SUM(l.amount),0)::numeric(12,3) AS balance
    FROM captains c
    LEFT JOIN ledger_entries l ON l.captain_id=c.id
    WHERE c.id=$1
    GROUP BY c.id
  `, [captainId]);
  return r.rows[0] || null;
}

export async function getCaptainSummary(captainId) {
  const r = await db.query(`
    SELECT
      COALESCE(SUM(amount),0)::numeric(12,3) AS balance,
      COALESCE(SUM(amount) FILTER (WHERE entry_type<>'CLEAN_START_RESET' AND amount > 0),0)::numeric(12,3) AS total_credit,
      COALESCE(ABS(SUM(amount) FILTER (WHERE entry_type<>'CLEAN_START_RESET' AND amount < 0)),0)::numeric(12,3) AS total_debit,
      COUNT(*) FILTER (WHERE entry_type<>'CLEAN_START_RESET')::int AS movements_count,
      COUNT(*) FILTER (WHERE entry_type='PRODUCTION')::int AS production_count,
      COUNT(*) FILTER (WHERE entry_type='CONSUMPTION')::int AS consumption_count,
      COUNT(*) FILTER (WHERE entry_type='ORDER_COMMISSION')::int AS order_commission_count,
      COUNT(*) FILTER (WHERE entry_type='RIDER_COMMISSION')::int AS rider_commission_count,
      MAX(created_at) FILTER (WHERE entry_type<>'CLEAN_START_RESET') AS last_movement_at
    FROM ledger_entries
    WHERE captain_id=$1
  `, [captainId]);
  return r.rows[0];
}


export async function getCaptainAccount(captainId) {
  const r = await db.query(`
    SELECT id,username,role,captain_id,is_active,created_at,updated_at
    FROM users
    WHERE captain_id=$1 AND role='captain'
    ORDER BY id DESC
    LIMIT 1
  `, [captainId]);
  return r.rows[0] || null;
}


function randomRechargeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "SF-";
  for (let i=0;i<8;i++) out += alphabet[Math.floor(Math.random()*alphabet.length)];
  return out;
}

export async function createRechargeCode({amount, createdBy, assignedCaptainId=null}) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error("amount_must_be_positive"), {statusCode:400});
  }

  if (assignedCaptainId) {
    const captain=await db.query(`SELECT id FROM captains WHERE id=$1`,[assignedCaptainId]);
    if(!captain.rowCount) throw Object.assign(new Error("captain_not_found"),{statusCode:404});
  }

  for (let i=0;i<5;i++) {
    const code = randomRechargeCode();
    try {
      const r = await db.query(`
        INSERT INTO recharge_codes(code,amount,created_by_user_id,assigned_captain_id)
        VALUES($1,$2,$3,$4)
        RETURNING *
      `, [code, n, createdBy || null, assignedCaptainId || null]);
      await audit(createdBy, "recharge_code.create", "recharge_code", r.rows[0].id, {code,amount:n,assignedCaptainId:assignedCaptainId||null});
      return r.rows[0];
    } catch (e) {
      if (e.code !== "23505") throw e;
    }
  }
  throw new Error("failed_to_generate_unique_code");
}

export async function listRechargeCodes({status="", limit=100}={}) {
  const r = await db.query(`
    SELECT rc.*,
           used.name AS used_by_captain_name,
           assigned.name AS assigned_captain_name,
           assigned.phone AS assigned_captain_phone,
           pu.username AS portal_issuer_username,
           pu.display_name AS portal_issuer_name
    FROM recharge_codes rc
    LEFT JOIN captains used ON used.id=rc.used_by_captain_id
    LEFT JOIN captains assigned ON assigned.id=rc.assigned_captain_id
    LEFT JOIN recharge_portal_users pu ON pu.id=rc.issued_by_portal_user_id
    WHERE ($1='' OR rc.status=$1)
    ORDER BY rc.created_at DESC
    LIMIT $2
  `, [status, Math.min(Number(limit)||100,500)]);
  return r.rows;
}

export async function cancelRechargeCode({id, userId}) {
  const r = await db.query(`
    UPDATE recharge_codes
    SET status='cancelled'
    WHERE id=$1 AND status='active'
    RETURNING *
  `, [id]);
  if (!r.rowCount) throw Object.assign(new Error("code_not_active"), {statusCode:409});
  await audit(userId, "recharge_code.cancel", "recharge_code", id, {});
  return r.rows[0];
}

export async function redeemRechargeCode({captainId, code}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const captain = await client.query(`SELECT id FROM captains WHERE id=$1 FOR UPDATE`, [captainId]);
    if (!captain.rowCount) throw Object.assign(new Error("captain_not_found"), {statusCode:404});

    const rc = await client.query(`
      SELECT * FROM recharge_codes
      WHERE code=$1
      FOR UPDATE
    `, [String(code || "").trim().toUpperCase()]);
    if (!rc.rowCount) throw Object.assign(new Error("invalid_recharge_code"), {statusCode:404});
    const codeRow = rc.rows[0];
    if (codeRow.status !== "active") throw Object.assign(new Error("recharge_code_not_active"), {statusCode:409});
    if (codeRow.assigned_captain_id && String(codeRow.assigned_captain_id) !== String(captainId)) {
      throw Object.assign(new Error("recharge_code_for_other_captain"), {statusCode:403});
    }

    const entry = await client.query(`
      INSERT INTO ledger_entries
      (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata)
      VALUES($1,$2,'RECHARGE','credit','recharge_code',$3,$4,$5::jsonb)
      RETURNING *
    `, [
      captainId,
      Number(codeRow.amount),
      codeRow.code,
      `Recharge code ${codeRow.code}`,
      JSON.stringify({rechargeCodeId:codeRow.id})
    ]);

    await client.query(`
      UPDATE recharge_codes
      SET status='used',
          used_by_captain_id=$2,
          used_ledger_entry_id=$3,
          used_at=NOW()
      WHERE id=$1
    `, [codeRow.id, captainId, entry.rows[0].id]);

    const balance = await getBalance(captainId, client);

    await client.query("COMMIT");
    return {entry:entry.rows[0], balance, amount:codeRow.amount, code:codeRow.code};
  } catch(e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function createRechargeRequest({captainId, amount, method, referenceText, note}) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error("amount_must_be_positive"), {statusCode:400});
  }
  const r = await db.query(`
    INSERT INTO recharge_requests(captain_id,amount,method,reference_text,note)
    VALUES($1,$2,$3,$4,$5)
    RETURNING *
  `, [captainId,n,method||null,referenceText||null,note||null]);
  return r.rows[0];
}

export async function listRechargeRequests({status="", limit=100}={}) {
  const r = await db.query(`
    SELECT rr.*, c.name AS captain_name, c.phone AS captain_phone
    FROM recharge_requests rr
    JOIN captains c ON c.id=rr.captain_id
    WHERE ($1='' OR rr.status=$1)
    ORDER BY rr.created_at DESC
    LIMIT $2
  `, [status, Math.min(Number(limit)||100,500)]);
  return r.rows;
}

export async function reviewRechargeRequest({requestId, approve, userId}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const rr = await client.query(`
      SELECT * FROM recharge_requests
      WHERE id=$1
      FOR UPDATE
    `, [requestId]);
    if (!rr.rowCount) throw Object.assign(new Error("recharge_request_not_found"), {statusCode:404});
    const row = rr.rows[0];
    if (row.status !== "pending") throw Object.assign(new Error("request_not_pending"), {statusCode:409});

    if (!approve) {
      const rejected = await client.query(`
        UPDATE recharge_requests
        SET status='rejected', reviewed_at=NOW(), reviewed_by_user_id=$2
        WHERE id=$1
        RETURNING *
      `, [requestId,userId||null]);

      await client.query("COMMIT");
      return {request:rejected.rows[0], balance:null};
    }

    const entry = await client.query(`
      INSERT INTO ledger_entries
      (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id)
      VALUES($1,$2,'RECHARGE','credit','recharge_request',$3,$4,$5::jsonb,$6)
      RETURNING *
    `, [
      row.captain_id,
      Number(row.amount),
      String(row.id),
      `Approved recharge request #${row.id}`,
      JSON.stringify({method:row.method,referenceText:row.reference_text}),
      userId||null
    ]);

    const approved = await client.query(`
      UPDATE recharge_requests
      SET status='approved',
          reviewed_at=NOW(),
          reviewed_by_user_id=$2,
          ledger_entry_id=$3
      WHERE id=$1
      RETURNING *
    `, [requestId,userId||null,entry.rows[0].id]);

    const balance = await getBalance(row.captain_id, client);

    await client.query("COMMIT");
    return {request:approved.rows[0], entry:entry.rows[0], balance};
  } catch(e) {
    await client.query("ROLLBACK");
    if (e.code === "23505") {
      throw Object.assign(new Error("duplicate_recharge_request_processing"), {statusCode:409});
    }
    throw e;
  } finally {
    client.release();
  }
}


function settlementWeekBounds({weekStart,weekEnd}={}) {
  let startKey,endKey;
  if(weekStart||weekEnd){
    startKey=normalizeAmmanDateKey(weekStart);
    endKey=normalizeAmmanDateKey(weekEnd);
    if(!startKey||!endKey)throw Object.assign(new Error("invalid_week_range"),{statusCode:400});
  }else{
    ({startKey,endKey}=lastCompletedAmmanAccountingWeek());
  }
  const expectedEnd=shiftAmmanDateKey(startKey,6);
  if(expectedEnd!==endKey)throw Object.assign(new Error("invalid_week_range_friday_thursday"),{statusCode:400});
  const startTs=new Date(`${startKey}T00:00:00+03:00`);
  const endExclusive=new Date(`${shiftAmmanDateKey(endKey,1)}T00:00:00+03:00`);
  return {startKey,endKey,startTs,endExclusive};
}

export async function buildWeeklySettlement({weekStart, weekEnd, userId}) {
  const bounds=settlementWeekBounds({weekStart,weekEnd});
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const s = await client.query(`
      INSERT INTO weekly_settlements(week_start,week_end,created_by_user_id)
      VALUES($1::date,$2::date,$3)
      ON CONFLICT(week_start,week_end)
      DO UPDATE SET created_by_user_id=COALESCE(weekly_settlements.created_by_user_id,EXCLUDED.created_by_user_id)
      RETURNING *
    `, [bounds.startKey, bounds.endKey, userId || null]);
    const settlement = s.rows[0];

    await client.query(`
      INSERT INTO weekly_settlement_items(
        settlement_id,captain_id,production,consumption,order_commission,rider_commission,
        recharge,refund,manual_adjustment,net,movement_count,order_count,rider_count
      )
      SELECT
        $1,
        c.id,
        COALESCE(SUM(CASE WHEN le.entry_type='PRODUCTION' THEN ABS(le.amount) ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN le.entry_type='CONSUMPTION' THEN ABS(le.amount) ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN le.entry_type='CONSUMPTION' AND COALESCE(le.metadata->>'type','')='ORDER' THEN ABS(le.amount) ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN le.entry_type='CONSUMPTION' AND COALESCE(le.metadata->>'type','')='PASSENGER' THEN ABS(le.amount) ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN le.entry_type='RECHARGE' THEN ABS(le.amount) ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN le.entry_type='REFUND' THEN ABS(le.amount) ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN le.entry_type NOT IN ('PRODUCTION','CONSUMPTION','ORDER_COMMISSION','RIDER_COMMISSION','RECHARGE','REFUND','REVERSAL')
          THEN CASE WHEN le.direction='credit' THEN ABS(le.amount) ELSE -ABS(le.amount) END ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN le.entry_type='PRODUCTION' THEN ABS(le.amount) WHEN le.entry_type='CONSUMPTION' THEN -ABS(le.amount) ELSE 0 END),0),
        GREATEST(
          COALESCE(SUM(CASE WHEN le.entry_type='PRODUCTION' AND COALESCE(le.reference_type,'')<>'green_partial' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER') THEN CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END ELSE 0 END),0),
          COALESCE(SUM(CASE WHEN le.entry_type='CONSUMPTION' AND COALESCE(le.reference_type,'')<>'green_partial' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER') THEN CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END ELSE 0 END),0)
        )::int,
        COALESCE(SUM(CASE WHEN le.entry_type='CONSUMPTION' AND COALESCE(le.reference_type,'')<>'green_partial' AND COALESCE(le.metadata->>'type','')='ORDER'
          THEN CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END ELSE 0 END),0)::int,
        COALESCE(SUM(CASE WHEN le.entry_type='CONSUMPTION' AND COALESCE(le.reference_type,'')<>'green_partial' AND COALESCE(le.metadata->>'type','')='PASSENGER'
          THEN CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END ELSE 0 END),0)::int
      FROM captains c
      LEFT JOIN ledger_entries le
        ON le.captain_id=c.id
       AND le.created_at >= $2::timestamptz
       AND le.created_at < $3::timestamptz
       AND le.reversed_at IS NULL
       AND le.entry_type<>'REVERSAL'
      GROUP BY c.id
      ON CONFLICT(settlement_id,captain_id)
      DO UPDATE SET
        production=EXCLUDED.production,
        consumption=EXCLUDED.consumption,
        order_commission=EXCLUDED.order_commission,
        rider_commission=EXCLUDED.rider_commission,
        recharge=EXCLUDED.recharge,
        refund=EXCLUDED.refund,
        manual_adjustment=EXCLUDED.manual_adjustment,
        net=EXCLUDED.net,
        movement_count=EXCLUDED.movement_count,
        order_count=EXCLUDED.order_count,
        rider_count=EXCLUDED.rider_count
      WHERE weekly_settlement_items.status='due'
    `, [settlement.id, bounds.startTs.toISOString(), bounds.endExclusive.toISOString()]);

    await client.query("COMMIT");
    return settlement;
  } catch(e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function listWeeklySettlements() {
  const r = await db.query(`
    SELECT ws.*,
      COUNT(wsi.id)::int AS captain_count,
      COUNT(wsi.id) FILTER (WHERE wsi.status='due')::int AS due_count,
      COUNT(wsi.id) FILTER (WHERE wsi.status='transferred')::int AS transferred_count,
      COALESCE(SUM(wsi.net),0) AS total_net
    FROM weekly_settlements ws
    LEFT JOIN weekly_settlement_items wsi ON wsi.settlement_id=ws.id
    GROUP BY ws.id
    ORDER BY ws.week_start DESC
    LIMIT 52
  `);
  return r.rows;
}

export async function getWeeklySettlementItems(settlementId, status="") {
  const r = await db.query(`
    SELECT wsi.*, c.name AS captain_name, c.phone AS captain_phone,
      c.payout_name, c.payout_method, c.payout_identifier
    FROM weekly_settlement_items wsi
    JOIN captains c ON c.id=wsi.captain_id
    WHERE wsi.settlement_id=$1
      AND ($2='' OR wsi.status=$2)
    ORDER BY c.name
  `, [settlementId,status]);
  return r.rows;
}

export async function markSettlementTransferred({itemId,userId}) {
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query(`SELECT wsi.*,c.name captain_name FROM weekly_settlement_items wsi JOIN captains c ON c.id=wsi.captain_id WHERE wsi.id=$1 FOR UPDATE`,[itemId]);
    if(!q.rowCount) throw Object.assign(new Error("settlement_item_not_found"),{statusCode:404});
    const x=q.rows[0];
    if(x.status==='transferred'){
      await client.query("COMMIT");
      return x;
    }
    if(x.status!=='due') throw Object.assign(new Error("settlement_item_not_due"),{statusCode:409});
    const amount=Number((Number(x.amount_due ?? x.net ?? 0)).toFixed(3));
    let debitId=x.friday_debit_entry_id||null;
    if(amount>0){
      const ins=await client.query(`INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id) VALUES($1,$2,'FRIDAY_SETTLEMENT','debit','friday_payment',$3,$4,$5::jsonb,$6) ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL DO NOTHING RETURNING id`,[x.captain_id,-amount,String(x.id),`خصم تحويل الجمعة — ${x.captain_name}`,JSON.stringify({type:'FRIDAY_SETTLEMENT',settlementItemId:x.id}),userId||null]);
      debitId=ins.rows[0]?.id||debitId;
    }
    const r=await client.query(`UPDATE weekly_settlement_items SET status='transferred',transferred_at=NOW(),transferred_by_user_id=$2,friday_debit_entry_id=COALESCE($3,friday_debit_entry_id) WHERE id=$1 RETURNING *`,[itemId,userId||null,debitId]);
    await client.query("COMMIT");
    await audit(userId,"weekly_settlement.transferred","weekly_settlement_item",itemId,{amount,debitId});
    return r.rows[0];
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}

export async function archiveWeeklySettlement({settlementId,userId}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE weekly_settlement_items
      SET status='archived'
      WHERE settlement_id=$1 AND status='transferred'
    `,[settlementId]);
    const r = await client.query(`
      UPDATE weekly_settlements
      SET status='archived',closed_at=COALESCE(closed_at,NOW())
      WHERE id=$1
      RETURNING *
    `,[settlementId]);
    if (!r.rowCount) throw Object.assign(new Error("settlement_not_found"),{statusCode:404});
    await client.query("COMMIT");
    return r.rows[0];
  } catch(e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }
}


export async function getDailyInventoryComparison(businessDate) {
  const date = String(businessDate || ammanDateKey(new Date())).slice(0,10);
  const r = await db.query(`
    WITH auto AS (
      SELECT
        c.id AS captain_id,
        c.name,
        c.phone,
        COALESCE(SUM(CASE
          WHEN le.entry_type='RIDER_RECONCILIATION' THEN 1
          WHEN le.entry_type='PRODUCTION' AND COALESCE(le.metadata->>'type','PASSENGER') IN ('PASSENGER','RIDER') AND COALESCE(le.reference_type,'')<>'green_partial'
            THEN CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END
          ELSE 0 END),0)::int AS auto_passengers,
        COALESCE(SUM(CASE
          WHEN le.entry_type='ORDER_RECONCILIATION' THEN 1
          WHEN le.entry_type='PRODUCTION' AND COALESCE(le.metadata->>'type','')='ORDER' AND COALESCE(le.reference_type,'')<>'green_partial'
            THEN CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END
          ELSE 0 END),0)::int AS auto_orders
      FROM captains c
      LEFT JOIN ledger_entries le
        ON le.captain_id=c.id
       AND to_char(le.created_at AT TIME ZONE 'Asia/Amman','YYYY-MM-DD')=$1::text
       AND le.reversed_at IS NULL
      GROUP BY c.id,c.name,c.phone
    ),
    latest_manual AS (
      SELECT DISTINCT ON (captain_id)
        captain_id,
        manual_production_passengers,
        manual_production_orders,
        added_passengers,
        added_orders,
        note,
        created_at
      FROM inventory_reconciliations
      -- Compatibility with older Railway databases where business_date was TEXT.
      -- Comparing through ::text works for both DATE and TEXT schemas and avoids
      -- PostgreSQL's "operator does not exist: text = date" error.
      WHERE LEFT(business_date::text,10)=LEFT($1::text,10)
      ORDER BY captain_id,created_at DESC
    )
    SELECT
      a.*,
      COALESCE(lm.manual_production_passengers,0)::int AS manual_passengers,
      COALESCE(lm.manual_production_orders,0)::int AS manual_orders,
      COALESCE(lm.added_passengers,0)::int AS last_added_passengers,
      COALESCE(lm.added_orders,0)::int AS last_added_orders,
      lm.note AS last_note,
      lm.created_at AS last_reconciled_at
    FROM auto a
    LEFT JOIN latest_manual lm ON lm.captain_id=a.captain_id
    ORDER BY a.name
  `,[date]);
  return r.rows.map(x=>({
    captainId:String(x.captain_id),
    captainName:x.name,
    phone:x.phone,
    autoPassengers:Number(x.auto_passengers||0),
    autoOrders:Number(x.auto_orders||0),
    manualPassengers:Number(x.manual_passengers||0),
    manualOrders:Number(x.manual_orders||0),
    lastAddedPassengers:Number(x.last_added_passengers||0),
    lastAddedOrders:Number(x.last_added_orders||0),
    lastNote:x.last_note||"",
    lastReconciledAt:x.last_reconciled_at
  }));
}

export async function reconcileDailyInventory({
  businessDate,captainId,manualPassengers,manualOrders,addPassengers,addOrders,note,userId
}) {
  const date=String(businessDate||ammanDateKey(new Date())).slice(0,10);
  const mp=Math.max(0,Math.trunc(Number(manualPassengers)||0));
  const mo=Math.max(0,Math.trunc(Number(manualOrders)||0));
  const ap=Math.max(0,Math.trunc(Number(addPassengers)||0));
  const ao=Math.max(0,Math.trunc(Number(addOrders)||0));

  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const cap=await client.query(`SELECT id,name FROM captains WHERE id=$1 FOR UPDATE`,[captainId]);
    if(!cap.rowCount) throw Object.assign(new Error("captain_not_found"),{statusCode:404});

    const stamp=Date.now();
    if(ap>0){
      await client.query(`
        INSERT INTO ledger_entries
        (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id)
        VALUES($1,$2,'RIDER_RECONCILIATION','credit','inventory_reconciliation',$3,$4,$5::jsonb,$6)
      `,[
        captainId,Number((ap*0.75).toFixed(3)),`REC-R-${date}-${captainId}-${stamp}`,
        `تسوية فرق الجرد: إضافة ${ap} راكب`,
        JSON.stringify({type:"PASSENGER",quantity:ap,unitCommission:0.75,businessDate:date,reconciliation:true}),
        userId||null
      ]);
    }
    if(ao>0){
      await client.query(`
        INSERT INTO ledger_entries
        (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id)
        VALUES($1,$2,'ORDER_RECONCILIATION','credit','inventory_reconciliation',$3,$4,$5::jsonb,$6)
      `,[
        captainId,Number((ao*1).toFixed(3)),`REC-O-${date}-${captainId}-${stamp}`,
        `تسوية فرق الجرد: إضافة ${ao} أوردر`,
        JSON.stringify({type:"ORDER",quantity:ao,unitCommission:1,businessDate:date,reconciliation:true}),
        userId||null
      ]);
    }

    const rr=await client.query(`
      INSERT INTO inventory_reconciliations(
        business_date,captain_id,manual_production_passengers,manual_production_orders,
        auto_production_passengers,auto_production_orders,added_passengers,added_orders,
        note,created_by_user_id
      )
      VALUES(
        $1,$2,$3,$4,
        (SELECT COUNT(*)::int FROM ledger_entries le
          WHERE le.captain_id=$2 AND to_char(le.created_at AT TIME ZONE 'Asia/Amman','YYYY-MM-DD')=$1::text
            AND le.reversed_at IS NULL
            AND (le.entry_type='RIDER_RECONCILIATION'
              OR (le.entry_type='PRODUCTION' AND COALESCE(le.metadata->>'type','PASSENGER') IN ('PASSENGER','RIDER')))),
        (SELECT COUNT(*)::int FROM ledger_entries le
          WHERE le.captain_id=$2 AND to_char(le.created_at AT TIME ZONE 'Asia/Amman','YYYY-MM-DD')=$1::text
            AND le.reversed_at IS NULL
            AND (le.entry_type='ORDER_RECONCILIATION'
              OR (le.entry_type='PRODUCTION' AND COALESCE(le.metadata->>'type','')='ORDER'))),
        $5,$6,$7,$8
      )
      RETURNING *
    `,[date,captainId,mp,mo,ap,ao,note||"",userId||null]);

    await client.query(`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'inventory.reconcile','captain',$2,$3::jsonb)
    `,[userId||null,String(captainId),JSON.stringify({
      businessDate:date,manualPassengers:mp,manualOrders:mo,addedPassengers:ap,addedOrders:ao,note:note||""
    })]);

    const balance=await getBalance(captainId,client);
    await client.query("COMMIT");
    return {reconciliation:rr.rows[0],balance};
  }catch(e){
    await client.query("ROLLBACK");
    throw e;
  }finally{client.release()}
}


function normalizeJordanPhone(value) {
  let d=String(value||"").replace(/\D/g,"");
  if(d.startsWith("00962")) d=d.slice(2);
  if(d.startsWith("962")) d=d.slice(3);
  if(d.startsWith("0")) d=d.slice(1);
  return d;
}

function normalizeGoogleStatus(value) {
  const s=String(value||"").trim().toLowerCase();
  if(s.includes("مجم") || s.includes("frozen")) return "frozen";
  if(s.includes("موق") || s.includes("disabled")) return "disabled";
  return "active";
}

export async function saveMigrationSnapshot(payload={}) {
  const captains=Array.isArray(payload.captains)?payload.captains:[];
  const inventory=Array.isArray(payload.inventory)?payload.inventory:[];
  const totalBalance=captains.reduce((sum,c)=>sum+(Number(c.balance)||0),0);
  const sourceUpdatedAt=payload.sourceUpdatedAt ? new Date(payload.sourceUpdatedAt) : new Date();

  const r=await db.query(`
    INSERT INTO migration_snapshots(
      source,spreadsheet_id,captain_count,total_balance,movement_count,
      inventory_count,source_updated_at,payload
    )
    VALUES('google_sheets',$1,$2,$3,$4,$5,$6,$7::jsonb)
    RETURNING *
  `,[
    payload.spreadsheetId||null,
    captains.length,
    Number(totalBalance.toFixed(3)),
    Math.max(0,Number(payload.movementCount)||0),
    inventory.length,
    sourceUpdatedAt,
    JSON.stringify(payload)
  ]);

  // Keep the table compact. The most recent 100 snapshots are enough for comparison/history.
  await db.query(`
    DELETE FROM migration_snapshots
    WHERE id NOT IN (SELECT id FROM migration_snapshots ORDER BY received_at DESC LIMIT 100)
  `);

  return r.rows[0];
}

export async function getLatestMigrationSnapshot() {
  const r=await db.query(`SELECT * FROM migration_snapshots ORDER BY received_at DESC LIMIT 1`);
  return r.rows[0]||null;
}

export async function getMigrationComparison() {
  const snapshot=await getLatestMigrationSnapshot();
  const pgCaptains=await listCaptains("");
  const pgMovement=await db.query(`
    SELECT
      COUNT(*) FILTER(WHERE reference_type='legacy_sheet')::int AS migrated_count,
      COUNT(*)::int AS total_count,
      MAX(created_at) AS last_at
    FROM ledger_entries
    WHERE reversed_at IS NULL
  `);

  if(!snapshot){
    return {
      connected:false,ready:false,reason:"no_google_snapshot",
      postgres:{
        captainCount:pgCaptains.length,
        totalBalance:Number(pgCaptains.reduce((s,c)=>s+Number(c.balance||0),0).toFixed(3)),
        movementCount:Number(pgMovement.rows[0]?.migrated_count||0),
        totalLedgerCount:Number(pgMovement.rows[0]?.total_count||0),
        lastMovementAt:pgMovement.rows[0]?.last_at||null
      },
      rows:[]
    };
  }

  const payload=snapshot.payload||{};
  const googleCaptains=Array.isArray(payload.captains)?payload.captains:[];
  const googleInventory=Array.isArray(payload.inventory)?payload.inventory:[];
  const pgByPhone=new Map(pgCaptains.map(c=>[normalizeJordanPhone(c.phone),c]));
  const invByPhone=new Map(googleInventory.map(x=>[normalizeJordanPhone(x.phone),x]));

  const pgActivity=await db.query(`
    SELECT
      c.id,
      c.phone,
      COALESCE(SUM(
        CASE WHEN le.entry_type IN ('RIDER_RECONCILIATION')
          OR (le.entry_type='PRODUCTION' AND COALESCE(le.metadata->>'type','PASSENGER') IN ('PASSENGER','RIDER'))
        THEN COALESCE(NULLIF(le.metadata->>'quantity','')::numeric,1) ELSE 0 END
      ),0)::int AS production_passengers,
      COALESCE(SUM(
        CASE WHEN le.entry_type='ORDER_RECONCILIATION'
          OR (le.entry_type='PRODUCTION' AND COALESCE(le.metadata->>'type','')='ORDER')
        THEN COALESCE(NULLIF(le.metadata->>'quantity','')::numeric,1) ELSE 0 END
      ),0)::int AS production_orders
    FROM captains c
    LEFT JOIN ledger_entries le
      ON le.captain_id=c.id AND le.reversed_at IS NULL
    GROUP BY c.id,c.phone
  `);
  const pgActivityByPhone=new Map(pgActivity.rows.map(x=>[normalizeJordanPhone(x.phone),x]));

  const rows=googleCaptains.map(g=>{
    const phone=normalizeJordanPhone(g.phone);
    const p=pgByPhone.get(phone)||null;
    const gi=invByPhone.get(phone)||null;
    const pa=pgActivityByPhone.get(phone)||null;

    const googleBalance=Number(g.balance)||0;
    const pgBalance=p?Number(p.balance||0):null;
    const balanceDiff=p?Number((pgBalance-googleBalance).toFixed(3)):null;
    const statusMatch=p?normalizeGoogleStatus(g.status)===String(p.status||"").toLowerCase():false;

    const gp=Number(gi?.productionPassengers||0);
    const go=Number(gi?.productionOrders||0);
    const pp=Number(pa?.production_passengers||0);
    const po=Number(pa?.production_orders||0);

    return {
      externalId:g.id||"",
      captainName:g.name||"",
      phone:g.phone||"",
      googleBalance,
      postgresBalance:pgBalance,
      balanceDiff,
      googleStatus:g.status||"",
      postgresStatus:p?.status||"",
      statusMatch,
      existsInPostgres:Boolean(p),
      googleProductionPassengers:gp,
      postgresProductionPassengers:pp,
      passengerDiff:pp-gp,
      googleProductionOrders:go,
      postgresProductionOrders:po,
      orderDiff:po-go
    };
  });

  // PostgreSQL captains not present in Google.
  const googlePhones=new Set(googleCaptains.map(x=>normalizeJordanPhone(x.phone)));
  const postgresOnly=pgCaptains
    .filter(p=>!googlePhones.has(normalizeJordanPhone(p.phone)))
    .map(p=>({
      captainName:p.name,phone:p.phone,postgresBalance:Number(p.balance||0),
      postgresStatus:p.status
    }));

  const googleTotal=googleCaptains.reduce((s,c)=>s+(Number(c.balance)||0),0);
  const pgTotal=pgCaptains.reduce((s,c)=>s+Number(c.balance||0),0);
  const matched=rows.filter(x=>x.existsInPostgres).length;
  const exactBalances=rows.filter(x=>x.existsInPostgres && Math.abs(Number(x.balanceDiff||0))<0.0005).length;
  const exactStatuses=rows.filter(x=>x.existsInPostgres && x.statusMatch).length;
  const missing=rows.filter(x=>!x.existsInPostgres).length;
  const diffRows=rows.filter(x=>!x.existsInPostgres || Math.abs(Number(x.balanceDiff||0))>=0.0005 || !x.statusMatch).length;
  const ageSeconds=Math.max(0,(Date.now()-new Date(snapshot.received_at).getTime())/1000);
  const balanceDifference=Number((pgTotal-googleTotal).toFixed(3));
  const pgMovementCount=Number(pgMovement.rows[0]?.migrated_count||0);
  const pgTotalLedgerCount=Number(pgMovement.rows[0]?.total_count||0);
  const googleMovementCount=Number(snapshot.movement_count||0);

  return {
    connected:true,
    ready:
      ageSeconds<=600 &&
      missing===0 &&
      postgresOnly.length===0 &&
      diffRows===0 &&
      Math.abs(balanceDifference)<0.0005 &&
      pgMovementCount===googleMovementCount,
    snapshot:{
      id:snapshot.id,
      spreadsheetId:snapshot.spreadsheet_id,
      receivedAt:snapshot.received_at,
      sourceUpdatedAt:snapshot.source_updated_at,
      ageSeconds:Math.round(ageSeconds)
    },
    google:{
      captainCount:googleCaptains.length,
      totalBalance:Number(googleTotal.toFixed(3)),
      movementCount:googleMovementCount,
      inventoryCount:Number(snapshot.inventory_count||0)
    },
    postgres:{
      captainCount:pgCaptains.length,
      totalBalance:Number(pgTotal.toFixed(3)),
      movementCount:pgMovementCount,
      totalLedgerCount:pgTotalLedgerCount,
      lastMovementAt:pgMovement.rows[0]?.last_at||null
    },
    summary:{
      matched,exactBalances,exactStatuses,missing,postgresOnly:postgresOnly.length,
      diffRows,balanceDifference,
      movementDifference:pgMovementCount-googleMovementCount
    },
    rows,
    postgresOnly
  };
}

export async function getCaptainFullProfileData(captainId) {
  const cleanStartAt=await getCleanStartOperationalCutover();
  const c=await db.query(`
    SELECT c.*,
      COALESCE(SUM(le.amount),0)::numeric(12,3) AS balance
    FROM captains c
    LEFT JOIN ledger_entries le ON le.captain_id=c.id
    WHERE c.id=$1
    GROUP BY c.id
  `,[captainId]);
  if(!c.rowCount) return null;

  const summary=await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE reversed_at IS NULL)::int AS movement_count,
      COALESCE(SUM(CASE WHEN reversed_at IS NULL AND amount>0 THEN amount ELSE 0 END),0)::numeric(12,3) AS total_credit,
      COALESCE(SUM(CASE WHEN reversed_at IS NULL AND amount<0 THEN ABS(amount) ELSE 0 END),0)::numeric(12,3) AS total_debit,
      COALESCE(SUM(CASE WHEN reversed_at IS NULL AND entry_type='PRODUCTION'
        THEN COALESCE(NULLIF(metadata->>'quantity','')::numeric,1) ELSE 0 END),0)::int AS production_count,
      COALESCE(SUM(CASE WHEN reversed_at IS NULL AND entry_type='CONSUMPTION'
        THEN COALESCE(NULLIF(metadata->>'quantity','')::numeric,1) ELSE 0 END),0)::int AS consumption_count,
      COALESCE(SUM(CASE WHEN reversed_at IS NULL AND (
        entry_type='ORDER_RECONCILIATION'
        OR entry_type='ORDER_COMMISSION'
        OR (entry_type='PRODUCTION' AND COALESCE(metadata->>'type','')='ORDER')
      ) THEN COALESCE(NULLIF(metadata->>'quantity','')::numeric,1) ELSE 0 END),0)::int AS order_count,
      COALESCE(SUM(CASE WHEN reversed_at IS NULL AND (
        entry_type='RIDER_RECONCILIATION'
        OR entry_type='RIDER_COMMISSION'
        OR (entry_type='PRODUCTION' AND COALESCE(metadata->>'type','PASSENGER') IN ('PASSENGER','RIDER'))
      ) THEN COALESCE(NULLIF(metadata->>'quantity','')::numeric,1) ELSE 0 END),0)::int AS rider_count,
      MAX(created_at) FILTER (WHERE reversed_at IS NULL) AS last_movement_at
    FROM ledger_entries WHERE captain_id=$1
      AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz OR entry_type='RECHARGE')
      AND entry_type<>'CLEAN_START_RESET'
  `,[captainId,cleanStartAt]);

  const week=await db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0)::numeric(12,3) AS credit,
      COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0)::numeric(12,3) AS debit,
      COUNT(*)::int AS movements
    FROM ledger_entries
    WHERE captain_id=$1 AND reversed_at IS NULL AND created_at>=NOW()-INTERVAL '7 days'
      AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
      AND entry_type<>'CLEAN_START_RESET'
  `,[captainId,cleanStartAt]);

  const ledger=await db.query(`
    SELECT * FROM ledger_entries
    WHERE captain_id=$1
      AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz OR entry_type='RECHARGE')
      AND entry_type<>'CLEAN_START_RESET'
    ORDER BY created_at DESC LIMIT 100
  `,[captainId,cleanStartAt]);

  const settlements=await db.query(`
    SELECT wsi.*,ws.week_start,ws.week_end,ws.status AS settlement_status
    FROM weekly_settlement_items wsi
    JOIN weekly_settlements ws ON ws.id=wsi.settlement_id
    WHERE wsi.captain_id=$1
      AND ($2::timestamptz IS NULL OR ws.created_at >= $2::timestamptz)
    ORDER BY ws.week_end DESC LIMIT 30
  `,[captainId,cleanStartAt]);

  const recharges=await db.query(`
    SELECT 'code' AS source, rc.amount, rc.status, rc.code AS reference,
           rc.created_at,rc.used_at AS completed_at
    FROM recharge_codes rc WHERE rc.used_by_captain_id=$1
    UNION ALL
    SELECT 'request' AS source, rr.amount, rr.status, COALESCE(rr.reference_text,'') AS reference,
           rr.created_at,rr.reviewed_at AS completed_at
    FROM recharge_requests rr WHERE rr.captain_id=$1
    ORDER BY created_at DESC LIMIT 50
  `,[captainId]);

  const rec=await db.query(`
    SELECT * FROM inventory_reconciliations
    WHERE captain_id=$1
      AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
    ORDER BY created_at DESC LIMIT 30
  `,[captainId,cleanStartAt]);

  const account=await db.query(`
    SELECT id,username,role,is_active,created_at,updated_at
    FROM users WHERE captain_id=$1 AND role='captain'
    ORDER BY id DESC LIMIT 1
  `,[captainId]);

  return {
    captain:c.rows[0],
    summary:summary.rows[0]||{},
    last7Days:week.rows[0]||{},
    ledger:ledger.rows,
    settlements:settlements.rows,
    recharges:recharges.rows,
    reconciliations:rec.rows,
    account:account.rows[0]||null
  };
}


export async function traceWebhookEvent(idMessage, stage, details={}) {
  if(!idMessage) return;
  await db.query(`
    INSERT INTO whatsapp_event_traces(id_message,stage,details)
    VALUES($1,$2,$3::jsonb)
  `,[String(idMessage),String(stage),JSON.stringify(details||{})]);
}

export async function saveDeadLetter({idMessage,payload,error,attempts}) {
  if(!idMessage) return null;
  const r=await db.query(`
    INSERT INTO whatsapp_dead_letters(id_message,payload,last_error,attempts,status,failed_at)
    VALUES($1,$2::jsonb,$3,$4,'pending',NOW())
    ON CONFLICT(id_message) DO UPDATE SET
      payload=EXCLUDED.payload,
      last_error=EXCLUDED.last_error,
      attempts=GREATEST(whatsapp_dead_letters.attempts,EXCLUDED.attempts),
      status='pending',
      failed_at=NOW(),
      replayed_at=NULL,
      resolved_at=NULL,
      resolved_by_user_id=NULL
    RETURNING *
  `,[String(idMessage),JSON.stringify(payload||{}),String(error||"unknown").slice(0,8000),Math.max(1,Number(attempts)||1)]);
  return r.rows[0];
}

export async function listDeadLetters(limit=100,status="pending") {
  const r=await db.query(`
    SELECT * FROM whatsapp_dead_letters
    WHERE ($1='' OR status=$1)
    ORDER BY failed_at DESC
    LIMIT $2
  `,[String(status||""),Math.min(Number(limit)||100,500)]);
  return r.rows;
}

export async function markDeadLetterReplayed(idMessage,userId=null) {
  await db.query(`
    UPDATE whatsapp_dead_letters
    SET status='replayed',replayed_at=NOW(),resolved_by_user_id=$2
    WHERE id_message=$1
  `,[String(idMessage),userId||null]);
  await db.query(`
    UPDATE whatsapp_events
    SET replay_count=replay_count+1,last_replayed_at=NOW(),status='queued'
    WHERE id_message=$1
  `,[String(idMessage)]);
  await audit(userId,"whatsapp.replay","whatsapp_event",idMessage,{});
}

export async function resolveDeadLetter(idMessage,userId=null) {
  await db.query(`
    UPDATE whatsapp_dead_letters
    SET status='resolved',resolved_at=NOW(),resolved_by_user_id=$2
    WHERE id_message=$1
  `,[String(idMessage),userId||null]);
  await audit(userId,"whatsapp.dead_letter.resolve","whatsapp_event",idMessage,{});
}

export async function getWebhookDiagnostic(idMessage) {
  const ev=await db.query(`SELECT * FROM whatsapp_events WHERE id_message=$1`,[String(idMessage)]);
  if(!ev.rowCount) return null;
  const traces=await db.query(`
    SELECT stage,details,created_at
    FROM whatsapp_event_traces
    WHERE id_message=$1 ORDER BY created_at ASC LIMIT 300
  `,[String(idMessage)]);
  const dlq=await db.query(`SELECT * FROM whatsapp_dead_letters WHERE id_message=$1`,[String(idMessage)]);
  const refs=await db.query(`
    SELECT id,captain_id,amount,entry_type,reference_type,reference_id,description,metadata,reversed_at,created_at
    FROM ledger_entries
    WHERE reference_id=$1
       OR reference_id LIKE $2
       OR metadata::text ILIKE $3
    ORDER BY created_at ASC
    LIMIT 100
  `,[String(idMessage),`%${String(idMessage)}%`,`%${String(idMessage)}%`]);

  const e=ev.rows[0];
  return {
    event:e,
    traces:traces.rows,
    deadLetter:dlq.rows[0]||null,
    ledgerEntries:refs.rows,
    timings:{
      receiveToQueueMs:e.queued_at?new Date(e.queued_at)-new Date(e.webhook_received_at):null,
      queueToStartMs:e.processing_started_at&&e.queued_at?new Date(e.processing_started_at)-new Date(e.queued_at):null,
      processingMs:e.processed_at&&e.processing_started_at?new Date(e.processed_at)-new Date(e.processing_started_at):null,
      endToEndMs:e.processed_at?new Date(e.processed_at)-new Date(e.webhook_received_at):null
    }
  };
}

export async function getReliabilityStats() {
  const [events,dead,traces]=await Promise.all([
    db.query(`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(duplicate_count),0)::int AS duplicates_prevented,
        COALESCE(SUM(replay_count),0)::int AS replays,
        COUNT(*) FILTER(WHERE status='failed')::int AS failed,
        COUNT(*) FILTER(WHERE status IN ('received','queued','processing'))::int AS pending,
        AVG(EXTRACT(EPOCH FROM(processed_at-webhook_received_at))*1000)
          FILTER(WHERE processed_at IS NOT NULL)::numeric(12,1) AS avg_end_to_end_ms,
        MAX(webhook_received_at) AS last_webhook_at,
        MAX(processed_at) AS last_processed_at
      FROM whatsapp_events
    `),
    db.query(`
      SELECT
        COUNT(*) FILTER(WHERE status='pending')::int AS pending,
        COUNT(*) FILTER(WHERE status='replayed')::int AS replayed,
        COUNT(*) FILTER(WHERE status='resolved')::int AS resolved
      FROM whatsapp_dead_letters
    `),
    db.query(`SELECT COUNT(*)::int AS count FROM whatsapp_event_traces WHERE created_at>=NOW()-INTERVAL '24 hours'`)
  ]);
  return {
    events:events.rows[0],
    deadLetters:dead.rows[0],
    traces24h:Number(traces.rows[0]?.count||0)
  };
}

export async function getWebhookPayload(idMessage) {
  const r=await db.query(`SELECT raw_payload FROM whatsapp_events WHERE id_message=$1`,[String(idMessage)]);
  return r.rows[0]?.raw_payload||null;
}


function migText(v){return String(v??"").trim()}
function migNum(v){
  const s=String(v??"").replace(/٫/g,".").replace(/٬/g,"").replace(/,/g,"")
    .replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[^\d.\-]/g,"");
  const n=Number(s);return Number.isFinite(n)?n:0;
}
function migInt(v){return Math.trunc(migNum(v))}
function migStatus(v){
  const s=migText(v).toLowerCase();
  if(s.includes("مجم")||s.includes("frozen"))return "frozen";
  if(s.includes("معطل")||s.includes("موق")||s.includes("disabled"))return "disabled";
  return "active";
}
function migBool(v){
  const s=migText(v).toLowerCase();
  return ["نعم","yes","true","1","active","فعال"].includes(s);
}
function migTs(v){
  const s=migText(v);
  if(!s)return null;
  if(/[zZ]|[+-]\d\d:?\d\d$/.test(s))return new Date(s);
  const normalized=s.replace(" ","T");
  const d=new Date(normalized+"+03:00");
  return Number.isNaN(d.getTime())?null:d;
}
function migJson(v,fallback={}){
  if(v&&typeof v==="object")return v;
  try{return JSON.parse(String(v||""));}catch{return fallback}
}
function migMovementType(v){
  const s=migText(v);
  if(s.includes("أوردر")||s.includes("اوردر")||s.toLowerCase().includes("order"))return "ORDER";
  if(s.includes("راكب")||s.toLowerCase().includes("rider")||s.toLowerCase().includes("passenger"))return "PASSENGER";
  return "MANUAL";
}
function migMovementDirection(v,total){
  const s=migText(v);
  if(s.includes("استهلاك")||s.includes("خصم")||s.includes("سحب"))return "debit";
  if(s.includes("إنتاج")||s.includes("انتاج")||s.includes("شحن")||s.includes("استرجاع")||s.includes("إضافة")||s.includes("اضافة"))return "credit";
  return Number(total)<0?"debit":"credit";
}

export async function startFullMigrationRun({runKey,spreadsheetId,sourceTitle,expectedSheets=[],runMode="full",cutoverAt=null,repairFromAt=null}) {
  const key=migText(runKey);
  if(!key)throw Object.assign(new Error("run_key_required"),{statusCode:400});
  const mode=migText(runMode)||"full";
  const cutover=cutoverAt?new Date(cutoverAt):null;
  const repairFrom=repairFromAt?new Date(repairFromAt):null;
  if(cutover && !Number.isFinite(cutover.getTime()))throw Object.assign(new Error("invalid_cutover_at"),{statusCode:400});
  if(repairFrom && !Number.isFinite(repairFrom.getTime()))throw Object.assign(new Error("invalid_repair_from_at"),{statusCode:400});
  const r=await db.query(`
    INSERT INTO full_migration_runs(run_key,spreadsheet_id,source_title,expected_sheets,run_mode,cutover_at,repair_from_at)
    VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
    ON CONFLICT(run_key) DO UPDATE SET
      spreadsheet_id=EXCLUDED.spreadsheet_id,
      source_title=EXCLUDED.source_title,
      expected_sheets=EXCLUDED.expected_sheets,
      run_mode=EXCLUDED.run_mode,
      cutover_at=COALESCE(EXCLUDED.cutover_at,full_migration_runs.cutover_at),
      repair_from_at=COALESCE(EXCLUDED.repair_from_at,full_migration_runs.repair_from_at),
      updated_at=NOW()
    RETURNING *
  `,[key,spreadsheetId||null,sourceTitle||null,JSON.stringify(expectedSheets||[]),mode,cutover?cutover.toISOString():null,repairFrom?repairFrom.toISOString():null]);
  return r.rows[0];
}

export async function stageFullMigrationBatch({runKey,sheetName,rows=[]}) {
  const run=await db.query(`SELECT * FROM full_migration_runs WHERE run_key=$1`,[migText(runKey)]);
  if(!run.rowCount)throw Object.assign(new Error("migration_run_not_found"),{statusCode:404});
  const runId=run.rows[0].id;
  const cleanRows=(Array.isArray(rows)?rows:[]).filter(x=>Number(x?.rowNumber)>=2 && x?.data && typeof x.data==="object");
  if(cleanRows.length){
    await db.query(`
      INSERT INTO full_migration_stage_rows(run_id,sheet_name,row_number,row_data)
      SELECT $1,$2,(x->>'rowNumber')::int,x->'data'
      FROM jsonb_array_elements($3::jsonb) x
      ON CONFLICT(run_id,sheet_name,row_number) DO UPDATE SET row_data=EXCLUDED.row_data
    `,[runId,migText(sheetName),JSON.stringify(cleanRows)]);
  }
  const cnt=await db.query(`SELECT COUNT(*)::int AS n FROM full_migration_stage_rows WHERE run_id=$1 AND sheet_name=$2`,[runId,migText(sheetName)]);
  await db.query(`
    UPDATE full_migration_runs
    SET uploaded_sheets=jsonb_set(uploaded_sheets,ARRAY[$2],to_jsonb($3::int),true),updated_at=NOW()
    WHERE id=$1
  `,[runId,migText(sheetName),Number(cnt.rows[0]?.n||0)]);
  return {runId,count:Number(cnt.rows[0]?.n||0)};
}

export async function completeFullMigrationUpload(runKey) {
  const r=await db.query(`
    UPDATE full_migration_runs
    SET status='uploaded',upload_completed_at=NOW(),updated_at=NOW()
    WHERE run_key=$1
    RETURNING *
  `,[migText(runKey)]);
  if(!r.rowCount)throw Object.assign(new Error("migration_run_not_found"),{statusCode:404});
  return r.rows[0];
}


export async function setFullMigrationCutoverMeta(runKey,{cutoverAt=null,repairFromAt=null}={}) {
  const cutover=cutoverAt?new Date(cutoverAt):null;
  const repairFrom=repairFromAt?new Date(repairFromAt):null;
  if(cutover && !Number.isFinite(cutover.getTime()))throw Object.assign(new Error("invalid_cutover_at"),{statusCode:400});
  if(repairFrom && !Number.isFinite(repairFrom.getTime()))throw Object.assign(new Error("invalid_repair_from_at"),{statusCode:400});
  const r=await db.query(`
    UPDATE full_migration_runs SET
      cutover_at=COALESCE($2,cutover_at),
      repair_from_at=COALESCE($3,repair_from_at),
      updated_at=NOW()
    WHERE run_key=$1
    RETURNING *
  `,[migText(runKey),cutover?cutover.toISOString():null,repairFrom?repairFrom.toISOString():null]);
  if(!r.rowCount)throw Object.assign(new Error("migration_run_not_found"),{statusCode:404});
  return r.rows[0];
}

export async function getFullMigrationStatus(runKey=null) {
  const r=runKey
    ? await db.query(`SELECT * FROM full_migration_runs WHERE run_key=$1`,[migText(runKey)])
    : await db.query(`SELECT * FROM full_migration_runs ORDER BY id DESC LIMIT 1`);
  if(!r.rowCount)return null;
  const run=r.rows[0];
  const counts=await db.query(`
    SELECT sheet_name,COUNT(*)::int AS rows
    FROM full_migration_stage_rows WHERE run_id=$1
    GROUP BY sheet_name ORDER BY sheet_name
  `,[run.id]);
  const live=await db.query(`
    SELECT
      (SELECT COUNT(*) FROM captains)::int AS captains,
      (SELECT COUNT(*) FROM users WHERE role='captain')::int AS captain_users,
      (SELECT COUNT(*) FROM users WHERE role IN ('admin','accountant'))::int AS staff_users,
      (SELECT COUNT(*) FROM ledger_entries WHERE reference_type='legacy_sheet')::int AS legacy_movements,
      (SELECT COUNT(*) FROM recharge_codes WHERE legacy_id IS NOT NULL)::int AS legacy_codes,
      (SELECT COUNT(*) FROM recharge_requests WHERE legacy_id IS NOT NULL)::int AS legacy_transfers,
      (SELECT COUNT(*) FROM weekly_settlement_items WHERE legacy_id IS NOT NULL)::int AS legacy_settlements,
      (SELECT COUNT(*) FROM whatsapp_events WHERE status LIKE 'legacy_%')::int AS legacy_whatsapp
  `);
  const finalMode=String(run.run_mode||'').toLowerCase()==='final_week_cutover' && run.cutover_at;
  const balanceCheck=finalMode
    ? await db.query(`
      WITH targets AS (
        SELECT c.id,mig.row_data->>'الرصيد' AS target_text
        FROM full_migration_stage_rows mig
        JOIN captains c ON c.legacy_id=mig.row_data->>'المعرّف'
        WHERE mig.run_id=$1 AND mig.sheet_name='الكباتن'
      ), actual AS (
        SELECT c.id,COALESCE(SUM(le.amount) FILTER(
          WHERE le.reversed_at IS NULL AND (
            le.reference_type='migration_balance' OR le.reference_type IN ('legacy_sheet','legacy_balance_addition') OR le.created_at < $2
          )
        ),0)::numeric(16,3) AS actual
        FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id
        GROUP BY c.id
      )
      SELECT COUNT(*)::int AS compared,
        COUNT(*) FILTER(WHERE ABS(a.actual-
          COALESCE(NULLIF(regexp_replace(replace(t.target_text,'٫','.'),'[^0-9.-]','','g'),'')::numeric,0)
        )<0.0005)::int AS matched
      FROM targets t JOIN actual a ON a.id=t.id
    `,[run.id,run.cutover_at])
    : await db.query(`
      WITH targets AS (
        SELECT
          c.id,
          mig.row_data->>'الرصيد' AS target_text
        FROM full_migration_stage_rows mig
        JOIN captains c ON c.legacy_id=mig.row_data->>'المعرّف'
        WHERE mig.run_id=$1 AND mig.sheet_name='الكباتن'
      ),
      actual AS (
        SELECT c.id,COALESCE(SUM(le.amount) FILTER(WHERE le.reversed_at IS NULL),0)::numeric(16,3) AS actual
        FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id
        GROUP BY c.id
      )
      SELECT COUNT(*)::int AS compared,
        COUNT(*) FILTER(WHERE ABS(a.actual -
          COALESCE(NULLIF(regexp_replace(replace(t.target_text,'٫','.'),'[^0-9.-]','','g'),'')::numeric,0)
        )<0.0005)::int AS matched
      FROM targets t JOIN actual a ON a.id=t.id
    `,[run.id]);
  return {
    ...run,
    sheetCounts:Object.fromEntries(counts.rows.map(x=>[x.sheet_name,Number(x.rows)])),
    live:live.rows[0],
    balanceCheck:balanceCheck.rows[0]
  };
}

async function migrationRows(runId,sheetName,offset,limit){
  const r=await db.query(`
    SELECT row_number,row_data
    FROM full_migration_stage_rows
    WHERE run_id=$1 AND sheet_name=$2
    ORDER BY row_number
    OFFSET $3 LIMIT $4
  `,[runId,sheetName,offset,limit]);
  return r.rows;
}

async function migrationSetProgress(runId,phase,offset,countDelta=0){
  await db.query(`
    UPDATE full_migration_runs SET
      status='applying',
      apply_phase=$2,
      apply_offset=$3,
      apply_started_at=COALESCE(apply_started_at,NOW()),
      apply_counts=jsonb_set(
        apply_counts,ARRAY[$2],
        to_jsonb(COALESCE((apply_counts->>$2)::int,0)+$4::int),true
      ),
      updated_at=NOW()
    WHERE id=$1
  `,[runId,phase,offset,countDelta]);
}

async function migrationAdvance(runId,nextPhase){
  await db.query(`
    UPDATE full_migration_runs
    SET apply_phase=$2,apply_offset=0,updated_at=NOW()
    WHERE id=$1
  `,[runId,nextPhase]);
}

async function applyCaptainsBatch(run,userId){
  const rows=await migrationRows(run.id,"الكباتن",run.apply_offset,25);
  if(!rows.length){await migrationAdvance(run.id,"staff");return {advanced:true,phase:"staff"}}
  const rounds=Math.max(8,Math.min(12,Number(process.env.MIGRATION_BCRYPT_ROUNDS||10)));
  for(const {row_data:r} of rows){
    const legacyId=migText(r["المعرّف"]),name=migText(r["الاسم الكامل"]),phone=migText(r["رقم الهاتف"]);
    if(!legacyId||!name||!phone)continue;
    const status=migStatus(r["الحالة"]);
    const balanceMode=migText(r["فئة الرصيد"]).includes("سالب")?"OPEN_NEGATIVE":"PREPAID";
    const createdAt=migTs(r["تاريخ الإنشاء"])||new Date();
    const updatedAt=migTs(r["آخر تحديث"])||createdAt;
    const lastLogin=migTs(r["آخر تسجيل دخول"]);
    const cap=await db.query(`
      INSERT INTO captains(
        legacy_id,name,phone,status,notes,payout_name,payout_method,payout_identifier,
        balance_mode,group_state,status_reason,legacy_last_login_at,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(phone) DO UPDATE SET
        legacy_id=EXCLUDED.legacy_id,name=EXCLUDED.name,status=EXCLUDED.status,
        notes=EXCLUDED.notes,payout_name=EXCLUDED.payout_name,payout_method=EXCLUDED.payout_method,
        payout_identifier=EXCLUDED.payout_identifier,balance_mode=EXCLUDED.balance_mode,
        group_state=EXCLUDED.group_state,status_reason=EXCLUDED.status_reason,
        legacy_last_login_at=EXCLUDED.legacy_last_login_at,
        updated_at=EXCLUDED.updated_at
      RETURNING id
    `,[legacyId,name,phone,status,migText(r["سبب الحالة"])||null,
       migText(r["اسم مستفيد التحويل"])||null,migText(r["طريقة التحويل"])||null,
       migText(r["رقم أو معرّف التحويل"])||null,balanceMode,migText(r["حالة القروب"])||null,
       migText(r["سبب الحالة"])||null,lastLogin,createdAt,updatedAt]);
    const captainId=cap.rows[0].id;
    const password=migText(r["كلمة المرور"]).trim();
    if(password){
      const hash=await bcrypt.hash(password,rounds);
      await db.query(`
        INSERT INTO users(username,password_hash,role,captain_id,is_active,legacy_id,display_name,created_at,updated_at,last_login_at)
        VALUES($1,$2,'captain',$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(username) DO UPDATE SET
          password_hash=EXCLUDED.password_hash,role='captain',captain_id=EXCLUDED.captain_id,
          is_active=EXCLUDED.is_active,legacy_id=EXCLUDED.legacy_id,
          display_name=EXCLUDED.display_name,updated_at=EXCLUDED.updated_at,last_login_at=EXCLUDED.last_login_at
        WHERE users.role='captain' AND (users.captain_id IS NULL OR users.captain_id=EXCLUDED.captain_id)
      `,[phone,hash,captainId,status!=="disabled",legacyId,name,createdAt,updatedAt,lastLogin]);
    }
  }
  await migrationSetProgress(run.id,"captains",run.apply_offset+rows.length,rows.length);
  return {phase:"captains",processed:rows.length};
}

async function applyStaffBatch(run,userId){
  const rows=await migrationRows(run.id,"المحاسبون",run.apply_offset,20);
  if(!rows.length){await migrationAdvance(run.id,"movements");return {advanced:true,phase:"movements"}}
  const rounds=Math.max(8,Math.min(12,Number(process.env.MIGRATION_BCRYPT_ROUNDS||10)));
  for(const {row_data:r} of rows){
    const legacyId=migText(r["المعرّف"]),username=migText(r["اسم المستخدم"]),displayName=migText(r["الاسم"]);
    if(!username)continue;
    const password=migText(r["كلمة المرور"]).trim();
    const active=migBool(r["الحالة"]);
    const role=username.toLowerCase()==="admin"?"admin":"accountant";
    const existing=await db.query(`SELECT id FROM users WHERE username=$1`,[username]);
    if(existing.rowCount){
      // Preserve the already-working Railway admin password so migration cannot lock the owner out.
      await db.query(`
        UPDATE users SET legacy_id=$2,display_name=$3,role=$4,is_active=$5,updated_at=NOW()
        WHERE id=$1
      `,[existing.rows[0].id,legacyId||null,displayName||null,role,active]);
    }else if(password){
      const hash=await bcrypt.hash(password,rounds);
      await db.query(`
        INSERT INTO users(username,password_hash,role,is_active,legacy_id,display_name,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      `,[username,hash,role,active,legacyId||null,displayName||null,migTs(r["تاريخ الإنشاء"])||new Date(),migTs(r["آخر تحديث"])||new Date()]);
    }
  }
  await migrationSetProgress(run.id,"staff",run.apply_offset+rows.length,rows.length);
  return {phase:"staff",processed:rows.length};
}

async function applyMovementBatch(run,userId){
  const rows=await migrationRows(run.id,"الحركات",run.apply_offset,350);
  if(!rows.length){
    await db.query(`
      UPDATE ledger_entries reversal SET entry_type='REVERSAL',reversed_entry_id=original.id,metadata=COALESCE(reversal.metadata,'{}'::jsonb)||jsonb_build_object('originalEntryType',original.entry_type,'normalizedLegacyReversal',true)
      FROM ledger_entries original
      WHERE reversal.reference_type='legacy_sheet' AND original.reference_type='legacy_sheet' AND reversal.reversed_entry_id IS NULL
        AND original.reference_id=substring(COALESCE(reversal.description,'') from 'UNDO_OF:([^ ]+)');
      UPDATE ledger_entries original SET reversed_at=reversal.created_at FROM ledger_entries reversal WHERE reversal.reversed_entry_id=original.id AND original.reversed_at IS NULL;
    `);
    await migrationAdvance(run.id,"balance_additions");return {advanced:true,phase:"balance_additions"}
  }
  const mapRows=await db.query(`SELECT id,legacy_id FROM captains WHERE legacy_id IS NOT NULL`);
  const capMap=new Map(mapRows.rows.map(x=>[x.legacy_id,String(x.id)]));
  const values=[],params=[];let p=1;
  for(const {row_data:r} of rows){
    const captainId=capMap.get(migText(r["معرّف الكابتن"]));
    const legacyMovementId=migText(r["المعرّف"]);
    if(!captainId||!legacyMovementId)continue;
    const total=Math.abs(migNum(r["إجمالي الحركة"]));
    const direction=migMovementDirection(r["تصنيف الحركة"],total);
    const amount=direction==="debit"?-total:total;
    const mtype=migMovementType(r["نوع الحركة"]);
    const entryType=direction==="credit"?"PRODUCTION":"CONSUMPTION";
    const meta={
      migration:true,legacyId:legacyMovementId,type:mtype,
      quantity:Math.max(1,migInt(r["العدد"])||1),
      unitCommission:Math.abs(migNum(r["قيمة الوحدة"])),
      balanceBefore:migNum(r["الرصيد قبل"]),balanceAfter:migNum(r["الرصيد بعد"]),
      recordedBy:migText(r["سجّلها"]),dedupeKey:migText(r["مفتاح منع التكرار"])
    };
    values.push(`($${p++},$${p++},$${p++},$${p++},'legacy_sheet',$${p++},$${p++},$${p++}::jsonb,$${p++})`);
    params.push(Number(captainId),amount,entryType,direction,legacyMovementId,migText(r["ملاحظة"])||`Legacy ${entryType}`,JSON.stringify(meta),migTs(r["تاريخ الإنشاء"])||new Date());
  }
  if(values.length){
    await db.query(`
      INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_at)
      VALUES ${values.join(",")}
      ON CONFLICT(reference_type,reference_id)
        WHERE reference_type IN ('legacy_sheet','migration_balance') AND reference_id IS NOT NULL
      DO UPDATE SET
        captain_id=EXCLUDED.captain_id,amount=EXCLUDED.amount,entry_type=EXCLUDED.entry_type,
        direction=EXCLUDED.direction,description=EXCLUDED.description,metadata=EXCLUDED.metadata,
        created_at=EXCLUDED.created_at
    `,params);
  }
  await migrationSetProgress(run.id,"movements",run.apply_offset+rows.length,rows.length);
  return {phase:"movements",processed:rows.length};
}

async function applyBalanceAdditionsBatch(run,userId){
  const rows=await migrationRows(run.id,"إضافات الرصيد",run.apply_offset,250);
  if(!rows.length){await migrationAdvance(run.id,"codes");return {advanced:true,phase:"codes"}}
  const caps=await db.query(`SELECT id,legacy_id FROM captains WHERE legacy_id IS NOT NULL`);
  const capMap=new Map(caps.rows.map(x=>[x.legacy_id,x.id]));
  for(const {row_data:r} of rows){
    const legacyId=migText(r["المعرّف"]),captainId=capMap.get(migText(r["معرّف الكابتن"]));
    if(!legacyId||!captainId)continue;
    const amount=Math.abs(migNum(r["الرصيد المضاف"]));
    if(amount<=0)continue;
    const meta={
      migration:true,legacyBalanceAddition:true,legacyId,
      balanceBefore:migNum(r["الرصيد قبل"]),balanceAfter:migNum(r["الرصيد بعد"]),
      recordedBy:migText(r["أضافه"])
    };
    await db.query(`
      INSERT INTO ledger_entries(
        captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_at,created_by_user_id
      ) VALUES($1,$2,'MANUAL_CREDIT','credit','legacy_balance_addition',$3,$4,$5::jsonb,$6,$7)
      ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL
      DO UPDATE SET amount=EXCLUDED.amount,direction='credit',description=EXCLUDED.description,
        metadata=EXCLUDED.metadata,created_at=EXCLUDED.created_at,created_by_user_id=EXCLUDED.created_by_user_id
    `,[captainId,amount,legacyId,`إضافة رصيد قديمة من Google — ${migText(r["أضافه"])||'النظام القديم'}`,JSON.stringify(meta),migTs(r["التاريخ"])||new Date(),userId||null]);
  }
  await migrationSetProgress(run.id,"balance_additions",run.apply_offset+rows.length,rows.length);
  return {phase:"balance_additions",processed:rows.length};
}

async function applyCodesBatch(run,userId){
  const rows=await migrationRows(run.id,"أكواد الشحن",run.apply_offset,200);
  if(!rows.length){await migrationAdvance(run.id,"transfers");return {advanced:true,phase:"transfers"}}
  const caps=await db.query(`SELECT id,legacy_id FROM captains WHERE legacy_id IS NOT NULL`);
  const capMap=new Map(caps.rows.map(x=>[x.legacy_id,x.id]));
  const staff=await db.query(`SELECT id,username FROM users WHERE role IN ('admin','accountant')`);
  const staffMap=new Map(staff.rows.map(x=>[String(x.username).toLowerCase(),x.id]));
  for(const {row_data:r} of rows){
    const legacyId=migText(r["المعرّف"]),code=migText(r["الكود"]);
    if(!legacyId||!code)continue;
    const s=migText(r["الحالة"]);
    const status=s.includes("غير مستخدم")?"active":s.includes("مستخدم")?"used":"cancelled";
    const usedCaptain=status==="used"?capMap.get(migText(r["معرّف الكابتن"]))||null:null;
    const createdBy=staffMap.get(migText(r["أصدره"]).toLowerCase())||null;
    await db.query(`
      INSERT INTO recharge_codes(legacy_id,code,amount,status,created_by_user_id,used_by_captain_id,created_at,used_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(code) DO UPDATE SET
        legacy_id=EXCLUDED.legacy_id,amount=EXCLUDED.amount,status=EXCLUDED.status,
        created_by_user_id=EXCLUDED.created_by_user_id,used_by_captain_id=EXCLUDED.used_by_captain_id,
        created_at=EXCLUDED.created_at,used_at=EXCLUDED.used_at
    `,[legacyId,code,Math.max(.001,migNum(r["قيمة الرصيد"])),status,createdBy,usedCaptain,
       migTs(r["تاريخ الإصدار"])||new Date(),migTs(r["تاريخ الاستخدام"])]);
  }
  await migrationSetProgress(run.id,"codes",run.apply_offset+rows.length,rows.length);
  return {phase:"codes",processed:rows.length};
}

async function applyTransfersBatch(run,userId){
  const rows=await migrationRows(run.id,"الحوالات",run.apply_offset,150);
  if(!rows.length){await migrationAdvance(run.id,"weekly");return {advanced:true,phase:"weekly"}}
  const caps=await db.query(`SELECT id,legacy_id FROM captains WHERE legacy_id IS NOT NULL`);
  const capMap=new Map(caps.rows.map(x=>[x.legacy_id,x.id]));
  const staff=await db.query(`SELECT id,username FROM users WHERE role IN ('admin','accountant')`);
  const staffMap=new Map(staff.rows.map(x=>[String(x.username).toLowerCase(),x.id]));
  for(const {row_data:r} of rows){
    const legacyId=migText(r["المعرّف"]),captainId=capMap.get(migText(r["معرّف الكابتن"]));
    if(!legacyId||!captainId)continue;
    const s=migText(r["الحالة"]);
    let status="pending";
    if(s.includes("مرفوض"))status="rejected";
    else if(s.includes("معتمد")||s.includes("مقبول")||s.includes("تم"))status="approved";
    else if(s.includes("ملغ"))status="cancelled";
    const reviewedBy=staffMap.get(migText(r["راجعها"]).toLowerCase())||null;
    const ref=migText(r["رابط الصورة"])||migText(r["معرّف صورة الحوالة"])||null;
    await db.query(`
      INSERT INTO recharge_requests(
        legacy_id,captain_id,amount,method,reference_text,note,status,created_at,
        reviewed_at,reviewed_by_user_id,legacy_image_url,legacy_code
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
        captain_id=EXCLUDED.captain_id,amount=EXCLUDED.amount,method=EXCLUDED.method,
        reference_text=EXCLUDED.reference_text,note=EXCLUDED.note,status=EXCLUDED.status,
        reviewed_at=EXCLUDED.reviewed_at,reviewed_by_user_id=EXCLUDED.reviewed_by_user_id,
        legacy_image_url=EXCLUDED.legacy_image_url,legacy_code=EXCLUDED.legacy_code
    `,[legacyId,captainId,Math.max(.001,migNum(r["قيمة الرصيد"])),migText(r["طريقة التحويل"])||null,
       ref,migText(r["ملاحظة المحاسب"])||null,status,migTs(r["تاريخ الإرسال"])||new Date(),
       migTs(r["تاريخ المراجعة"]),reviewedBy,migText(r["رابط الصورة"])||null,migText(r["كود الشحن"])||null]);
  }
  await migrationSetProgress(run.id,"transfers",run.apply_offset+rows.length,rows.length);
  return {phase:"transfers",processed:rows.length};
}

async function applyWeeklyBatch(run,userId){
  const rows=await migrationRows(run.id,"تحويلات الجمعة",run.apply_offset,150);
  if(!rows.length){await migrationAdvance(run.id,"settings");return {advanced:true,phase:"settings"}}
  const caps=await db.query(`SELECT id,legacy_id FROM captains WHERE legacy_id IS NOT NULL`);
  const capMap=new Map(caps.rows.map(x=>[x.legacy_id,x.id]));
  const staff=await db.query(`SELECT id,username FROM users WHERE role IN ('admin','accountant')`);
  const staffMap=new Map(staff.rows.map(x=>[String(x.username).toLowerCase(),x.id]));
  for(const {row_data:r} of rows){
    const legacyId=migText(r["المعرّف"]),captainId=capMap.get(migText(r["معرّف الكابتن"]));
    const ws=migText(r["بداية الأسبوع"]),we=migText(r["نهاية الأسبوع"]);
    if(!legacyId||!captainId||!ws||!we)continue;
    const st=await db.query(`
      INSERT INTO weekly_settlements(week_start,week_end,status,created_at,closed_at)
      VALUES($1::date,$2::date,'closed',$3,$4)
      ON CONFLICT(week_start,week_end) DO UPDATE SET status='closed'
      RETURNING id
    `,[ws,we,migTs(r["تاريخ تجهيز التسوية"])||new Date(),migTs(r["تاريخ التحويل"])||migTs(r["تاريخ تجهيز التسوية"])||new Date()]);
    const s=migText(r["الحالة"]);
    const itemStatus=s.includes("تم التحويل")?"transferred":s.includes("أعيد")||s.includes("اعيد")?"archived":"due";
    const transferredBy=staffMap.get(migText(r["حوّله"]).toLowerCase())||null;
    // Google may contain more than one Friday-transfer row for the same captain/week.
    // PostgreSQL intentionally keeps one settlement item per (settlement_id,captain_id),
    // so merge duplicate legacy rows instead of failing the whole migration.
    const settlementId=st.rows[0].id;
    const pairExisting=await db.query(`
      SELECT id,legacy_id FROM weekly_settlement_items
      WHERE settlement_id=$1 AND captain_id=$2
      LIMIT 1
    `,[settlementId,captainId]);
    if(pairExisting.rowCount){
      await db.query(`
        UPDATE weekly_settlement_items SET
          production=$2,consumption=$3,net=$4,status=$5,
          transferred_at=$6,transferred_by_user_id=$7,
          created_at=LEAST(created_at,$8),
          legacy_id=COALESCE(legacy_id,$9)
        WHERE id=$1
      `,[pairExisting.rows[0].id,migNum(r["إجمالي الإنتاج"]),migNum(r["إجمالي الاستهلاك"]),
         migNum(r["صافي الأسبوع"]),itemStatus,migTs(r["تاريخ التحويل"]),transferredBy,
         migTs(r["تاريخ تجهيز التسوية"])||new Date(),legacyId]);
      continue;
    }

    const legacyExisting=await db.query(`
      SELECT id FROM weekly_settlement_items WHERE legacy_id=$1 LIMIT 1
    `,[legacyId]);
    if(legacyExisting.rowCount){
      await db.query(`
        UPDATE weekly_settlement_items SET
          settlement_id=$2,captain_id=$3,production=$4,consumption=$5,net=$6,status=$7,
          transferred_at=$8,transferred_by_user_id=$9,created_at=LEAST(created_at,$10)
        WHERE id=$1
      `,[legacyExisting.rows[0].id,settlementId,captainId,migNum(r["إجمالي الإنتاج"]),
         migNum(r["إجمالي الاستهلاك"]),migNum(r["صافي الأسبوع"]),itemStatus,
         migTs(r["تاريخ التحويل"]),transferredBy,migTs(r["تاريخ تجهيز التسوية"])||new Date()]);
      continue;
    }

    await db.query(`
      INSERT INTO weekly_settlement_items(
        legacy_id,settlement_id,captain_id,production,consumption,net,status,
        transferred_at,transferred_by_user_id,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,[legacyId,settlementId,captainId,migNum(r["إجمالي الإنتاج"]),migNum(r["إجمالي الاستهلاك"]),
       migNum(r["صافي الأسبوع"]),itemStatus,migTs(r["تاريخ التحويل"]),transferredBy,
       migTs(r["تاريخ تجهيز التسوية"])||new Date()]);
  }
  await migrationSetProgress(run.id,"weekly",run.apply_offset+rows.length,rows.length);
  return {phase:"weekly",processed:rows.length};
}

async function applySettingsBatch(run,userId){
  const rows=await migrationRows(run.id,"الإعدادات",run.apply_offset,200);
  if(!rows.length){await migrationAdvance(run.id,"whatsapp");return {advanced:true,phase:"whatsapp"}}
  const all={};
  for(const {row_data:r} of rows){
    const key=migText(r["الإعداد"]),value=migText(r["القيمة"]);
    if(!key)continue;all[key]=value;
  }
  await setSystemSetting("legacy_apps_script_settings",all,userId);
  const known={
    "اسم العلامة":"brandName","عمولة الراكب":"passengerCommission","عمولة الأوردر":"orderCommission",
    "الحد الأدنى للرصيد":"minActiveBalance","قيمة الأرضية الأسبوعية":"weeklyFloorCharge",
    "عدد الأوردرات لكل اقتطاع":"weeklyOrderBatchSize","قيمة اقتطاع كل فئة أوردرات":"weeklyOrderBatchDeduction",
    "رصيد الاحتياط بعد ترحيل الجمعة":"fridayReserveBalance",
    "عدد حركات الركاب والأوردرات لكل اقتطاع":"movementBatchSize","قيمة اقتطاع كل 30 حركة":"movementBatchDeduction"
  };
  for(const [arabic,key] of Object.entries(known)){
    if(all[arabic]!==undefined){
      const value=arabic==="اسم العلامة"?all[arabic]:migNum(all[arabic]);
      await setSystemSetting(key,value,userId);
    }
  }
  await migrationSetProgress(run.id,"settings",run.apply_offset+rows.length,rows.length);
  return {phase:"settings",processed:rows.length};
}

async function applyWhatsappBatch(run,userId){
  const rows=await migrationRows(run.id,"رسائل واتساب",run.apply_offset,300);
  if(!rows.length){await migrationAdvance(run.id,"webhook_queue");return {advanced:true,phase:"webhook_queue"}}
  for(const {row_data:r} of rows){
    const id=migText(r["معرّف الرسالة"]);if(!id)continue;
    const raw=migJson(r["البيانات الخام"],{});
    const s=migText(r["حالة المعالجة"]);
    const pending=s.includes("بانتظار")||s.includes("مستلمة");
    const received=migTs(r["وقت وصولها لأبشر"])||migTs(r["تاريخ الاستلام"])||new Date();
    await db.query(`
      INSERT INTO whatsapp_events(
        id_message,webhook_type,chat_id,sender_id,sender_name,message_type,message_text,
        event_timestamp,webhook_received_at,processing_started_at,processed_at,status,raw_payload
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT(id_message) DO NOTHING
    `,[id,raw?.typeWebhook||"legacy_import",migText(r["معرّف القروب"])||raw?.senderData?.chatId||null,
       migText(r["رقم المرسل"])||raw?.senderData?.sender||null,migText(r["اسم المرسل"])||raw?.senderData?.senderName||null,
       migText(r["نوع المصدر"])||raw?.messageData?.typeMessage||null,migText(r["نص الرسالة"])||null,
       normalizeWhatsappEventTimestamp(raw?.timestamp),received,migTs(r["وقت بدء المعالجة"]),migTs(r["وقت انتهاء المعالجة"]),
       pending?"legacy_pending":"legacy_processed",JSON.stringify(raw||{})]);
  }
  await migrationSetProgress(run.id,"whatsapp",run.apply_offset+rows.length,rows.length);
  return {phase:"whatsapp",processed:rows.length};
}

async function applyWebhookQueueBatch(run,userId){
  const rows=await migrationRows(run.id,"طابور Webhook",run.apply_offset,300);
  if(!rows.length){await migrationAdvance(run.id,"balance_adjustment");return {advanced:true,phase:"balance_adjustment"}}
  for(const {row_data:r} of rows){
    const raw=migJson(r["البيانات الخام"]??r["payload"]??Object.values(r)[2],{});
    const id=migText(raw?.idMessage);if(!id)continue;
    const receivedAt=migTs(r["ReceivedAt"]??r["تاريخ الاستلام"]??r["وقت الوصول"])||new Date();
    await db.query(`
      INSERT INTO whatsapp_events(
        id_message,webhook_type,chat_id,sender_id,sender_name,message_type,message_text,
        event_timestamp,webhook_received_at,status,raw_payload
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'legacy_pending',$10::jsonb)
      ON CONFLICT(id_message) DO UPDATE SET
        raw_payload=CASE WHEN whatsapp_events.raw_payload='{}'::jsonb THEN EXCLUDED.raw_payload ELSE whatsapp_events.raw_payload END,
        webhook_received_at=LEAST(whatsapp_events.webhook_received_at,EXCLUDED.webhook_received_at)
    `,[id,raw?.typeWebhook||"legacy_queue",raw?.senderData?.chatId||null,raw?.senderData?.sender||null,
       raw?.senderData?.senderName||null,raw?.messageData?.typeMessage||null,
       raw?.messageData?.textMessageData?.textMessage||raw?.messageData?.extendedTextMessageData?.text||null,
       normalizeWhatsappEventTimestamp(raw?.timestamp),receivedAt,JSON.stringify(raw||{})]);
  }
  await migrationSetProgress(run.id,"webhook_queue",run.apply_offset+rows.length,rows.length);
  return {phase:"webhook_queue",processed:rows.length};
}

async function applyBalanceAdjustments(run,userId){
  const finalMode=String(run.run_mode||'').toLowerCase()==='final_week_cutover' && run.cutover_at;
  if(finalMode){
    // Final takeover rule:
    // Google balance is the frozen OLD-system balance. Preserve anything created natively on
    // Railway at/after the GREEN switch by keeping it OUT of the baseline adjustment.
    // Legacy-sheet rows are always part of the Google baseline even if an invalid legacy
    // timestamp forced their PostgreSQL created_at to NOW().
    await db.query(`
      WITH targets AS (
        SELECT
          c.id AS captain_id,
          c.legacy_id,
          COALESCE(NULLIF(regexp_replace(replace(sr.row_data->>'الرصيد','٫','.'),'[^0-9.-]','','g'),'')::numeric,0) AS target_balance
        FROM full_migration_stage_rows sr
        JOIN captains c ON c.legacy_id=sr.row_data->>'المعرّف'
        WHERE sr.run_id=$1 AND sr.sheet_name='الكباتن'
      ),
      current_without_adjustment AS (
        SELECT t.captain_id,t.legacy_id,t.target_balance,
          COALESCE(SUM(le.amount) FILTER(
            WHERE le.reference_type IS DISTINCT FROM 'migration_balance'
              AND (le.reference_type IN ('legacy_sheet','legacy_balance_addition') OR le.created_at < $3)
          ),0) AS base_balance
        FROM targets t
        LEFT JOIN ledger_entries le ON le.captain_id=t.captain_id AND le.reversed_at IS NULL
        GROUP BY t.captain_id,t.legacy_id,t.target_balance
      )
      INSERT INTO ledger_entries(
        captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id
      )
      SELECT
        captain_id,
        target_balance-base_balance,
        'MIGRATION_BALANCE_ADJUSTMENT',
        CASE WHEN target_balance-base_balance>=0 THEN 'credit' ELSE 'debit' END,
        'migration_balance',
        legacy_id,
        'رصيد الاستلام النهائي من Google عند التحويل إلى Railway',
        jsonb_build_object('migration',true,'finalCutover',true,'cutoverAt',$3::timestamptz,'targetBalance',target_balance,'baseBalance',base_balance),
        $2
      FROM current_without_adjustment
      ON CONFLICT(reference_type,reference_id)
        WHERE reference_type IN ('legacy_sheet','migration_balance') AND reference_id IS NOT NULL
      DO UPDATE SET
        captain_id=EXCLUDED.captain_id,amount=EXCLUDED.amount,direction=EXCLUDED.direction,
        description=EXCLUDED.description,metadata=EXCLUDED.metadata,created_by_user_id=EXCLUDED.created_by_user_id
    `,[run.id,userId||null,run.cutover_at]);
  }else{
    await db.query(`
      WITH targets AS (
        SELECT
          c.id AS captain_id,
          c.legacy_id,
          COALESCE(NULLIF(regexp_replace(replace(sr.row_data->>'الرصيد','٫','.'),'[^0-9.-]','','g'),'')::numeric,0) AS target_balance
        FROM full_migration_stage_rows sr
        JOIN captains c ON c.legacy_id=sr.row_data->>'المعرّف'
        WHERE sr.run_id=$1 AND sr.sheet_name='الكباتن'
      ),
      current_without_adjustment AS (
        SELECT t.captain_id,t.legacy_id,t.target_balance,
          COALESCE(SUM(le.amount) FILTER(WHERE le.reference_type IS DISTINCT FROM 'migration_balance'),0) AS base_balance
        FROM targets t
        LEFT JOIN ledger_entries le ON le.captain_id=t.captain_id AND le.reversed_at IS NULL
        GROUP BY t.captain_id,t.legacy_id,t.target_balance
      )
      INSERT INTO ledger_entries(
        captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id
      )
      SELECT
        captain_id,
        target_balance-base_balance,
        'MIGRATION_BALANCE_ADJUSTMENT',
        CASE WHEN target_balance-base_balance>=0 THEN 'credit' ELSE 'debit' END,
        'migration_balance',
        legacy_id,
        'رصيد افتتاحي/تسوية نهائية من Google Apps Script',
        jsonb_build_object('migration',true,'targetBalance',target_balance,'baseBalance',base_balance),
        $2
      FROM current_without_adjustment
      ON CONFLICT(reference_type,reference_id)
        WHERE reference_type IN ('legacy_sheet','migration_balance') AND reference_id IS NOT NULL
      DO UPDATE SET
        captain_id=EXCLUDED.captain_id,amount=EXCLUDED.amount,direction=EXCLUDED.direction,
        description=EXCLUDED.description,metadata=EXCLUDED.metadata,created_by_user_id=EXCLUDED.created_by_user_id
    `,[run.id,userId||null]);
  }
  await migrationSetProgress(run.id,"balance_adjustment",1,1);
  await migrationAdvance(run.id,"done");
  return {phase:"balance_adjustment",processed:1,finalCutover:Boolean(finalMode)};
}

export async function applyFullMigrationStep(runId,userId=null){
  const r=await db.query(`SELECT * FROM full_migration_runs WHERE id=$1 FOR UPDATE`,[runId]);
  if(!r.rowCount)throw Object.assign(new Error("migration_run_not_found"),{statusCode:404});
  const run=r.rows[0];
  if(!["uploaded","applying"].includes(run.status))throw Object.assign(new Error("migration_not_ready"),{statusCode:409});
  try{
    switch(run.apply_phase){
      case "captains":return await applyCaptainsBatch(run,userId);
      case "staff":return await applyStaffBatch(run,userId);
      case "movements":return await applyMovementBatch(run,userId);
      case "balance_additions":return await applyBalanceAdditionsBatch(run,userId);
      case "codes":return await applyCodesBatch(run,userId);
      case "transfers":return await applyTransfersBatch(run,userId);
      case "weekly":return await applyWeeklyBatch(run,userId);
      case "settings":return await applySettingsBatch(run,userId);
      case "whatsapp":return await applyWhatsappBatch(run,userId);
      case "webhook_queue":return await applyWebhookQueueBatch(run,userId);
      case "balance_adjustment":return await applyBalanceAdjustments(run,userId);
      case "done":
        await db.query(`UPDATE full_migration_runs SET status='completed',completed_at=NOW(),updated_at=NOW() WHERE id=$1`,[run.id]);
        await audit(userId,"migration.full.completed","migration_run",run.id,{runKey:run.run_key});
        return {done:true,phase:"done"};
      default:throw new Error("unknown_migration_phase");
    }
  }catch(e){
    await db.query(`UPDATE full_migration_runs SET status='failed',error_text=$2,updated_at=NOW() WHERE id=$1`,[run.id,String(e?.stack||e?.message||e).slice(0,12000)]);
    throw e;
  }
}

export async function resetFullMigrationApply(runId,userId=null){
  // If a run failed mid-apply, keep its phase/offset and resume exactly there.
  // For non-failed runs, preserve the previous full-reset behavior.
  const current=await db.query(`SELECT status,apply_phase,apply_offset FROM full_migration_runs WHERE id=$1`,[runId]);
  if(!current.rowCount)throw Object.assign(new Error("migration_run_not_found"),{statusCode:404});
  const failed=current.rows[0].status==="failed";
  const r=await db.query(`
    UPDATE full_migration_runs SET
      status='uploaded',
      apply_phase=CASE WHEN $2::boolean THEN apply_phase ELSE 'captains' END,
      apply_offset=CASE WHEN $2::boolean THEN apply_offset ELSE 0 END,
      apply_counts=CASE WHEN $2::boolean THEN apply_counts ELSE '{}'::jsonb END,
      error_text=NULL,
      apply_started_at=CASE WHEN $2::boolean THEN apply_started_at ELSE NULL END,
      completed_at=NULL,updated_at=NOW()
    WHERE id=$1 RETURNING *
  `,[runId,failed]);
  await audit(userId,failed?"migration.full.resume_failed":"migration.full.reset_apply","migration_run",runId,{
    resumedPhase:failed?current.rows[0].apply_phase:null,
    resumedOffset:failed?current.rows[0].apply_offset:null
  });
  return r.rows[0];
}


// Final PostgreSQL audit before switching GREEN to Railway LIVE --------------------
export async function getFinalCutoverAudit() {
  const runQ=await db.query(`SELECT * FROM full_migration_runs ORDER BY id DESC LIMIT 1`);
  if(!runQ.rowCount){
    return {ready:false,blocking:["لا يوجد Full Migration"],warnings:[],migration:null};
  }
  const run=runQ.rows[0];
  const runId=run.id;

  if(String(run.run_mode||'').toLowerCase()==='final_week_cutover' && run.status==='completed'){
    const a=await getFinalWeekMigrationAudit(run.run_key);
    const pgSummary=await db.query(`
      SELECT
        (SELECT COUNT(*) FROM captains)::int AS captains,
        (SELECT COUNT(*) FROM users WHERE role='captain')::int AS captain_users,
        (SELECT COUNT(*) FROM ledger_entries WHERE reversed_at IS NULL)::int AS ledger_total,
        (SELECT COUNT(*) FROM ledger_entries WHERE reversed_at IS NULL AND reference_type='legacy_sheet')::int AS legacy_movements,
        (SELECT COUNT(*) FROM whatsapp_events)::int AS whatsapp_events
    `).then(r=>r.rows[0]);
    const activeRepairQ=await db.query(`SELECT id,status,total_events,processed_events,failed_events FROM whatsapp_repair_runs WHERE status IN ('QUEUING','RUNNING') ORDER BY id DESC LIMIT 1`).then(r=>r.rows[0]||null);
    const warnings=[];
    if(Number(a.balances?.post_cutover_total||0)!==0)warnings.push(`حركات Railway بعد لحظة التحويل محفوظة فوق رصيد Google: ${Number(a.balances.post_cutover_total||0).toFixed(3)} د.أ`);
    return {
      ready:a.ready,checkedAt:a.checkedAt,
      migration:{id:run.id,status:run.status,completedAt:run.completed_at,applyCounts:run.apply_counts,runMode:run.run_mode,cutoverAt:run.cutover_at},
      stage:a.stage,postgres:pgSummary,captains:a.captains,captainUsers:a.users,balances:a.balances,
      movements:a.movements,whatsapp:a.whatsapp,activeRepair:activeRepairQ,blocking:a.blocking||[],warnings
    };
  }

  const [stage,pgSummary,captainMatch,userMatch,balanceCheck,movementCheck,waCheck,activeRepairQ]=await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER(WHERE sheet_name='الكباتن')::int AS captain_rows,
        COUNT(*) FILTER(WHERE sheet_name='الحركات')::int AS movement_rows,
        COUNT(*) FILTER(WHERE sheet_name='رسائل واتساب')::int AS whatsapp_rows,
        COUNT(*) FILTER(WHERE sheet_name='طابور Webhook')::int AS webhook_rows
      FROM full_migration_stage_rows WHERE run_id=$1
    `,[runId]).then(r=>r.rows[0]),
    db.query(`
      SELECT
        (SELECT COUNT(*) FROM captains)::int AS captains,
        (SELECT COUNT(*) FROM users WHERE role='captain')::int AS captain_users,
        (SELECT COUNT(*) FROM ledger_entries WHERE reversed_at IS NULL)::int AS ledger_total,
        (SELECT COUNT(*) FROM ledger_entries WHERE reversed_at IS NULL AND reference_type='legacy_sheet')::int AS legacy_movements,
        (SELECT COUNT(*) FROM whatsapp_events)::int AS whatsapp_events
    `).then(r=>r.rows[0]),
    db.query(`
      WITH src AS (
        SELECT DISTINCT ON (trim(row_data->>'رقم الهاتف'))
          trim(row_data->>'رقم الهاتف') AS phone,
          trim(row_data->>'المعرّف') AS legacy_id
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='الكباتن'
          AND trim(COALESCE(row_data->>'المعرّف',''))<>''
          AND trim(COALESCE(row_data->>'الاسم الكامل',''))<>''
          AND trim(COALESCE(row_data->>'رقم الهاتف',''))<>''
        ORDER BY trim(row_data->>'رقم الهاتف'),row_number DESC
      )
      SELECT
        COUNT(*)::int AS expected,
        COUNT(c.id)::int AS matched,
        COUNT(*) FILTER(WHERE c.id IS NULL)::int AS missing
      FROM src LEFT JOIN captains c ON c.phone=src.phone OR c.legacy_id=src.legacy_id
    `,[runId]).then(r=>r.rows[0]),
    db.query(`
      WITH src AS (
        SELECT DISTINCT ON (trim(row_data->>'رقم الهاتف'))
          trim(row_data->>'رقم الهاتف') AS phone
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='الكباتن'
          AND trim(COALESCE(row_data->>'رقم الهاتف',''))<>''
          AND trim(COALESCE(row_data->>'كلمة المرور',''))<>''
        ORDER BY trim(row_data->>'رقم الهاتف'),row_number DESC
      )
      SELECT COUNT(*)::int AS expected,
        COUNT(u.id)::int AS matched,
        COUNT(*) FILTER(WHERE u.id IS NULL)::int AS missing
      FROM src LEFT JOIN users u ON u.username=src.phone AND u.role='captain'
    `,[runId]).then(r=>r.rows[0]),
    db.query(`
      WITH src AS (
        SELECT DISTINCT ON (trim(row_data->>'المعرّف'))
          trim(row_data->>'المعرّف') AS legacy_id,
          COALESCE(NULLIF(regexp_replace(replace(COALESCE(row_data->>'الرصيد',''),'٫','.'),'[^0-9.-]','','g'),'')::numeric,0) AS target_balance
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='الكباتن'
          AND trim(COALESCE(row_data->>'المعرّف',''))<>''
          AND trim(COALESCE(row_data->>'الاسم الكامل',''))<>''
          AND trim(COALESCE(row_data->>'رقم الهاتف',''))<>''
        ORDER BY trim(row_data->>'المعرّف'),row_number DESC
      ), balances AS (
        SELECT c.legacy_id,COALESCE(SUM(le.amount) FILTER(WHERE le.reversed_at IS NULL),0) AS pg_balance
        FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id
        WHERE c.legacy_id IS NOT NULL
        GROUP BY c.id,c.legacy_id
      )
      SELECT COUNT(*)::int AS compared,
        COUNT(*) FILTER(WHERE b.legacy_id IS NULL)::int AS missing,
        COUNT(*) FILTER(WHERE b.legacy_id IS NOT NULL AND ABS(b.pg_balance-src.target_balance)>.0005)::int AS mismatches,
        COALESCE(MAX(ABS(COALESCE(b.pg_balance,0)-src.target_balance)),0)::numeric(16,3) AS max_diff
      FROM src LEFT JOIN balances b ON b.legacy_id=src.legacy_id
    `,[runId]).then(r=>r.rows[0]),
    db.query(`
      WITH valid AS (
        SELECT DISTINCT trim(m.row_data->>'المعرّف') AS movement_id
        FROM full_migration_stage_rows m
        JOIN full_migration_stage_rows c
          ON c.run_id=m.run_id AND c.sheet_name='الكباتن'
         AND trim(c.row_data->>'المعرّف')=trim(m.row_data->>'معرّف الكابتن')
        WHERE m.run_id=$1 AND m.sheet_name='الحركات'
          AND trim(COALESCE(m.row_data->>'المعرّف',''))<>''
      )
      SELECT COUNT(*)::int AS expected,
        COUNT(le.id)::int AS matched,
        COUNT(*) FILTER(WHERE le.id IS NULL)::int AS missing
      FROM valid v LEFT JOIN ledger_entries le
        ON le.reference_type='legacy_sheet' AND le.reference_id=v.movement_id AND le.reversed_at IS NULL
    `,[runId]).then(r=>r.rows[0]),
    db.query(`
      WITH valid AS (
        SELECT DISTINCT trim(row_data->>'معرّف الرسالة') AS id_message
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='رسائل واتساب'
          AND trim(COALESCE(row_data->>'معرّف الرسالة',''))<>''
      )
      SELECT COUNT(*)::int AS expected,
        COUNT(w.id)::int AS matched,
        COUNT(*) FILTER(WHERE w.id IS NULL)::int AS missing
      FROM valid v LEFT JOIN whatsapp_events w ON w.id_message=v.id_message
    `,[runId]).then(r=>r.rows[0]),
    db.query(`SELECT id,status,total_events,processed_events,failed_events FROM whatsapp_repair_runs WHERE status IN ('QUEUING','RUNNING') ORDER BY id DESC LIMIT 1`).then(r=>r.rows[0]||null)
  ]);

  const blocking=[];
  const warnings=[];
  if(run.status!=="completed")blocking.push(`النقل غير مكتمل (${run.status})`);
  if(Number(captainMatch.missing||0)>0)blocking.push(`${captainMatch.missing} كابتن لم ينتقل`);
  if(Number(userMatch.missing||0)>0)blocking.push(`${userMatch.missing} حساب كابتن بكلمة مرور لم ينتقل`);
  if(Number(balanceCheck.missing||0)>0)blocking.push(`${balanceCheck.missing} كابتن بدون رصيد قابل للمطابقة`);
  // V3.7.3: اختلاف الرصيد عن الـFull Migration القديم متوقع لأن Apps Script ظل يعمل
  // بعد النسخة الأساسية. الاستلام النهائي نفسه يرفع شيت الكباتن من جديد ويثبت آخر
  // رصيد Google عند لحظة التحويل، لذلك لا نمنع PREPARE بسبب balance drift فقط.
  if(Number(balanceCheck.mismatches||0)>0){
    warnings.push(`${balanceCheck.mismatches} رصيد تغيّر منذ النسخة الأساسية؛ سيتم تثبيت آخر رصيد من Google أثناء الاستلام النهائي (أكبر فرق ${Number(balanceCheck.max_diff||0).toFixed(3)} د.أ)`);
  }
  if(Number(movementCheck.missing||0)>0)blocking.push(`${movementCheck.missing} حركة Google غير موجودة في Ledger`);
  if(Number(waCheck.missing||0)>0)blocking.push(`${waCheck.missing} رسالة واتساب تاريخية غير موجودة`);
  if(activeRepairQ)blocking.push(`يوجد Repair فعّال رقم ${activeRepairQ.id}`);
  if(Number(pgSummary.captains||0)>Number(captainMatch.expected||0))warnings.push(`${Number(pgSummary.captains)-Number(captainMatch.expected||0)} كابتن إضافي في PostgreSQL خارج نسخة Google`);
  const extraLedger=Math.max(0,Number(pgSummary.ledger_total||0)-Number(pgSummary.legacy_movements||0));
  if(extraLedger>0)warnings.push(`${extraLedger} حركة Ledger إضافية طبيعية (شحن/تسويات/حركات جديدة) ولا تعتبر فرق نقل`);

  return {
    ready:blocking.length===0,
    checkedAt:new Date().toISOString(),
    migration:{id:run.id,status:run.status,completedAt:run.completed_at,applyCounts:run.apply_counts},
    stage,
    postgres:pgSummary,
    captains:captainMatch,
    captainUsers:userMatch,
    balances:{...balanceCheck,max_diff:Number(balanceCheck.max_diff||0)},
    movements:movementCheck,
    whatsapp:waCheck,
    activeRepair:activeRepairQ,
    blocking,warnings
  };
}


// Final takeover orchestration -----------------------------------------------------
const FINAL_TAKEOVER_SETTING = "final_takeover_state";

export async function getFinalTakeoverState() {
  return await getSystemSetting(FINAL_TAKEOVER_SETTING,null);
}

export async function saveFinalTakeoverState(patch={},userId=null) {
  const prev=(await getFinalTakeoverState())||{};
  const next={...prev,...patch,updatedAt:new Date().toISOString()};
  await setSystemSetting(FINAL_TAKEOVER_SETTING,next,userId);
  return next;
}

export async function clearFinalTakeoverState(userId=null) {
  const next={status:'IDLE',clearedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await setSystemSetting(FINAL_TAKEOVER_SETTING,next,userId);
  return next;
}

export async function getFinalWeekMigrationAudit(runKey) {
  const runQ=await db.query(`SELECT * FROM full_migration_runs WHERE run_key=$1`,[migText(runKey)]);
  if(!runQ.rowCount)return {ready:false,blocking:['final_run_not_found'],run:null};
  const run=runQ.rows[0];
  const runId=run.id;
  const finalMode=String(run.run_mode||'').toLowerCase()==='final_week_cutover';
  const [captains,users,balances,movements,whatsapp,stage]=await Promise.all([
    db.query(`
      WITH src AS (
        SELECT DISTINCT ON (trim(row_data->>'رقم الهاتف'))
          trim(row_data->>'رقم الهاتف') AS phone,
          trim(row_data->>'المعرّف') AS legacy_id
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='الكباتن'
          AND trim(COALESCE(row_data->>'المعرّف',''))<>''
          AND trim(COALESCE(row_data->>'الاسم الكامل',''))<>''
          AND trim(COALESCE(row_data->>'رقم الهاتف',''))<>''
        ORDER BY trim(row_data->>'رقم الهاتف'),row_number DESC
      )
      SELECT COUNT(*)::int expected,COUNT(c.id)::int matched,
        COUNT(*) FILTER(WHERE c.id IS NULL)::int missing
      FROM src LEFT JOIN captains c ON c.phone=src.phone OR c.legacy_id=src.legacy_id
    `,[runId]).then(r=>r.rows[0]),
    db.query(`
      WITH src AS (
        SELECT DISTINCT ON (trim(row_data->>'رقم الهاتف')) trim(row_data->>'رقم الهاتف') AS phone
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='الكباتن'
          AND trim(COALESCE(row_data->>'رقم الهاتف',''))<>''
          AND trim(COALESCE(row_data->>'كلمة المرور',''))<>''
        ORDER BY trim(row_data->>'رقم الهاتف'),row_number DESC
      )
      SELECT COUNT(*)::int expected,COUNT(u.id)::int matched,
        COUNT(*) FILTER(WHERE u.id IS NULL)::int missing
      FROM src LEFT JOIN users u ON u.username=src.phone AND u.role='captain'
    `,[runId]).then(r=>r.rows[0]),
    db.query(`
      WITH src AS (
        SELECT DISTINCT ON (trim(row_data->>'المعرّف'))
          trim(row_data->>'المعرّف') AS legacy_id,
          COALESCE(NULLIF(regexp_replace(replace(COALESCE(row_data->>'الرصيد',''),'٫','.'),'[^0-9.-]','','g'),'')::numeric,0) AS target_balance
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='الكباتن'
          AND trim(COALESCE(row_data->>'المعرّف',''))<>''
        ORDER BY trim(row_data->>'المعرّف'),row_number DESC
      ), b AS (
        SELECT c.legacy_id,
          COALESCE(SUM(le.amount) FILTER(
            WHERE le.reversed_at IS NULL AND (
              le.reference_type='migration_balance' OR
              le.reference_type IN ('legacy_sheet','legacy_balance_addition') OR
              $2::timestamptz IS NULL OR le.created_at < $2::timestamptz
            )
          ),0) AS frozen_baseline,
          COALESCE(SUM(le.amount) FILTER(
            WHERE le.reversed_at IS NULL
              AND le.reference_type IS DISTINCT FROM 'migration_balance'
              AND le.reference_type IS DISTINCT FROM 'legacy_sheet'
              AND le.reference_type IS DISTINCT FROM 'legacy_balance_addition'
              AND $2::timestamptz IS NOT NULL AND le.created_at >= $2::timestamptz
          ),0) AS post_cutover
        FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id
        GROUP BY c.id,c.legacy_id
      )
      SELECT COUNT(*)::int compared,
        COUNT(*) FILTER(WHERE b.legacy_id IS NULL)::int missing,
        COUNT(*) FILTER(WHERE b.legacy_id IS NOT NULL AND ABS(b.frozen_baseline-src.target_balance)>.0005)::int mismatches,
        COALESCE(MAX(ABS(COALESCE(b.frozen_baseline,0)-src.target_balance)),0)::numeric(16,3) max_diff,
        COALESCE(SUM(b.post_cutover),0)::numeric(16,3) post_cutover_total
      FROM src LEFT JOIN b ON b.legacy_id=src.legacy_id
    `,[runId,run.cutover_at||null]).then(r=>r.rows[0]),
    db.query(`
      WITH valid AS (
        SELECT DISTINCT trim(row_data->>'المعرّف') movement_id
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='الحركات'
          AND trim(COALESCE(row_data->>'المعرّف',''))<>''
      )
      SELECT COUNT(*)::int expected,COUNT(le.id)::int matched,
        COUNT(*) FILTER(WHERE le.id IS NULL)::int missing
      FROM valid v LEFT JOIN ledger_entries le
        ON le.reference_type='legacy_sheet' AND le.reference_id=v.movement_id AND le.reversed_at IS NULL
    `,[runId]).then(r=>r.rows[0]),
    db.query(`
      WITH valid AS (
        SELECT DISTINCT trim(row_data->>'معرّف الرسالة') id_message
        FROM full_migration_stage_rows
        WHERE run_id=$1 AND sheet_name='رسائل واتساب'
          AND trim(COALESCE(row_data->>'معرّف الرسالة',''))<>''
      )
      SELECT COUNT(*)::int expected,COUNT(w.id)::int matched,
        COUNT(*) FILTER(WHERE w.id IS NULL)::int missing
      FROM valid v LEFT JOIN whatsapp_events w ON w.id_message=v.id_message
    `,[runId]).then(r=>r.rows[0]),
    db.query(`SELECT sheet_name,COUNT(*)::int rows FROM full_migration_stage_rows WHERE run_id=$1 GROUP BY sheet_name ORDER BY sheet_name`,[runId]).then(r=>Object.fromEntries(r.rows.map(x=>[x.sheet_name,Number(x.rows)])))
  ]);
  const blocking=[];
  if(!finalMode)blocking.push('run_mode_not_final_week_cutover');
  if(run.status!=='completed')blocking.push(`run_not_completed:${run.status}`);
  if(!run.cutover_at)blocking.push('cutover_at_missing');
  if(Number(captains.missing||0)>0)blocking.push(`${captains.missing} captains_missing`);
  if(Number(users.missing||0)>0)blocking.push(`${users.missing} captain_users_missing`);
  if(Number(balances.missing||0)>0)blocking.push(`${balances.missing} balances_missing`);
  if(Number(balances.mismatches||0)>0)blocking.push(`${balances.mismatches} balances_mismatch`);
  if(Number(movements.missing||0)>0)blocking.push(`${movements.missing} movements_missing`);
  if(Number(whatsapp.missing||0)>0)blocking.push(`${whatsapp.missing} whatsapp_missing`);
  return {
    ready:blocking.length===0,
    checkedAt:new Date().toISOString(),run,stage,captains,users,
    balances:{...balances,max_diff:Number(balances.max_diff||0),post_cutover_total:Number(balances.post_cutover_total||0)},
    movements,whatsapp,blocking
  };
}

// V3.8.5.9 — Safe full-week inventory rebuild -------------------------------------
// Never DELETE financial rows. Active automatic WhatsApp inventory rows are reversed
// with auditable REVERSAL rows, then the source whatsapp_events are replayed in order.
export async function resetWhatsappInventoryRange({fromAt,cutoffAt,userId=null,reason='إعادة بناء جرد الأسبوع'}={}) {
  const fromIso=new Date(fromAt).toISOString(),cutoffIso=new Date(cutoffAt).toISOString();
  if(new Date(fromIso)>=new Date(cutoffIso))throw Object.assign(new Error('inventory_rebuild_range_invalid'),{statusCode:400});
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query(`
      SELECT le.*
      FROM ledger_entries le
      WHERE le.reversed_at IS NULL AND le.entry_type<>'REVERSAL'
        AND le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz
        AND (
          le.reference_type IN ('green_reaction','green_partial')
          OR (le.reference_type='legacy_sheet' AND (
            COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')
            OR COALESCE(le.description,'') ILIKE '%جرد واتساب%'
            OR COALESCE(le.description,'') ILIKE '%إلغاء Reaction%'
          ))
        )
      ORDER BY le.id
      FOR UPDATE
    `,[fromIso,cutoffIso]);
    const ids=q.rows.map(x=>Number(x.id));
    const captainIds=[...new Set(q.rows.map(x=>String(x.captain_id)).filter(Boolean))];
    if(captainIds.length)await client.query(`SELECT id FROM captains WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[captainIds]);
    const existing=ids.length?(await client.query(`SELECT reversed_entry_id FROM ledger_entries WHERE reversed_entry_id=ANY($1::bigint[])`,[ids])).rows:[];
    const already=new Set(existing.map(x=>String(x.reversed_entry_id)));
    const reversedIds=[];const doneIds=new Set();
    for(const e of q.rows){
      if(already.has(String(e.id)))continue;
      const done=String(e.metadata?.doneMessageId||'').trim();if(done)doneIds.add(done);
      await client.query(`
        INSERT INTO ledger_entries(
          captain_id,amount,entry_type,direction,reference_type,reference_id,
          description,metadata,created_by_user_id,reversed_entry_id
        ) VALUES($1,$2,'REVERSAL',$3,'ledger_entry',$4,$5,$6::jsonb,$7,$8)
      `,[e.captain_id,-Number(e.amount),Number(e.amount)>0?'debit':'credit',`REBUILD-REV-${e.id}`,
        `${reason} — عكس مؤقت للحركة ${e.id}`,
        JSON.stringify({originalEntryType:e.entry_type,fullWeekRebuild:true,rebuildFrom:fromIso,rebuildCutoff:cutoffIso}),userId||null,e.id]);
      reversedIds.push(Number(e.id));
    }
    if(reversedIds.length)await client.query(`UPDATE ledger_entries SET reversed_at=COALESCE(reversed_at,NOW()) WHERE id=ANY($1::bigint[])`,[reversedIds]);
    if(doneIds.size){
      await client.query(`
        UPDATE inventory_reaction_cancellations
        SET status='REOPENED',reopened_by_user_id=$2,reopened_at=NOW(),reopen_reason=$3
        WHERE done_message_id=ANY($1::text[]) AND status IN ('LOCKED','PARTIAL')
      `,[[...doneIds],userId||null,'تم إلغاء نتيجة الجرد القديمة لبدء إعادة بناء الأسبوع من الصفر']);
    }
    await client.query(`INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'whatsapp.inventory.full_week_reset','system','current_week',$2::jsonb)`,[userId||null,JSON.stringify({fromAt:fromIso,cutoffAt:cutoffIso,reversedCount:reversedIds.length,captainIds})]);
    await client.query('COMMIT');
    return {fromAt:fromIso,cutoffAt:cutoffIso,reversedCount:reversedIds.length,reversedIds,captainIds,doneIds:[...doneIds]};
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}

// Live cutover + historical repair -------------------------------------------------
const WHATSAPP_CUTOVER_SETTING = "whatsapp_live_cutover";

function eventTimeSql(alias="whatsapp_events") {
  return `CASE
    WHEN ${alias}.event_timestamp IS NULL THEN ${alias}.webhook_received_at
    WHEN ${alias}.event_timestamp > 100000000000 THEN to_timestamp(${alias}.event_timestamp/1000.0)
    ELSE to_timestamp(${alias}.event_timestamp::double precision)
  END`;
}

export async function setWhatsappLiveCutover(cutoverAt,userId=null) {
  const iso=new Date(cutoverAt||Date.now()).toISOString();
  await setSystemSetting(WHATSAPP_CUTOVER_SETTING,{cutoverAt:iso},userId);
  return iso;
}

export async function getWhatsappLiveCutover() {
  const v=await getSystemSetting(WHATSAPP_CUTOVER_SETTING,null);
  const iso=v?.cutoverAt||null;
  return iso && !Number.isNaN(new Date(iso).getTime()) ? iso : null;
}

export async function createWhatsappRepairRun({fromAt,cutoffAt,userId=null,runKey,timeBasis='event'}={}) {
  const fromIso=new Date(fromAt).toISOString();
  const cutoffIso=new Date(cutoffAt).toISOString();
  const basis=String(timeBasis||'event').toLowerCase()==='received'?'received':'event';
  const key=String(runKey||`repair-${Date.now()}-${Math.random().toString(36).slice(2,10)}`);
  const timeExpr=basis==='received'?'e.webhook_received_at':eventTimeSql('e');
  const snap=await db.query(`SELECT COUNT(*)::int AS n,COALESCE(MAX(e.id),0)::bigint AS max_id FROM whatsapp_events e WHERE ${timeExpr} >= $1 AND ${timeExpr} < $2`,[fromIso,cutoffIso]);
  const total=Number(snap.rows[0]?.n||0),maxId=Number(snap.rows[0]?.max_id||0);
  const r=await db.query(`
    INSERT INTO whatsapp_repair_runs(run_key,from_at,cutoff_at,status,total_events,snapshot_max_event_id,started_by_user_id,time_basis)
    VALUES($1,$2,$3,'QUEUING',$4,$5,$6,$7) RETURNING *
  `,[key,fromIso,cutoffIso,total,maxId,userId||null,basis]);
  return r.rows[0];
}

export async function listWhatsappRepairEvents(runId,offset=0,limit=1000) {
  const run=await db.query(`SELECT * FROM whatsapp_repair_runs WHERE id=$1`,[runId]);
  if(!run.rowCount)throw Object.assign(new Error('repair_run_not_found'),{statusCode:404});
  const x=run.rows[0];
  const basis=String(x.time_basis||'event').toLowerCase()==='received'?'received':'event';
  const timeExpr=basis==='received'?'e.webhook_received_at':eventTimeSql('e');
  const r=await db.query(`
    SELECT id_message,raw_payload,${timeExpr} AS event_at
    FROM whatsapp_events e
    WHERE ${timeExpr} >= $1 AND ${timeExpr} < $2
      AND e.id <= $3
    ORDER BY ${timeExpr} ASC,e.id ASC
    OFFSET $4 LIMIT $5
  `,[x.from_at,x.cutoff_at,Number(x.snapshot_max_event_id||0),Math.max(0,Number(offset)||0),Math.min(2000,Math.max(1,Number(limit)||1000))]);
  return r.rows;
}

export async function markWhatsappRepairQueued(runId,count) {
  const r=await db.query(`
    UPDATE whatsapp_repair_runs SET queued_events=LEAST(total_events,queued_events+$2),status='RUNNING',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
    WHERE id=$1 RETURNING *
  `,[runId,Math.max(0,Number(count)||0)]);
  return r.rows[0]||null;
}

export async function addLateWhatsappRepairEvent(runId) {
  if(!runId)return;
  await db.query(`UPDATE whatsapp_repair_runs SET total_events=total_events+1,queued_events=queued_events+1,status=CASE WHEN status='COMPLETED' THEN 'RUNNING' ELSE status END,completed_at=NULL,updated_at=NOW() WHERE id=$1`,[runId]);
}

export async function markWhatsappRepairResult(runId,{repaired=0,duplicate=0,preserved=0,failed=0,error=null}={}) {
  if(!runId)return null;
  const r=await db.query(`
    UPDATE whatsapp_repair_runs SET
      processed_events=processed_events+CASE WHEN $5::int=0 THEN 1 ELSE 0 END,
      repaired_events=repaired_events+$2,
      duplicate_events=duplicate_events+$3,
      preserved_deleted_jobs=preserved_deleted_jobs+$4,
      failed_events=failed_events+$5,
      last_error=CASE WHEN $6::text<>'' THEN $6 ELSE last_error END,
      updated_at=NOW()
    WHERE id=$1 RETURNING *
  `,[runId,Number(repaired)||0,Number(duplicate)||0,Number(preserved)||0,Number(failed)||0,String(error||'').slice(0,4000)]);
  if(!r.rowCount)return null;
  const x=r.rows[0];
  const done=Number(x.processed_events||0)+Number(x.failed_events||0)>=Number(x.total_events||0) && Number(x.queued_events||0)>=Number(x.total_events||0);
  if(done){
    const fin=await db.query(`UPDATE whatsapp_repair_runs SET status=CASE WHEN failed_events>0 THEN 'FAILED' ELSE 'COMPLETED' END,completed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[runId]);
    return fin.rows[0];
  }
  return x;
}

export async function latestWhatsappRepairRun() {
  const r=await db.query(`SELECT * FROM whatsapp_repair_runs ORDER BY id DESC LIMIT 1`);
  return r.rows[0]||null;
}

export async function getWhatsappRepairRun(runId) {
  const id=Number(runId||0);
  if(!id)return null;
  const r=await db.query(`SELECT * FROM whatsapp_repair_runs WHERE id=$1 LIMIT 1`,[id]);
  return r.rows[0]||null;
}


// V3.8.5.19 — reconcile a stalled repair run against durable completion traces.
// This deliberately uses PostgreSQL as the source of truth instead of BullMQ counts,
// because queue jobs can disappear after drain/redeploy while the repair run row remains RUNNING.
export async function reconcileWhatsappRepairRunForResume(runId) {
  const id=Number(runId||0);
  if(!id)throw Object.assign(new Error('repair_run_required'),{statusCode:400});
  const rr=await db.query(`SELECT * FROM whatsapp_repair_runs WHERE id=$1 LIMIT 1`,[id]);
  if(!rr.rowCount)throw Object.assign(new Error('repair_run_not_found'),{statusCode:404});
  const run=rr.rows[0];
  const basis=String(run.time_basis||'event').toLowerCase()==='received'?'received':'event';
  const timeExpr=basis==='received'?'e.webhook_received_at':eventTimeSql('e');
  // Include all events that have arrived for the fixed rebuild time range up to this resume moment.
  // Then freeze the new snapshot_max_event_id so the resume list itself cannot grow while it is queued.
  const snap=await db.query(`
    WITH candidates AS (
      SELECT e.id,e.id_message
      FROM whatsapp_events e
      WHERE ${timeExpr} >= $1 AND ${timeExpr} < $2
    )
    SELECT COUNT(*)::int AS total,COALESCE(MAX(id),0)::bigint AS max_id,
      COUNT(*) FILTER(WHERE EXISTS(
        SELECT 1 FROM whatsapp_event_traces t
        WHERE t.id_message=candidates.id_message
          AND t.stage='worker.repair.completed'
          AND COALESCE(t.details->>'runId','')=$3
      ))::int AS completed
    FROM candidates
  `,[run.from_at,run.cutoff_at,String(id)]);
  const total=Number(snap.rows[0]?.total||0),maxId=Number(snap.rows[0]?.max_id||0),completed=Number(snap.rows[0]?.completed||0);
  const status=completed>=total?'COMPLETED':'RUNNING';
  const up=await db.query(`
    UPDATE whatsapp_repair_runs SET
      total_events=$2,
      snapshot_max_event_id=$3,
      processed_events=$4,
      failed_events=0,
      queued_events=$2,
      status=$5,
      completed_at=CASE WHEN $5='COMPLETED' THEN COALESCE(completed_at,NOW()) ELSE NULL END,
      last_error=CASE WHEN $5='COMPLETED' THEN last_error ELSE NULL END,
      started_at=COALESCE(started_at,NOW()),updated_at=NOW()
    WHERE id=$1 RETURNING *
  `,[id,total,maxId,completed,status]);
  return {...up.rows[0],truthCompleted:completed,truthMissing:Math.max(0,total-completed)};
}

export async function listWhatsappRepairUnfinishedEvents(runId,offset=0,limit=1000) {
  const id=Number(runId||0);
  if(!id)throw Object.assign(new Error('repair_run_required'),{statusCode:400});
  const rr=await db.query(`SELECT * FROM whatsapp_repair_runs WHERE id=$1 LIMIT 1`,[id]);
  if(!rr.rowCount)throw Object.assign(new Error('repair_run_not_found'),{statusCode:404});
  const run=rr.rows[0];
  const basis=String(run.time_basis||'event').toLowerCase()==='received'?'received':'event';
  const timeExpr=basis==='received'?'e.webhook_received_at':eventTimeSql('e');
  const r=await db.query(`
    SELECT e.id_message,e.raw_payload,${timeExpr} AS event_at
    FROM whatsapp_events e
    WHERE ${timeExpr} >= $1 AND ${timeExpr} < $2
      AND e.id <= $3
      AND NOT EXISTS(
        SELECT 1 FROM whatsapp_event_traces t
        WHERE t.id_message=e.id_message
          AND t.stage='worker.repair.completed'
          AND COALESCE(t.details->>'runId','')=$4
      )
    ORDER BY ${timeExpr} ASC,e.id ASC
    OFFSET $5 LIMIT $6
  `,[run.from_at,run.cutoff_at,Number(run.snapshot_max_event_id||0),String(id),Math.max(0,Number(offset)||0),Math.min(2000,Math.max(1,Number(limit)||1000))]);
  return r.rows;
}

export async function cancelOtherWhatsappRepairRuns(keepRunId,reason='إلغاء Repairs القديمة أثناء تثبيت إعادة جرد الجمعة',userId=null) {
  const keep=Number(keepRunId||0);
  if(!keep)throw Object.assign(new Error('keep_repair_run_required'),{statusCode:400});
  const r=await db.query(`
    UPDATE whatsapp_repair_runs
    SET status='CANCELLED',completed_at=COALESCE(completed_at,NOW()),
        last_error=CASE WHEN trim(COALESCE(last_error,''))='' THEN $2 ELSE left(last_error || E'\n' || $2,4000) END,
        updated_at=NOW()
    WHERE status IN ('QUEUING','RUNNING') AND id<>$1
    RETURNING id,run_key,status,total_events,queued_events,processed_events,failed_events
  `,[keep,String(reason||'').slice(0,1000)]);
  if(r.rowCount)await audit(userId,'whatsapp.repair.cancel_other_runs','system','whatsapp_repair',{keepRunId:keep,reason:String(reason||''),runs:r.rows});
  return r.rows;
}

export async function activeWhatsappRepairRun() {
  const r=await db.query(`SELECT * FROM whatsapp_repair_runs WHERE status IN ('QUEUING','RUNNING') ORDER BY id DESC LIMIT 1`);
  return r.rows[0]||null;
}

export async function cancelActiveWhatsappRepairRuns(reason='Final takeover pre-cutover cleanup', userId=null) {
  const r=await db.query(`
    UPDATE whatsapp_repair_runs
    SET status='CANCELLED',
        completed_at=COALESCE(completed_at,NOW()),
        last_error=CASE
          WHEN trim(COALESCE(last_error,''))='' THEN $1
          ELSE left(last_error || E'\n' || $1,4000)
        END,
        updated_at=NOW()
    WHERE status IN ('QUEUING','RUNNING')
    RETURNING id,run_key,status,total_events,queued_events,processed_events,failed_events
  `,[String(reason||'Final takeover pre-cutover cleanup').slice(0,1000)]);
  if(r.rowCount){
    await audit(userId,'whatsapp.repair.cancel_for_final_takeover','system','whatsapp_repair',{
      reason:String(reason||''),runs:r.rows
    });
  }
  return r.rows;
}

export async function getWhatsappCutoverRepairStatus() {
  return {cutoverAt:await getWhatsappLiveCutover(),repair:await latestWhatsappRepairRun()};
}

// V3.8 old Google Apps Script -> Railway week repair bridge -----------------------
export async function beginLegacyWeekBridgeRun({runKey,fromAt,cutoffAt,spreadsheetId=null}={}) {
  const key=String(runKey||'').trim();
  if(!key)throw Object.assign(new Error('bridge_run_key_required'),{statusCode:400});
  const fromIso=new Date(fromAt).toISOString();
  const cutoffIso=new Date(cutoffAt).toISOString();
  if(new Date(fromIso)>=new Date(cutoffIso))throw Object.assign(new Error('bridge_range_invalid'),{statusCode:400});
  const r=await db.query(`
    INSERT INTO legacy_week_bridge_runs(run_key,from_at,cutoff_at,status,source_spreadsheet_id)
    VALUES($1,$2,$3,'UPLOADING',$4)
    ON CONFLICT(run_key) DO UPDATE SET
      from_at=EXCLUDED.from_at,
      cutoff_at=EXCLUDED.cutoff_at,
      source_spreadsheet_id=COALESCE(EXCLUDED.source_spreadsheet_id,legacy_week_bridge_runs.source_spreadsheet_id),
      updated_at=NOW()
    RETURNING *
  `,[key,fromIso,cutoffIso,spreadsheetId?String(spreadsheetId):null]);
  return r.rows[0];
}

export async function importLegacyWeekBridgeBatch({runKey,rows=[]}={}) {
  const key=String(runKey||'').trim();
  const runQ=await db.query(`SELECT * FROM legacy_week_bridge_runs WHERE run_key=$1`,[key]);
  if(!runQ.rowCount)throw Object.assign(new Error('bridge_run_not_found'),{statusCode:404});
  const run=runQ.rows[0];
  if(!['UPLOADING','READY'].includes(String(run.status)))throw Object.assign(new Error('bridge_run_not_uploading'),{statusCode:409});
  let inserted=0,duplicates=0,invalid=0,received=0;
  for(const item of Array.isArray(rows)?rows:[]){
    received++;
    const payload=item?.payload&&typeof item.payload==='object'?item.payload:null;
    if(!payload?.idMessage){invalid++;continue;}
    try{
      const result=await insertWebhookEvent(payload,{
        receivedAt:item?.receivedAt||null,
        processingMode:'legacy_week_bridge',
        traceStage:'legacy_bridge.imported'
      });
      if(result.inserted)inserted++;else duplicates++;
    }catch(e){
      invalid++;
      await traceWebhookEvent(payload.idMessage||`BRIDGE-${key}`,'legacy_bridge.import_error',{error:e?.message||String(e)}).catch(()=>{});
    }
  }
  const updated=await db.query(`
    UPDATE legacy_week_bridge_runs SET
      received_rows=received_rows+$2,
      inserted_events=inserted_events+$3,
      duplicate_events=duplicate_events+$4,
      invalid_events=invalid_events+$5,
      updated_at=NOW()
    WHERE run_key=$1 RETURNING *
  `,[key,received,inserted,duplicates,invalid]);
  return {run:updated.rows[0],received,inserted,duplicates,invalid};
}

export async function completeLegacyWeekBridgeUpload(runKey) {
  const r=await db.query(`
    UPDATE legacy_week_bridge_runs
    SET status=CASE WHEN status='UPLOADING' THEN 'READY' ELSE status END,updated_at=NOW()
    WHERE run_key=$1 RETURNING *
  `,[String(runKey||'')]);
  if(!r.rowCount)throw Object.assign(new Error('bridge_run_not_found'),{statusCode:404});
  return r.rows[0];
}

export async function attachLegacyWeekBridgeRepair(runKey,repairRunId) {
  const r=await db.query(`
    UPDATE legacy_week_bridge_runs
    SET repair_run_id=$2,status='REPAIR_RUNNING',updated_at=NOW()
    WHERE run_key=$1 RETURNING *
  `,[String(runKey||''),Number(repairRunId)]);
  if(!r.rowCount)throw Object.assign(new Error('bridge_run_not_found'),{statusCode:404});
  return r.rows[0];
}

export async function failLegacyWeekBridgeRun(runKey,error) {
  const r=await db.query(`
    UPDATE legacy_week_bridge_runs
    SET status='FAILED',last_error=$2,completed_at=NOW(),updated_at=NOW()
    WHERE run_key=$1 RETURNING *
  `,[String(runKey||''),String(error||'').slice(0,4000)]);
  return r.rows[0]||null;
}

export async function stopActiveLegacyWeekBridgeRuns(reason='تم إيقاف جسر Google القديم أثناء إعادة بناء جرد الجمعة',userId=null) {
  const msg=String(reason||'').slice(0,1000);
  const r=await db.query(`
    UPDATE legacy_week_bridge_runs
    SET status='CANCELLED',completed_at=COALESCE(completed_at,NOW()),
        last_error=CASE WHEN trim(COALESCE(last_error,''))='' THEN $1 ELSE left(last_error || E'\n' || $1,4000) END,
        updated_at=NOW()
    WHERE status IN ('UPLOADING','READY','REPAIR_RUNNING')
    RETURNING id,run_key,status,repair_run_id,received_rows,inserted_events,duplicate_events,invalid_events
  `,[msg]);
  if(r.rowCount)await audit(userId,'legacy_week_bridge.stop','system','legacy_week_bridge',{reason:msg,runs:r.rows});
  return r.rows;
}

export async function getLegacyWeekBridgeStatus(runKey=null) {
  const params=[];
  let where='';
  if(runKey){params.push(String(runKey));where='WHERE b.run_key=$1';}
  const r=await db.query(`
    SELECT b.*,
      wr.status AS repair_status,wr.total_events AS repair_total_events,wr.queued_events AS repair_queued_events,
      wr.processed_events AS repair_processed_events,wr.repaired_events AS repair_repaired_events,
      wr.duplicate_events AS repair_duplicate_events,wr.preserved_deleted_jobs AS repair_preserved_deleted_jobs,
      wr.failed_events AS repair_failed_events,wr.last_error AS repair_last_error,wr.completed_at AS repair_completed_at
    FROM legacy_week_bridge_runs b
    LEFT JOIN whatsapp_repair_runs wr ON wr.id=b.repair_run_id
    ${where}
    ORDER BY b.id DESC LIMIT 1
  `,params);
  const row=r.rows[0]||null;
  if(!row)return null;
  if(row.status==='REPAIR_RUNNING' && ['COMPLETED','FAILED','CANCELLED'].includes(String(row.repair_status||''))){
    const status=row.repair_status==='COMPLETED'?'COMPLETED':'FAILED';
    const u=await db.query(`UPDATE legacy_week_bridge_runs SET status=$2,completed_at=COALESCE(completed_at,NOW()),last_error=COALESCE(NULLIF($3,''),last_error),updated_at=NOW() WHERE id=$1 RETURNING *`,[row.id,status,String(row.repair_last_error||'')]);
    return {...row,...u.rows[0]};
  }
  return row;
}

// WhatsApp ingestion
export async function insertWebhookEvent(payload,{receivedAt=null,processingMode=null,traceStage=null}={}) {
  const idMessage = payload?.idMessage;
  if (!idMessage) return { inserted:false, reason:"missing_idMessage" };
  const s = payload?.senderData || {};
  const m = payload?.messageData || {};
  const text =
    m?.textMessageData?.textMessage ??
    m?.extendedTextMessageData?.text ??
    m?.quotedMessage?.textMessage ??
    null;
  const received = receivedAt && !Number.isNaN(new Date(receivedAt).getTime()) ? new Date(receivedAt).toISOString() : null;
  // V-FIX: event_timestamp is BIGINT — a decimal value (e.g. WAHA's
  // message.reaction timestamp, "1788212610.343") makes Postgres reject the
  // insert outright ("invalid input syntax for type bigint"), which — with no
  // try/catch at either call site — surfaced as an uncaught 500. Coerce here
  // too, as a safety net independent of what any caller passes in.
  const eventTimestamp=normalizeWhatsappEventTimestamp(payload?.timestamp);

  const r = await db.query(`
    INSERT INTO whatsapp_events
    (id_message,webhook_type,chat_id,sender_id,sender_name,message_type,message_text,event_timestamp,raw_payload,status,webhook_received_at,processing_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'received',COALESCE($10::timestamptz,NOW()),$11)
    ON CONFLICT(id_message) DO UPDATE SET
      duplicate_count=whatsapp_events.duplicate_count+1,
      last_duplicate_at=NOW()
    RETURNING id,(xmax=0) AS inserted,duplicate_count
  `, [
    idMessage, payload?.typeWebhook || null, s?.chatId || null, s?.sender || null,
    s?.senderName || null, m?.typeMessage || null, text, eventTimestamp,
    JSON.stringify(payload), received, processingMode||null
  ]);
  const inserted=Boolean(r.rows[0]?.inserted);
  if(inserted){
    await traceWebhookEvent(idMessage,traceStage||"webhook.received",{typeWebhook:payload?.typeWebhook||null,receivedAt:received,processingMode:processingMode||null});
  }else{
    await traceWebhookEvent(idMessage,"duplicate.prevented",{duplicateCount:Number(r.rows[0]?.duplicate_count||1),source:processingMode||null});
  }
  return {inserted, reason:inserted?"inserted":"duplicate", duplicateCount:Number(r.rows[0]?.duplicate_count||0)};
}

export async function markQueued(idMessage, processingMode=null) {
  await db.query(`UPDATE whatsapp_events SET queued_at=NOW(),status='queued',processing_mode=COALESCE($2,processing_mode) WHERE id_message=$1`, [idMessage,processingMode]);
}
export async function markManyQueued(idMessages, processingMode=null) {
  const ids=(Array.isArray(idMessages)?idMessages:[]).map(String).filter(Boolean);
  if(!ids.length)return 0;
  const r=await db.query(`UPDATE whatsapp_events SET queued_at=NOW(),status='queued',processing_mode=COALESCE($2,processing_mode) WHERE id_message=ANY($1::text[])`,[ids,processingMode]);
  return r.rowCount;
}
export async function markProcessing(idMessage, attempts, processingMode=null) {
  await db.query(`UPDATE whatsapp_events SET processing_started_at=NOW(),status='processing',attempts=$2,processing_mode=COALESCE($3,processing_mode) WHERE id_message=$1`, [idMessage, attempts, processingMode]);
}
export async function markProcessed(idMessage, processingMode=null) {
  await db.query(`UPDATE whatsapp_events SET processed_at=NOW(),status=CASE WHEN status IN ('reversed','waiting_review','waiting_completion','waiting_reaction','blocked','ignored','duplicate','error') THEN status ELSE 'processed' END,last_error=CASE WHEN status IN ('reversed','waiting_review','blocked','ignored','error') THEN last_error ELSE NULL END,processing_mode=COALESCE($2,processing_mode) WHERE id_message=$1`, [idMessage,processingMode]);
}
export async function markFailed(idMessage, err) {
  const message=String(err||"unknown").slice(0,4000);
  await db.query(`UPDATE whatsapp_events SET status=CASE WHEN $2 LIKE '%WAHA_LID_UNRESOLVED:%' THEN 'waiting_identity' ELSE 'failed' END,last_error=$2 WHERE id_message=$1`, [idMessage,message]);
}
export async function getStats() {
  const r = await db.query(`
    SELECT COUNT(*)::int total,
      COUNT(*) FILTER(WHERE status='received')::int received,
      COUNT(*) FILTER(WHERE status='queued')::int queued,
      COUNT(*) FILTER(WHERE status='processing')::int processing,
      COUNT(*) FILTER(WHERE status='processed')::int processed,
      COUNT(*) FILTER(WHERE status='failed')::int failed,
      MAX(webhook_received_at) last_webhook_at,
      MAX(processed_at) last_processed_at
    FROM whatsapp_events
  `);
  return r.rows[0];
}

// Accountant live WhatsApp group feed --------------------------------------------
export async function getWhatsappLiveFeed({afterId=0,limit=80,chatId="",includeStats=true,processingMode=""}={}) {
  const after=Math.max(0,Number(afterId)||0);
  const lim=Math.min(150,Math.max(1,Number(limit)||80));
  const group=String(chatId||"").trim();
  const mode=String(processingMode||"").trim();
  let rows;
  if(after>0){
    rows=(await db.query(`
      SELECT e.id,e.id_message,e.webhook_type,e.chat_id,e.sender_id,e.sender_name,
        e.message_type,e.message_text,e.event_timestamp,e.webhook_received_at,
        e.processing_started_at,e.processed_at,e.status,e.processing_mode,e.last_error,
        e.duplicate_count,e.raw_payload,
        ${eventTimeSql('e')} AS event_at
      FROM whatsapp_events e
      WHERE e.id>$1 AND ($3::text='' OR e.chat_id=$3) AND ($4::text='' OR e.processing_mode=$4)
      ORDER BY e.id ASC
      LIMIT $2
    `,[after,lim,group,mode])).rows;
  }else{
    rows=(await db.query(`
      SELECT * FROM (
        SELECT e.id,e.id_message,e.webhook_type,e.chat_id,e.sender_id,e.sender_name,
          e.message_type,e.message_text,e.event_timestamp,e.webhook_received_at,
          e.processing_started_at,e.processed_at,e.status,e.processing_mode,e.last_error,
          e.duplicate_count,e.raw_payload,
          ${eventTimeSql('e')} AS event_at
        FROM whatsapp_events e
        WHERE ($2::text='' OR e.chat_id=$2) AND ($3::text='' OR e.processing_mode=$3)
        ORDER BY e.id DESC
        LIMIT $1
      ) x ORDER BY x.id ASC
    `,[lim,group,mode])).rows;
  }
  let stats=null;
  if(includeStats!==false){
    stats=(await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE webhook_received_at>=NOW()-INTERVAL '1 hour')::int AS last_hour,
        COUNT(*) FILTER (WHERE status IN ('received','queued','processing'))::int AS pending,
        COUNT(*) FILTER (WHERE status='failed')::int AS failed,
        COUNT(*) FILTER (WHERE processing_mode='live' AND webhook_received_at>=NOW()-INTERVAL '1 hour')::int AS live_last_hour,
        COUNT(*) FILTER (WHERE processing_mode='repair' AND webhook_received_at>=NOW()-INTERVAL '1 hour')::int AS repair_last_hour,
        MAX(id)::bigint AS max_id,
        MAX(webhook_received_at) AS last_webhook_at,
        MAX(processed_at) AS last_processed_at,
        AVG(EXTRACT(EPOCH FROM(processed_at-webhook_received_at))*1000)
          FILTER (WHERE processed_at IS NOT NULL AND webhook_received_at>=NOW()-INTERVAL '1 hour') AS avg_delay_ms
      FROM whatsapp_events
      WHERE ($1::text='' OR chat_id=$1) AND ($2::text='' OR processing_mode=$2)
    `,[group,mode])).rows[0]||{};
  }
  return {rows,stats};
}


// V3.8.2 — current Google balance delta after historical week Repair.
// Old Google balance is treated as the baseline at bridge cutoff. Any genuine LIVE Railway
// entries at/after cutoff are preserved, while historical Repair entries are already included
// in the Google target and therefore are not added a second time.
export async function applyLegacyWeekCurrentBalanceSync({runKey,cutoffAt,rows=[]}={}) {
  const key=String(runKey||'').trim();
  if(!key)throw Object.assign(new Error('bridge_run_key_required'),{statusCode:400});
  const cutoff=new Date(cutoffAt);
  if(!Number.isFinite(cutoff.getTime()))throw Object.assign(new Error('bridge_cutoff_invalid'),{statusCode:400});
  let applied=0,missing=0,unchanged=0,totalDelta=0;const eligibleCaptainIds=[];
  for(const item of Array.isArray(rows)?rows:[]){
    const legacyId=String(item?.legacyId||'').trim();
    const phone=String(item?.phone||'').replace(/\D/g,'');
    const target=Number(String(item?.balance??'').replace('٫','.').replace(/[^0-9.\-]/g,''));
    if(!Number.isFinite(target)){missing++;continue;}
    const cq=await db.query(`SELECT id,legacy_id,phone FROM captains WHERE ($1<>'' AND legacy_id=$1) OR ($2<>'' AND RIGHT(regexp_replace(phone,'[^0-9]','','g'),9)=RIGHT($2,9)) ORDER BY CASE WHEN legacy_id=$1 THEN 0 ELSE 1 END LIMIT 1`,[legacyId,phone]);
    if(!cq.rowCount){missing++;continue;}
    const captain=cq.rows[0];
    const ref=`${key}:${captain.id}`;
    const sums=(await db.query(`
      SELECT
        COALESCE(SUM(amount) FILTER(WHERE NOT(reference_type='legacy_balance_sync' AND reference_id=$2)),0)::numeric AS current_without_this,
        COALESCE(SUM(amount) FILTER(
          WHERE created_at >= $3
            AND reference_type NOT IN ('legacy_sheet','legacy_balance_addition','migration_balance','legacy_balance_sync')
            AND NOT(reference_type='green_reaction' AND COALESCE(metadata->>'repairMode','false')='true')
        ),0)::numeric AS live_after_cutoff
      FROM ledger_entries
      WHERE captain_id=$1 AND reversed_at IS NULL
    `,[captain.id,ref,cutoff.toISOString()])).rows[0];
    const currentWithout=Number(sums.current_without_this||0);
    const liveAfter=Number(sums.live_after_cutoff||0);
    const desired=Number((target+liveAfter).toFixed(3));
    const delta=Number((desired-currentWithout).toFixed(3));
    await db.query(`
      INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata)
      VALUES($1,$2,'LEGACY_BALANCE_SYNC',CASE WHEN $2>=0 THEN 'credit' ELSE 'debit' END,'legacy_balance_sync',$3,$4,$5::jsonb)
      ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL
      DO UPDATE SET amount=EXCLUDED.amount,direction=EXCLUDED.direction,description=EXCLUDED.description,metadata=EXCLUDED.metadata
    `,[captain.id,delta,ref,'مطابقة فرق الرصيد المتراكم بعد Repair الأسبوع',JSON.stringify({runKey:key,cutoffAt:cutoff.toISOString(),googleTarget:target,liveAfterCutoff:liveAfter,desiredBalance:desired})]);
    if(Math.abs(delta)<0.0005)unchanged++; else applied++;
    if(desired>-.75)eligibleCaptainIds.push(String(captain.id));
    totalDelta+=delta;
  }
  await db.query(`UPDATE legacy_week_bridge_runs SET balance_sync_rows=COALESCE(balance_sync_rows,0)+$2,balance_sync_delta=COALESCE(balance_sync_delta,0)+$3,updated_at=NOW() WHERE run_key=$1`,[key,Array.isArray(rows)?rows.length:0,Number(totalDelta.toFixed(3))]).catch(async()=>{
    await db.query(`ALTER TABLE legacy_week_bridge_runs ADD COLUMN IF NOT EXISTS balance_sync_rows INTEGER NOT NULL DEFAULT 0; ALTER TABLE legacy_week_bridge_runs ADD COLUMN IF NOT EXISTS balance_sync_delta NUMERIC(14,3) NOT NULL DEFAULT 0;`);
    await db.query(`UPDATE legacy_week_bridge_runs SET balance_sync_rows=balance_sync_rows+$2,balance_sync_delta=balance_sync_delta+$3,updated_at=NOW() WHERE run_key=$1`,[key,Array.isArray(rows)?rows.length:0,Number(totalDelta.toFixed(3))]);
  });
  return {received:Array.isArray(rows)?rows.length:0,applied,unchanged,missing,totalDelta:Number(totalDelta.toFixed(3)),eligibleCaptainIds};
}
