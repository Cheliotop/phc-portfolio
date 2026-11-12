// Deletes an admin attachment through the Storage API before finalizing its
// metadata/audit row. Direct SQL deletion from storage.objects can orphan the
// physical object and is deliberately not used.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.1";
import { publishableKey, serviceKey } from "../_shared/keys.ts";

interface DeleteAttachmentBody {
  attachment_id?: unknown;
  reason?: unknown;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders,
    },
  });

const serviceRoleKey = serviceKey;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const authorization = req.headers.get("Authorization")?.trim() || "";
    if (!/^Bearer\s+\S+$/i.test(authorization)) {
      return json(401, { error: "No autenticado" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = publishableKey();
    const serviceKey = serviceRoleKey();
    if (!supabaseUrl || !anonKey || !serviceKey) {
      throw new Error("Supabase environment is not configured");
    }

    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const service = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await caller.auth.getUser();
    if (userError || !userData.user) {
      return json(401, { error: "No autenticado" });
    }
    const { data: isAdmin, error: adminError } = await caller.rpc("is_admin");
    if (adminError || isAdmin !== true) {
      return json(403, {
        error: "Solo un administrador puede eliminar adjuntos",
      });
    }
    // is_admin() already includes is_active=true. Keep the second explicit
    // check at the destructive boundary so this invariant is obvious and
    // independently fails closed if the helper ever changes.
    const { data: isActive, error: activeError } = await caller.rpc(
      "is_active_user",
    );
    if (activeError || isActive !== true) {
      return json(403, { error: "Administrador desactivado" });
    }

    let body: DeleteAttachmentBody;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Cuerpo JSON invalido" });
    }

    const attachmentId = typeof body.attachment_id === "number" &&
        Number.isSafeInteger(body.attachment_id) && body.attachment_id > 0
      ? String(body.attachment_id)
      : typeof body.attachment_id === "string" &&
          /^[1-9]\d*$/.test(body.attachment_id.trim())
      ? body.attachment_id.trim()
      : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!attachmentId) {
      return json(400, { error: "attachment_id invalido" });
    }
    if (reason.length < 3) {
      return json(400, { error: "Motivo requerido" });
    }

    const { data: attachment, error: attachmentError } = await caller
      .from("project_attachments")
      .select("id, storage_path")
      .eq("id", attachmentId)
      .maybeSingle();
    if (attachmentError) {
      return json(403, { error: "No autorizado para este adjunto" });
    }
    // A completed retry is idempotent: metadata is already gone and the
    // Storage remove call from the successful attempt already ran.
    if (!attachment) {
      return json(200, { deleted: true, idempotent_replay: true });
    }

    const { error: removeError } = await service.storage
      .from("phc-reports")
      .remove([attachment.storage_path]);
    if (removeError) {
      console.error(
        "[admin-delete-project-attachment] Storage remove failed:",
        removeError.message,
      );
      return json(502, { error: "No se pudo eliminar el archivo almacenado" });
    }

    const { data: finalized, error: finalizeError } = await service.rpc(
      "finalize_project_attachment_delete",
      {
        p_attachment_id: attachmentId,
        p_expected_storage_path: attachment.storage_path,
        p_reason: reason,
        p_actor_id: userData.user.id,
      },
    );
    if (finalizeError) {
      // Removal is idempotent. A retry will remove the same path again and
      // finish metadata cleanup; never restore a file after physical deletion.
      console.error(
        "[admin-delete-project-attachment] Finalize failed:",
        finalizeError.message,
      );
      return json(500, {
        error: "Archivo eliminado; falta finalizar el registro. Reintenta.",
      });
    }

    return json(200, {
      deleted: finalized === true,
      idempotent_replay: finalized !== true,
    });
  } catch (error) {
    console.error("[admin-delete-project-attachment] Unexpected error:", error);
    return json(500, { error: "internal_error" });
  }
});
