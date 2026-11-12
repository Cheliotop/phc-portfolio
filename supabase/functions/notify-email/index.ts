// PHC notification email function. Client payloads identify an event only;
// authorization, recipients, and email content are derived from trusted state.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { publishableKey, serviceKey } from "../_shared/keys.ts";
import {
  createClient,
  type SupabaseClient,
} from "npm:@supabase/supabase-js@2.110.1";

type EventType = "pedido_created" | "completion_signed";

interface NotifyPayload {
  type?: unknown;
  entity_id?: unknown;
  data?: Record<string, unknown>;
}

interface CallerProfile {
  role: "admin" | "operator";
  is_active: boolean;
  username: string | null;
  full_name: string | null;
}

interface RenderedEmail {
  subject: string;
  html: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM_EMAIL") ||
  "PHC <onboarding@resend.dev>";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL")?.trim();

const serviceRoleKey = serviceKey;

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

const htmlEscape = (value: unknown) =>
  String(value ?? "-")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const subjectValue = (value: unknown) =>
  String(value ?? "")
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 160);

const eventId = (data: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
    if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
      return value.trim();
    }
  }
  return null;
};

const requireAdmin = (profile: CallerProfile) => {
  if (profile.role !== "admin") {
    throw new HttpError(
      403,
      "Solo un administrador puede enviar esta notificacion",
    );
  }
};

const renderPedidoCreated = async (
  caller: SupabaseClient<any>,
  userId: string,
  profile: CallerProfile,
  data: Record<string, unknown>,
): Promise<RenderedEmail> => {
  // Current clients send the full inserted row; only its canonical id is trusted.
  const pedidoId = eventId(data, "entity_id", "pedido_id", "id");
  if (!pedidoId) throw new HttpError(400, "pedido_id es obligatorio");

  const { data: pedido, error } = await caller
    .from("pedidos")
    .select(
      "id, pedido_number, project_id, operator_id, kind, justification, material, quantity, priority, reason",
    )
    .eq("id", pedidoId)
    .single();

  if (error || !pedido) {
    throw new HttpError(404, "Pedido no encontrado o sin acceso");
  }
  if (profile.role !== "admin" && pedido.operator_id !== userId) {
    throw new HttpError(403, "No autorizado para este pedido");
  }

  let projectName = "Sin proyecto";
  let wellName = "-";
  if (pedido.project_id !== null) {
    const { data: project, error: projectError } = await caller
      .from("projects")
      .select("id, name, well_name, assigned_operator_id")
      .eq("id", pedido.project_id)
      .single();

    if (projectError || !project) {
      throw new HttpError(403, "No autorizado para el proyecto del pedido");
    }
    if (profile.role !== "admin") {
      const { data: isCrew, error: crewError } = await caller.rpc("is_project_crew", {
        p_project_id: pedido.project_id,
      });
      if (crewError || isCrew !== true) {
        throw new HttpError(403, "No autorizado para el proyecto del pedido");
      }
    }
    projectName = project.name || `Proyecto ${project.id}`;
    wellName = project.well_name || "-";
  }

  const { data: requesterProfile } = await caller
    .from("profiles")
    .select("full_name, username")
    .eq("id", pedido.operator_id)
    .maybeSingle();
  const requester = requesterProfile?.full_name || requesterProfile?.username ||
    (pedido.operator_id === userId
      ? profile.full_name || profile.username || userId
      : pedido.operator_id);
  const number = pedido.pedido_number || `#${pedido.id}`;
  const { data: items, error: itemsError } = await caller
    .from("pedido_items")
    .select("material_name_snapshot, requested_quantity, unit_snapshot")
    .eq("pedido_id", pedido.id)
    .order("id", { ascending: true });
  if (itemsError) {
    throw new HttpError(403, "No autorizado para los items del pedido");
  }
  const itemList = (items || []).length > 0
    ? `<ul>${
      (items || []).map((item) =>
        `<li>${htmlEscape(item.material_name_snapshot)} — ${
          htmlEscape(item.requested_quantity)
        } ${htmlEscape(item.unit_snapshot)}</li>`
      ).join("")
    }</ul>`
    : `<p><b>Material:</b> ${htmlEscape(pedido.material)} (${
      htmlEscape(pedido.quantity)
    })</p>`;
  return {
    subject: `Nuevo pedido: ${subjectValue(number)}`,
    html: `<h2>Nuevo pedido de material</h2>
<p><b>Numero:</b> ${htmlEscape(number)}</p>
<p><b>Tipo:</b> ${htmlEscape(pedido.kind || "empresa")}</p>
<p><b>Proyecto:</b> ${htmlEscape(projectName)}</p>
<p><b>Pozo:</b> ${htmlEscape(wellName)}</p>
<p><b>Solicitado por:</b> ${htmlEscape(requester)}</p>
${itemList}
<p><b>Prioridad:</b> ${htmlEscape(pedido.priority || "Normal")}</p>
<p><b>Justificacion:</b> ${
      htmlEscape(pedido.justification || pedido.reason)
    }</p>`,
  };
};

const renderCompletionSigned = async (
  caller: SupabaseClient<any>,
  profile: CallerProfile,
  data: Record<string, unknown>,
): Promise<RenderedEmail> => {
  requireAdmin(profile);
  const reportId = eventId(data, "entity_id", "report_id", "id");
  if (!reportId) throw new HttpError(400, "report_id es obligatorio");

  let query = caller
    .from("completion_reports")
    .select("id, project_id, status, admin_signature, updated_at")
    .eq("status", "approved")
    .not("admin_signature", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1);
  query = query.eq("id", reportId);

  const { data: reports, error } = await query;
  const report = reports?.[0];
  if (error || !report || !String(report.admin_signature).trim()) {
    throw new HttpError(409, "El informe no esta firmado y aprobado");
  }

  const { data: project, error: projectError } = await caller
    .from("projects")
    .select("id, name, well_name")
    .eq("id", report.project_id)
    .single();
  if (projectError || !project) {
    throw new HttpError(404, "Proyecto no encontrado");
  }

  const projectName = project.name || `Proyecto ${project.id}`;
  return {
    subject: `Informe de cierre firmado: ${subjectValue(projectName)}`,
    html: `<h2>Informe de cierre firmado por administracion</h2>
<p><b>Proyecto:</b> ${htmlEscape(projectName)}</p>
<p><b>Pozo:</b> ${htmlEscape(project.well_name)}</p>`,
  };
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const authorization = req.headers.get("Authorization")?.trim() || "";
    if (!/^Bearer\s+\S+$/i.test(authorization)) {
      throw new HttpError(401, "No autenticado");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    // The legacy JWT anon key is disabled in production. Prefer the modern
    // publishable key supplied as a function secret; keep the built-in anon
    // value only for local Supabase and projects that have not rotated yet.
    const callerKey = publishableKey();
    if (!supabaseUrl || !callerKey) {
      throw new Error("Supabase environment is not configured");
    }

    const caller = createClient(supabaseUrl, callerKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Verify the JWT with Auth even when gateway verify_jwt is enabled.
    const { data: userData, error: userError } = await caller.auth.getUser();
    if (userError || !userData.user) throw new HttpError(401, "No autenticado");

    const { data: profileData, error: profileError } = await caller
      .from("profiles")
      .select("role, is_active, username, full_name")
      .eq("id", userData.user.id)
      .single();
    if (profileError || !profileData) {
      throw new HttpError(403, "Perfil no autorizado");
    }

    const profile = profileData as CallerProfile;
    if (profile.is_active !== true) {
      throw new HttpError(403, "Usuario desactivado");
    }
    if (profile.role !== "admin" && profile.role !== "operator") {
      throw new HttpError(403, "Perfil no autorizado");
    }

    let payload: NotifyPayload;
    try {
      payload = await req.json();
    } catch {
      throw new HttpError(400, "Cuerpo JSON invalido");
    }

    const type = payload.type;
    if (type !== "pedido_created" && type !== "completion_signed") {
      throw new HttpError(400, "Tipo de notificacion invalido");
    }
    const data = {
      ...(payload.data && typeof payload.data === "object" ? payload.data : {}),
      entity_id: payload.entity_id,
    };

    let email: RenderedEmail;
    switch (type as EventType) {
      case "pedido_created":
        email = await renderPedidoCreated(
          caller,
          userData.user.id,
          profile,
          data,
        );
        break;
      case "completion_signed":
        email = await renderCompletionSigned(caller, profile, data);
        break;
    }

    // Recipient is a server secret; client-supplied `to`/`subject` fields are ignored.
    if (!RESEND_API_KEY || !ADMIN_EMAIL) {
      console.warn(
        `[notify-email] ${type} authorized but skipped: email is not configured`,
      );
      return json(200, { sent: false, reason: "not_configured" });
    }

    // Notification leases are internal server state. Content queries remain
    // caller-scoped above, while only this service-role client can claim/mark
    // delivery so an authenticated app user cannot suppress an email.
    const serviceKey = serviceRoleKey();
    if (!serviceKey) {
      throw new Error("Supabase service environment is not configured");
    }
    const service = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const claimEntityId = eventId(
      data,
      "entity_id",
      "pedido_id",
      "report_id",
      "project_id",
      "id",
    );
    if (!claimEntityId) throw new HttpError(400, "entity_id es obligatorio");
    // Keep bigint identifiers as canonical decimal strings. Converting through
    // JavaScript Number can silently round values above Number.MAX_SAFE_INTEGER.
    const canonicalEntityId = claimEntityId;
    const { data: claimed, error: claimError } = await service.rpc(
      "claim_notification_event",
      {
        p_event_type: type,
        p_entity_id: canonicalEntityId,
        p_actor_id: userData.user.id,
      },
    );
    if (claimError) {
      console.error(
        "[notify-email] Could not claim event:",
        claimError.message,
      );
      return json(500, { sent: false, error: "claim_failed" });
    }
    if (claimed !== true) {
      return json(200, { sent: false, reason: "duplicate" });
    }

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `phc/${type}/${canonicalEntityId}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: ADMIN_EMAIL,
        subject: email.subject,
        html: email.html,
      }),
    });

    if (!resendResponse.ok) {
      const providerError = (await resendResponse.text()).slice(0, 1000);
      console.error(
        "[notify-email] Resend API error:",
        resendResponse.status,
        providerError,
      );
      // A different-payload 409 means this canonical event key was already
      // accepted previously. Mark it delivered so a later lease cannot send a
      // second email after Resend's 24-hour idempotency window expires.
      if (
        resendResponse.status === 409 &&
        providerError.includes("invalid_idempotent_request")
      ) {
        const { error: duplicateMarkError } = await service.rpc(
          "mark_notification_event_sent",
          {
            p_event_type: type,
            p_entity_id: canonicalEntityId,
            p_actor_id: userData.user.id,
          },
        );
        if (duplicateMarkError) {
          console.error(
            "[notify-email] Could not finalize provider duplicate:",
            duplicateMarkError.message,
          );
          return json(500, { sent: false, error: "mark_failed" });
        }
        return json(200, { sent: false, reason: "provider_duplicate" });
      }
      const { error: releaseError } = await service.rpc(
        "release_notification_event_claim",
        {
          p_event_type: type,
          p_entity_id: canonicalEntityId,
          p_actor_id: userData.user.id,
        },
      );
      if (releaseError) {
        console.error(
          "[notify-email] Could not release failed claim:",
          releaseError.message,
        );
      }
      return json(502, { sent: false, error: "email_provider_error" });
    }

    const { error: markError } = await service.rpc(
      "mark_notification_event_sent",
      {
        p_event_type: type,
        p_entity_id: canonicalEntityId,
        p_actor_id: userData.user.id,
      },
    );
    if (markError) {
      console.error(
        "[notify-email] Email sent but mark failed:",
        markError.message,
      );
      // Keep the claim leased. A retry uses the same provider idempotency key,
      // so it can safely reconcile delivery without sending a second email.
      return json(500, { sent: false, error: "mark_failed" });
    }

    return json(200, { sent: true });
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.message });
    }
    console.error("[notify-email] Unexpected error:", error);
    return json(500, { error: "internal_error" });
  }
});
