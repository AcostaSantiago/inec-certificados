import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { google } from "googleapis";

// Hasta 60 segundos en Vercel Hobby; en Pro puede ser 300
export const maxDuration = 60;

interface GenerateRequest {
  person: Record<string, string>;
  templateId: string;
  // Mapeo: nombre de variable en la plantilla → columna del CSV
  columnMapping: Record<string, string>;
  emailConfig: {
    emailColumn: string; // columna del CSV que contiene el email
    senderName: string;
    subject: string; // puede contener {{variables}}
    body: string;    // HTML, puede contener {{variables}}
  };
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  if (session.error) {
    return NextResponse.json(
      { error: "Token de Google expirado. Volvé a iniciar sesión." },
      { status: 401 }
    );
  }

  const body: GenerateRequest = await request.json();
  const { person, templateId, columnMapping, emailConfig } = body;

  // Configurar cliente OAuth2 — usa el access token del usuario logueado
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });

  const drive = google.drive({ version: "v3", auth });
  const slides = google.slides({ version: "v1", auth });
  const gmail = google.gmail({ version: "v1", auth });

  let copyId: string | null = null;

  try {
    // Nombre de la persona (primera variable mapeada)
    const nameVar = Object.keys(columnMapping)[0];
    const name = nameVar
      ? (person[columnMapping[nameVar]] ?? "Participante")
      : Object.values(person)[0] ?? "Participante";

    const recipientEmail = person[emailConfig.emailColumn];
    if (!recipientEmail?.includes("@")) {
      return NextResponse.json({
        success: false,
        error: `Email inválido: "${recipientEmail}"`,
      });
    }

    // 1. Copiar la plantilla en Google Drive
    const copyRes = await drive.files.copy({
      fileId: templateId,
      requestBody: { name: `cert_tmp_${Date.now()}` },
    });
    copyId = copyRes.data.id!;

    // 2. Reemplazar variables {{...}} en la copia
    const replaceRequests = Object.entries(columnMapping).map(
      ([variable, column]) => ({
        replaceAllText: {
          containsText: { text: `{{${variable}}}`, matchCase: true },
          replaceText: person[column] ?? "",
        },
      })
    );

    await slides.presentations.batchUpdate({
      presentationId: copyId,
      requestBody: { requests: replaceRequests },
    });

    // 3. Exportar como PDF
    const exportRes = await drive.files.export(
      { fileId: copyId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" }
    );
    const pdfBuffer = Buffer.from(exportRes.data as ArrayBuffer);

    // 4. Reemplazar variables en asunto y cuerpo del email
    let subject = emailConfig.subject;
    let htmlBody = emailConfig.body;
    for (const [variable, column] of Object.entries(columnMapping)) {
      const value = person[column] ?? "";
      const pattern = new RegExp(`\\{\\{${escapeRegex(variable)}\\}\\}`, "g");
      subject = subject.replace(pattern, value);
      htmlBody = htmlBody.replace(pattern, value);
    }

    // 5. Enviar email via Gmail API (OAuth, sin contraseña de app)
    //    El email sale desde la cuenta Google del usuario logueado
    const senderEmail = session.user?.email ?? "me";
    const filename = `Certificado_${sanitizeFilename(name)}.pdf`;
    const rawMessage = buildMimeMessage({
      from: `${emailConfig.senderName} <${senderEmail}>`,
      to: recipientEmail,
      subject,
      html: htmlBody,
      attachment: { filename, buffer: pdfBuffer },
    });

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: rawMessage },
    });

    return NextResponse.json({ success: true, name, email: recipientEmail });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    console.error("Error generando certificado:", msg);
    return NextResponse.json({ success: false, error: msg });
  } finally {
    // Eliminar la copia temporal de Drive
    if (copyId) {
      try {
        await drive.files.delete({ fileId: copyId });
      } catch {
        // Ignorar error de limpieza
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ\s._-]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

/**
 * Construye un mensaje MIME multipart con HTML + adjunto PDF,
 * codificado en base64url tal como requiere la Gmail API.
 */
function buildMimeMessage(opts: {
  from: string;
  to: string;
  subject: string;
  html: string;
  attachment: { filename: string; buffer: Buffer };
}): string {
  const boundary = `boundary_${Date.now()}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(opts.subject).toString("base64")}?=`;

  const [displayName, senderAddr] = opts.from.includes("<")
    ? [opts.from.split("<")[0].trim(), opts.from.match(/<(.+)>/)?.[1] ?? opts.from]
    : [opts.from, opts.from];
  const encodedFrom = `=?UTF-8?B?${Buffer.from(displayName).toString("base64")}?= <${senderAddr}>`;

  const lines: string[] = [
    `From: ${encodedFrom}`,
    `To: ${opts.to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(opts.html, "utf-8").toString("base64"),
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${opts.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    opts.attachment.buffer.toString("base64"),
    ``,
    `--${boundary}--`,
  ];

  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
