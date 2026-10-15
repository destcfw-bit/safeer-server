export const CLEAN_SLATE_VERSION="3.8.5.72";
export const CLEAN_SLATE_SETTING="clean_slate_reset_v38572";

// Account/configuration tables are intentionally absent: captains, users,
// recharge_portal_users, inventory_cancellation_numbers, and system_settings.
export const CLEAN_SLATE_OPERATIONAL_TABLES=Object.freeze([
  "captain_group_enforcement",
  "recharge_codes",
  "recharge_requests",
  "weekly_settlement_items",
  "weekly_settlements",
  "inventory_reconciliations",
  "full_migration_stage_rows",
  "full_migration_runs",
  "migration_snapshots",
  "system_issues",
  "whatsapp_pending_movements",
  "inventory_reaction_cancellations",
  "friday_group_sessions",
  "whatsapp_cleanup_sessions",
  "whatsapp_delete_everyone_markers",
  "whatsapp_comparison_locks",
  "whatsapp_comparison_jobs",
  "whatsapp_dead_letters",
  "whatsapp_event_traces",
  "legacy_week_bridge_runs",
  "whatsapp_repair_runs",
  "whatsapp_events",
  "ledger_entries",
  "audit_logs"
]);

export function eventTimestampBeforeCleanSlate(value,cutoverAt){
  const timestamp=Number(value);
  const cutoverMs=new Date(cutoverAt||"").getTime();
  if(!Number.isFinite(timestamp)||timestamp<=0||!Number.isFinite(cutoverMs))return false;
  const eventMs=timestamp>1e11?timestamp:timestamp*1000;
  return eventMs<cutoverMs;
}

export function buildCleanSlateState({resetAt,captainCount=0,previousResetCount=0}={}){
  const iso=new Date(resetAt||Date.now()).toISOString();
  const resetCount=Math.max(1,Number(previousResetCount||0)+1);
  return {
    version:3,
    status:"COMPLETED",
    automaticStatus:"LIVE",
    resetAt:iso,
    autoCutoverAt:iso,
    lastStartedAt:iso,
    alwaysOn:true,
    resetByUserId:null,
    resetCount,
    epochId:`CLEAN-SLATE-${resetCount}-${iso.replace(/[^0-9]/g,"")}`,
    summary:{
      captains:Number(captainCount||0),
      affectedCaptains:Number(captainCount||0),
      captainsWithRecharge:0,
      rechargeMovements:0,
      currentTotal:0,
      preservedRechargeTotal:0,
      adjustmentTotal:0,
      completedAt:iso,
      resetCount,
      allBalancesZero:true,
      historicalLedgerDeleted:true
    }
  };
}
