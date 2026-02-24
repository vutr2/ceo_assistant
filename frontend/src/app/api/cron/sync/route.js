import { NextResponse } from 'next/server';
import {
  getServerSupabase,
  upsertOrders,
  upsertExpenses,
  upsertInventory,
  upsertEmployees,
  upsertSheetData,
  recalculateDailyMetrics,
  checkAndCreateAlerts,
  updateSheetLastSync,
} from '../../../../lib/supabase';
import { readAllTabs, parseDynamicRows } from '../../../../lib/googleSheets';

const CRON_SECRET = process.env.CRON_SECRET;

async function syncUserSheet(userId, sheet) {
  const sheetsData = await readAllTabs(sheet.sheet_id);
  const affectedDates = new Set();
  let totalRows = 0;

  for (const [tabName, rawRows] of Object.entries(sheetsData)) {
    const parsed = parseDynamicRows(tabName, rawRows);
    if (parsed.type === 'empty' || parsed.rows.length === 0) continue;

    if (parsed.type === 'known') {
      switch (parsed.sheetType) {
        case 'orders':
          await upsertOrders(userId, parsed.rows);
          parsed.rows.forEach((r) => r.date && affectedDates.add(r.date));
          break;
        case 'expenses':
          await upsertExpenses(userId, parsed.rows);
          parsed.rows.forEach((r) => r.date && affectedDates.add(r.date));
          break;
        case 'inventory':
          await upsertInventory(userId, parsed.rows);
          break;
        case 'employees':
          await upsertEmployees(userId, parsed.rows);
          break;
      }
    } else {
      await upsertSheetData(userId, tabName, parsed.rows);
    }
    totalRows += parsed.rows.length;
  }

  for (const date of affectedDates) {
    await recalculateDailyMetrics(userId, date);
    await checkAndCreateAlerts(userId, date);
  }

  await updateSheetLastSync(userId, sheet.sheet_id);

  return { totalRows, dates: affectedDates.size };
}

export async function GET(request) {
  try {
    // Verify cron secret — always required
    const authHeader = request.headers.get('authorization');
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getServerSupabase();

    // Get all Pro users (active pro or pro_cancelled with valid expiry) who have connected sheets
    const now = new Date().toISOString();
    const { data: proUsers } = await db
      .from('users')
      .select('id, plan, plan_expires_at')
      .in('plan', ['pro', 'pro_cancelled'])
      .gte('plan_expires_at', now);

    if (!proUsers || proUsers.length === 0) {
      return NextResponse.json({ message: 'No active Pro users', synced: 0 });
    }

    const results = [];

    for (const user of proUsers) {
      // Get user's active sheet
      const { data: sheet } = await db
        .from('user_sheets')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!sheet) continue;

      try {
        const result = await syncUserSheet(user.id, sheet);
        results.push({
          userId: user.id,
          success: true,
          ...result,
        });
        console.log(`[Cron Sync] User ${user.id}: ${result.totalRows} rows, ${result.dates} dates`);
      } catch (err) {
        results.push({
          userId: user.id,
          success: false,
          error: err.message,
        });
        console.error(`[Cron Sync] User ${user.id} failed:`, err.message);
      }
    }

    return NextResponse.json({
      message: `Synced ${results.filter((r) => r.success).length}/${proUsers.length} users`,
      synced: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron Sync] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
