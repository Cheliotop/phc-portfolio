import { execute } from '../db/db';
import { deleteOutbox, selectDrainableOutboxRows, type DrainableOutboxRow } from '../db/operations';
import { recordSyncFailure } from './rejection';
import { pedidosApi } from '../api/supabase-pedidos';
import { materialsApi } from '../api/supabase-materials';
import { completionApi } from '../api/supabase-completion';
import { errorMessage } from '../utils/errorMessage';

// Mirrors src/sync/drillingSync.ts's pattern (see that file for the fuller
// write-up of why this matters): drilling bars were the only entity that
// actually queued through sync_outbox, even though pedidos/material
// consumption/completion reports are just as likely to be submitted with no
// signal on a drilling site, and the product's stated rule is that *all*
// offline work should save locally and sync automatically. These three
// functions close that gap for the remaining entities.

const parsePayload = (row: DrainableOutboxRow) => {
  try {
    return JSON.parse(row.payload_json);
  } catch {
    throw new Error(`Invalid queued ${row.entity} payload`);
  }
};

export const syncPendingPedidos = async (): Promise<{ synced: number; failed: number }> => {
  const rows = await selectDrainableOutboxRows('pedido');

  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const payload = parsePayload(row);
      const result = await pedidosApi.create(payload, row.author_id);

      await execute(
        // row.entity_id is the client_entry_id STRING queued by the pedidos tab,
        // while supply_requests.id is an INTEGER AUTOINCREMENT. Matching on id
        // compares an integer column to a string and updates 0 rows, so the
        // local row stayed 'pending' forever. Key on client_entry_id instead.
        `UPDATE supply_requests
         SET sync_status = 'synced', server_id = ?, pedido_number = ?, last_error = NULL, updated_at = ?
         WHERE client_entry_id = ?`,
        [result?.id ?? null, result?.pedido_number ?? null, new Date().toISOString(), row.entity_id]
      );

      await deleteOutbox(row.id);
      synced += 1;
    } catch (error: any) {
      const message = errorMessage(error);
      await execute(
        `UPDATE supply_requests SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE client_entry_id = ?`,
        [message, new Date().toISOString(), row.entity_id]
      );
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }

  return { synced, failed };
};

export const syncPendingMaterialConsumption = async (): Promise<{ synced: number; failed: number }> => {
  const rows = await selectDrainableOutboxRows('material_consumption');

  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const payload = parsePayload(row);
      const { project_id, ...rest } = payload;
      const response = await materialsApi.recordConsumption(project_id, { ...rest, enteredBy: row.author_id });

      await execute(
        // Same integer-vs-string mismatch as supply_requests above:
        // row.entity_id is the client_entry_id STRING (queued by MaterialesTab)
        // but material_consumption.id is INTEGER AUTOINCREMENT. Keying on id
        // matched 0 rows and left the row stuck 'pending'. Use client_entry_id.
        `UPDATE material_consumption SET sync_status = 'synced', server_id = ?, last_error = NULL, updated_at = ? WHERE client_entry_id = ?`,
        [response.data?.id ?? null, new Date().toISOString(), row.entity_id]
      );

      await deleteOutbox(row.id);
      synced += 1;
    } catch (error: any) {
      const message = errorMessage(error);
      await execute(
        `UPDATE material_consumption SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE client_entry_id = ?`,
        [message, new Date().toISOString(), row.entity_id]
      );
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }

  return { synced, failed };
};

export const syncPendingCompletionReports = async (): Promise<{ synced: number; failed: number }> => {
  const rows = await selectDrainableOutboxRows('completion_report');

  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const payload = parsePayload(row);

      // The PDF is generated on-device (expo-print) at submit time and its
      // local file uri is queued in the payload — generating it doesn't need
      // network, only uploading it does, so we defer the actual Storage
      // upload to here, when we know we're online.
      let pdfUrl: string | undefined;
      if (payload.pdf_local_uri) {
        try {
          pdfUrl = await completionApi.uploadReportPdf(
            payload.project_id,
            payload.pdf_local_uri,
            'initial',
            payload.client_entry_id,
          );
        } catch (pdfError) {
          // FAIL this row so it stays in the outbox and retries later. The
          // previous warn-and-continue behavior created the report WITHOUT a
          // PDF, marked it synced, and deleted the outbox row — permanently
          // losing the PDF (2026-07-09 client-readiness audit, High #2).
          // completionApi.create is idempotent via client_entry_id, so a
          // later retry after a partial failure cannot double-create.
          throw pdfError instanceof Error
            ? pdfError
            : new Error(`PDF upload failed: ${String(pdfError)}`);
        }
      }

      // The device-local file uri is not part of the report.
      const report = { ...payload, pdf_url: pdfUrl ?? payload.pdf_url };
      delete report.pdf_local_uri;
      const response = await completionApi.create(report);

      await execute(
        `UPDATE completion_reports_local
         SET sync_status = 'synced', server_id = ?, pdf_url = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
        [response.data?.id ?? null, pdfUrl ?? null, new Date().toISOString(), row.entity_id]
      );

      await deleteOutbox(row.id);
      synced += 1;
    } catch (error: any) {
      const message = errorMessage(error);
      await execute(
        `UPDATE completion_reports_local SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
        [message, new Date().toISOString(), row.entity_id]
      );
      await recordSyncFailure(row.id, error, message);
      failed += 1;
    }
  }

  return { synced, failed };
};

export const syncAllPending = async (): Promise<{ synced: number; failed: number }> => {
  const results = await Promise.all([
    syncPendingPedidos(),
    syncPendingMaterialConsumption(),
    syncPendingCompletionReports(),
  ]);
  return results.reduce(
    (acc, r) => ({ synced: acc.synced + r.synced, failed: acc.failed + r.failed }),
    { synced: 0, failed: 0 }
  );
};
