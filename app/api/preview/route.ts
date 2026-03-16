import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Máxima duración en Vercel (segundos)
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const { templateId } = await request.json();
  if (!templateId?.trim()) {
    return NextResponse.json({ error: "ID de plantilla requerido" }, { status: 400 });
  }

  // Obtener la presentación desde Google Slides API
  const response = await fetch(
    `https://slides.googleapis.com/v1/presentations/${templateId.trim()}`,
    { headers: { Authorization: `Bearer ${session.accessToken}` } }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg =
      response.status === 404
        ? "Plantilla no encontrada. Verificá el ID."
        : response.status === 403
        ? "Sin acceso a esa presentación. Compartila con tu cuenta Google."
        : err.error?.message || "Error al acceder a la plantilla.";
    return NextResponse.json({ error: msg }, { status: response.status });
  }

  const presentation = await response.json();
  const variables = detectVariables(presentation);

  return NextResponse.json({
    title: presentation.title,
    slideCount: presentation.slides?.length ?? 0,
    variables,
  });
}

// Extrae todas las variables {{...}} del texto de la presentación
function detectVariables(presentation: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const regex = /\{\{([^}]+)\}\}/g;

  const slides = presentation.slides as Record<string, unknown>[] | undefined;
  for (const slide of slides ?? []) {
    const elements = slide.pageElements as Record<string, unknown>[] | undefined;
    for (const el of elements ?? []) {
      const shape = el.shape as Record<string, unknown> | undefined;
      const textContent = shape?.text as Record<string, unknown> | undefined;
      const textElements = textContent?.textElements as Record<string, unknown>[] | undefined;
      const text = (textElements ?? [])
        .map((te) => (te.textRun as Record<string, unknown> | undefined)?.content ?? "")
        .join("");

      let match: RegExpExecArray | null;
      // Reset lastIndex between iterations
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        found.add(match[1].trim());
      }
    }
  }

  return Array.from(found);
}
