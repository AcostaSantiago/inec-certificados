"use client";

import { useState, useRef, useCallback } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import Papa from "papaparse";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface TemplateInfo {
  title: string;
  slideCount: number;
  variables: string[];
}

interface CsvRow {
  [column: string]: string;
}

interface EmailConfig {
  emailColumn: string;
  senderName: string;
  subject: string;
  body: string;
}

interface LogEntry {
  name: string;
  email: string;
  ok: boolean;
  error?: string;
}

interface ProgressResult {
  total: number;
  sent: number;
  failed: number;
  errors: { name: string; email: string; error: string }[];
  log: LogEntry[];
  running: boolean;
  done: boolean;
}

type Step = "auth" | "template" | "csv" | "email" | "generate";

// ─── Componente principal ────────────────────────────────────────────────────

export function SetupWizard() {
  const { data: session, status } = useSession();

  const [step, setStep] = useState<Step>("auth");

  // Step 2 – Plantilla
  const [templateId, setTemplateId] = useState("");
  const [templateInfo, setTemplateInfo] = useState<TemplateInfo | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState("");

  // Step 3 – CSV
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});

  // Step 4 – Email
  const [emailConfig, setEmailConfig] = useState<EmailConfig>({
    emailColumn: "",
    senderName: "INEC Formación",
    subject: "Tu certificado de participación - Webinar Enfermería Neurológica",
    body: `<p>Hola!</p>
<p>Queremos agradecerte por haber sido parte del webinar<br>
<strong>"5 errores de enfermería que aumentan la presión intracraneana y cómo evitarlos"</strong>.<br>
Fue un encuentro muy valioso y nos alegra que hayas sido parte 🙌</p>
<p>📜 Encontrás tu certificado de participación adjunto en este email.</p>
<hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
<p>Y si querés seguir profundizando en este camino, te invitamos a dar el próximo paso en tu formación 👇</p>
<p>🧠 <strong>Curso: Atención del Paciente Neurocrítico en Medicina Intensiva</strong><br>
Comienza en abril<br>
Formación práctica y actualizada para el abordaje del paciente crítico neurológico</p>
<p>🫀 <strong>Nuevo curso: Cuidado del Paciente Cardiocrítico en Medicina Intensiva</strong><br>
Una propuesta enfocada en el monitoreo, reconocimiento y manejo del paciente cardiovascular crítico.</p>
<p>Más información en:<br>
<a href="https://inecformacion.com/">https://inecformacion.com/</a></p>
<p>Seguimos creciendo junto a profesionales de toda Latinoamérica 🌎<br>
y transformando juntos la forma de cuidar ✨</p>`,
  });

  // Step 5 – Progreso
  const [progress, setProgress] = useState<ProgressResult | null>(null);
  const abortRef = useRef(false);

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function previewTemplate() {
    setTemplateError("");
    setTemplateLoading(true);
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error desconocido");
      setTemplateInfo(data);
      if (csvHeaders.length > 0) autoMapColumns(data.variables, csvHeaders);
    } catch (e) {
      setTemplateError(
        e instanceof Error ? e.message : "Error al cargar la plantilla"
      );
    } finally {
      setTemplateLoading(false);
    }
  }

  function handleCsvUpload(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target?.result as ArrayBuffer;
      // Intentar UTF-8 estricto; si falla, usar Windows-1252 (Latin-1 extendido)
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        text = new TextDecoder("windows-1252").decode(buffer);
      }
      const lines = text.split(/\r?\n/).filter((l) => l.trim());

      // Detectar delimitador mirando la primera línea que tenga más de una columna
      let delimiter = ",";
      for (const line of lines) {
        if (line.includes(";")) { delimiter = ";"; break; }
        if (line.includes(",")) { delimiter = ","; break; }
      }

      // Saltear filas de título (las que no contienen el delimitador detectado)
      const dataLines = lines.filter((l) => l.includes(delimiter));
      const cleanText = dataLines.join("\n");

      Papa.parse<CsvRow>(cleanText, {
        header: true,
        skipEmptyLines: true,
        delimiter,
        complete(results) {
          const headers = results.meta.fields ?? [];
          setCsvHeaders(headers);
          setCsvRows(results.data);
          if (templateInfo) autoMapColumns(templateInfo.variables, headers);
          const emailCol = headers.find((h) => /email|correo|mail/i.test(h));
          if (emailCol) {
            setEmailConfig((prev) => ({ ...prev, emailColumn: emailCol }));
          }
        },
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function autoMapColumns(variables: string[], headers: string[]) {
    const mapping: Record<string, string> = {};
    for (const variable of variables) {
      const match = headers.find(
        (h) =>
          h.toLowerCase().includes(variable.toLowerCase()) ||
          variable.toLowerCase().includes(h.toLowerCase().split(" ")[0])
      );
      if (match) mapping[variable] = match;
    }
    setColumnMapping((prev) => ({ ...prev, ...mapping }));
  }

  const startGeneration = useCallback(async () => {
    abortRef.current = false;
    const result: ProgressResult = {
      total: csvRows.length,
      sent: 0,
      failed: 0,
      errors: [],
      log: [],
      running: true,
      done: false,
    };
    setProgress({ ...result });
    setStep("generate");

    for (let i = 0; i < csvRows.length; i++) {
      if (abortRef.current) break;

      const person = csvRows[i];
      try {
        const res = await fetch("/api/generate-one", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            person,
            templateId,
            columnMapping,
            emailConfig,
          }),
        });
        const data = await res.json();

        const entryName = data.name ?? person[Object.keys(person)[0]] ?? `Fila ${i + 1}`;
        const entryEmail = person[emailConfig.emailColumn] ?? "";
        if (data.success) {
          result.sent++;
          result.log.push({ name: entryName, email: entryEmail, ok: true });
        } else {
          result.failed++;
          const errMsg = data.error ?? "Error desconocido";
          result.errors.push({ name: entryName, email: entryEmail, error: errMsg });
          result.log.push({ name: entryName, email: entryEmail, ok: false, error: errMsg });
        }
      } catch (e) {
        const entryName = person[Object.keys(person)[0]] ?? `Fila ${i + 1}`;
        const entryEmail = person[emailConfig.emailColumn] ?? "";
        const errMsg = e instanceof Error ? e.message : "Error de red";
        result.failed++;
        result.errors.push({ name: entryName, email: entryEmail, error: errMsg });
        result.log.push({ name: entryName, email: entryEmail, ok: false, error: errMsg });
      }

      setProgress({ ...result });
      await delay(300);
    }

    result.running = false;
    result.done = true;
    setProgress({ ...result });
  }, [csvRows, templateId, columnMapping, emailConfig]);

  // ── Auth ──────────────────────────────────────────────────────────────────

  if (status === "loading") {
    return <div className="card text-center text-gray-500">Cargando...</div>;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <StepIndicator current={step} />

      {/* ── STEP 1: Auth ── */}
      {step === "auth" && (
        <div className="card text-center space-y-5">
          <div>
            <h2 className="text-xl font-semibold">Iniciar sesión con Google</h2>
            <p className="mt-2 text-sm text-gray-500 max-w-md mx-auto">
              Al iniciar sesión con tu cuenta Google, la app podrá acceder a tu
              Google Drive, Slides, y enviar emails desde tu Gmail.{" "}
              <strong>No necesitás contraseña de aplicación.</strong>
            </p>
          </div>

          {!session ? (
            <button
              onClick={() => signIn("google")}
              className="btn-primary mx-auto"
            >
              <GoogleIcon />
              Continuar con Google
            </button>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-3 p-3 bg-green-50 rounded-lg border border-green-200 max-w-xs mx-auto">
                {session.user?.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={session.user.image}
                    alt=""
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <div className="text-sm text-left">
                  <p className="font-medium text-green-800">{session.user?.name}</p>
                  <p className="text-green-600 text-xs">{session.user?.email}</p>
                </div>
              </div>

              <p className="text-xs text-gray-500">
                Los certificados se enviarán desde{" "}
                <strong>{session.user?.email}</strong>
              </p>

              {session.error && (
                <p className="text-sm text-red-600">
                  Sesión expirada. Volvé a iniciar sesión.
                </p>
              )}

              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => setStep("template")}
                  className="btn-primary"
                >
                  Continuar →
                </button>
                <button
                  onClick={() => signOut()}
                  className="btn-secondary text-xs"
                >
                  Cambiar cuenta
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── STEP 2: Plantilla ── */}
      {step === "template" && (
        <div className="card space-y-5">
          <h2 className="text-xl font-semibold">Plantilla de Google Slides</h2>
          <p className="text-sm text-gray-500">
            Abrí tu presentación en Google Slides y copiá el ID de la URL:
          </p>
          <div className="bg-gray-50 rounded-lg p-3 font-mono text-xs text-gray-600 break-all">
            docs.google.com/presentation/d/
            <span className="bg-yellow-200 text-yellow-900 px-0.5 rounded">
              1cjfcpMUIwwl36KTpXiRMPJr3hF6UvUo8HB8LWmzg0Sc
            </span>
            /edit
          </div>

          <div>
            <label className="label">ID de la presentación</label>
            <div className="flex gap-2">
              <input
                className="input"
                placeholder="1cjfcpMUIwwl36KTpXiRMPJr3hF6UvUo8HB8LWmzg0Sc"
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  setTemplateInfo(null);
                  setTemplateError("");
                }}
              />
              <button
                onClick={previewTemplate}
                disabled={!templateId.trim() || templateLoading}
                className="btn-primary shrink-0"
              >
                {templateLoading ? "..." : "Verificar"}
              </button>
            </div>
            {templateError && (
              <p className="mt-2 text-sm text-red-600">{templateError}</p>
            )}
          </div>

          {templateInfo && (
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-2">
              <p className="text-sm font-medium text-blue-900">
                ✓ {templateInfo.title}
              </p>
              <p className="text-xs text-blue-700">
                {templateInfo.slideCount} diapositiva(s)
              </p>
              {templateInfo.variables.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-blue-700">
                    Variables detectadas:
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {templateInfo.variables.map((v) => (
                      <span
                        key={v}
                        className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs font-mono"
                      >
                        {`{{${v}}}`}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-amber-700">
                  ⚠ No se detectaron variables. Usá el formato{" "}
                  <code>{`{{nombre}}`}</code> en tu plantilla.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button onClick={() => setStep("auth")} className="btn-secondary">
              ← Atrás
            </button>
            <button
              onClick={() => setStep("csv")}
              disabled={!templateInfo}
              className="btn-primary"
            >
              Continuar →
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3: CSV ── */}
      {step === "csv" && (
        <div className="card space-y-5">
          <h2 className="text-xl font-semibold">Lista de participantes (CSV)</h2>
          <p className="text-sm text-gray-500">
            Subí un archivo CSV con encabezados en la primera fila.
          </p>

          <CsvDropzone onFile={handleCsvUpload} />

          {csvRows.length > 0 && (
            <div className="space-y-4">
              <p className="text-sm font-medium text-green-700">
                ✓ {csvRows.length} participante(s) cargados
              </p>

              {/* Preview */}
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="text-xs w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      {csvHeaders.map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2 text-left font-medium text-gray-600 whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvRows.slice(0, 3).map((row, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        {csvHeaders.map((h) => (
                          <td
                            key={h}
                            className="px-3 py-1.5 text-gray-700 max-w-[180px] truncate"
                          >
                            {row[h]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mapeo de variables */}
              {templateInfo && templateInfo.variables.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-3">
                    Mapeá cada variable de la plantilla a su columna del CSV:
                  </p>
                  <div className="space-y-2">
                    {templateInfo.variables.map((variable) => (
                      <div key={variable} className="flex items-center gap-3">
                        <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded w-32 shrink-0">
                          {`{{${variable}}}`}
                        </span>
                        <span className="text-gray-400 text-sm">→</span>
                        <select
                          className="input"
                          value={columnMapping[variable] ?? ""}
                          onChange={(e) =>
                            setColumnMapping((prev) => ({
                              ...prev,
                              [variable]: e.target.value,
                            }))
                          }
                        >
                          <option value="">-- Elegir columna --</option>
                          {csvHeaders.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between pt-2">
            <button onClick={() => setStep("template")} className="btn-secondary">
              ← Atrás
            </button>
            <button
              onClick={() => setStep("email")}
              disabled={
                csvRows.length === 0 ||
                (templateInfo?.variables.length
                  ? templateInfo.variables.some((v) => !columnMapping[v])
                  : false)
              }
              className="btn-primary"
            >
              Continuar →
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 4: Email ── */}
      {step === "email" && (
        <div className="card space-y-5">
          <h2 className="text-xl font-semibold">Configuración del email</h2>

          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
            Los emails se enviarán desde{" "}
            <strong>{session?.user?.email}</strong> (tu cuenta Google).
            No hace falta contraseña adicional.
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 sm:col-span-1">
                <label className="label">Nombre del remitente</label>
                <input
                  className="input"
                  placeholder="INEC Formación"
                  value={emailConfig.senderName}
                  onChange={(e) =>
                    setEmailConfig((p) => ({ ...p, senderName: e.target.value }))
                  }
                />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="label">Columna de email en el CSV</label>
                <select
                  className="input"
                  value={emailConfig.emailColumn}
                  onChange={(e) =>
                    setEmailConfig((p) => ({ ...p, emailColumn: e.target.value }))
                  }
                >
                  <option value="">-- Elegir columna --</option>
                  {csvHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="label">Asunto del email</label>
              <input
                className="input"
                value={emailConfig.subject}
                onChange={(e) =>
                  setEmailConfig((p) => ({ ...p, subject: e.target.value }))
                }
              />
              <p className="mt-1 text-xs text-gray-400">
                Podés usar variables:{" "}
                {templateInfo?.variables.map((v) => (
                  <code key={v} className="mr-1">{`{{${v}}}`}</code>
                ))}
              </p>
            </div>

            <div>
              <label className="label">Cuerpo del email (HTML)</label>
              <textarea
                className="input font-mono text-xs"
                rows={7}
                value={emailConfig.body}
                onChange={(e) =>
                  setEmailConfig((p) => ({ ...p, body: e.target.value }))
                }
              />
              <p className="mt-1 text-xs text-gray-400">
                Podés usar las mismas variables que en la plantilla de Slides.
              </p>
            </div>
          </div>

          <div className="flex justify-between pt-2">
            <button onClick={() => setStep("csv")} className="btn-secondary">
              ← Atrás
            </button>
            <button
              onClick={startGeneration}
              disabled={!emailConfig.emailColumn || !emailConfig.subject}
              className="btn-primary"
            >
              Generar y enviar {csvRows.length} certificados →
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 5: Progreso ── */}
      {step === "generate" && progress && (
        <div className="card space-y-6">
          <div>
            <h2 className="text-xl font-semibold">
              {progress.done ? "Proceso completado" : "Generando certificados..."}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Enviando desde <strong>{session?.user?.email}</strong>
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-600">
              <span>
                {progress.sent + progress.failed} / {progress.total}
              </span>
              <span className="flex gap-3">
                <span className="text-green-600">{progress.sent} enviados</span>
                {progress.failed > 0 && (
                  <span className="text-red-600">{progress.failed} errores</span>
                )}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                style={{
                  width: `${Math.round(
                    ((progress.sent + progress.failed) / progress.total) * 100
                  )}%`,
                }}
              />
            </div>
          </div>

          {/* Log en tiempo real */}
          {progress.log.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Registro de envíos:</p>
              <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                {[...progress.log].reverse().map((entry, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 text-xs p-2 rounded border ${
                      entry.ok
                        ? "bg-green-50 border-green-100 text-green-800"
                        : "bg-red-50 border-red-100 text-red-700"
                    }`}
                  >
                    <span className="shrink-0">{entry.ok ? "✓" : "✗"}</span>
                    <span className="font-medium truncate max-w-[180px]">{entry.name}</span>
                    <span className="text-gray-400 truncate">{entry.email}</span>
                    {!entry.ok && entry.error && (
                      <span className="ml-auto shrink-0 text-red-600">{entry.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {progress.running && !abortRef.current && (
            <button
              onClick={() => (abortRef.current = true)}
              className="btn-secondary text-sm"
            >
              Pausar envío
            </button>
          )}

          {progress.done && (
            <div
              className={`p-4 rounded-lg border ${
                progress.failed === 0
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-amber-50 border-amber-200 text-amber-800"
              }`}
            >
              <p className="font-medium text-sm">
                {progress.failed === 0
                  ? `¡Listo! ${progress.sent} certificados enviados correctamente.`
                  : `Completado. ${progress.sent} enviados, ${progress.failed} con errores.`}
              </p>
            </div>
          )}

          {progress.errors.length > 0 && (
            <div>
              <p className="text-sm font-medium text-red-700 mb-2">
                Errores ({progress.errors.length}):
              </p>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {progress.errors.map((e, i) => (
                  <div
                    key={i}
                    className="text-xs p-2 bg-red-50 rounded border border-red-100 text-red-700"
                  >
                    <span className="font-medium">{e.name}</span> ({e.email}) —{" "}
                    {e.error}
                  </div>
                ))}
              </div>
            </div>
          )}

          {progress.done && (
            <button
              onClick={() => {
                setStep("email");
                setProgress(null);
              }}
              className="btn-secondary"
            >
              ← Volver a configuración
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "auth", label: "Login" },
    { id: "template", label: "Plantilla" },
    { id: "csv", label: "CSV" },
    { id: "email", label: "Email" },
    { id: "generate", label: "Envío" },
  ];

  const currentIndex = steps.findIndex((s) => s.id === current);

  return (
    <div className="flex items-center justify-center gap-2 mb-2">
      {steps.map((s, i) => {
        const isCompleted = i < currentIndex;
        const isCurrent = i === currentIndex;
        return (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={`step-badge text-xs ${
                isCompleted
                  ? "bg-blue-600 text-white"
                  : isCurrent
                  ? "bg-blue-100 text-blue-700 ring-2 ring-blue-600"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              {isCompleted ? "✓" : i + 1}
            </div>
            <span
              className={`hidden sm:block text-xs font-medium ${
                isCurrent
                  ? "text-blue-700"
                  : isCompleted
                  ? "text-gray-600"
                  : "text-gray-400"
              }`}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <div
                className={`w-6 h-0.5 ${
                  i < currentIndex ? "bg-blue-400" : "bg-gray-200"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CsvDropzone({ onFile }: { onFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
        dragging
          ? "border-blue-400 bg-blue-50"
          : "border-gray-300 hover:border-blue-400"
      }`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      <p className="text-2xl mb-2">📄</p>
      <p className="text-sm font-medium text-gray-700">
        Arrastrá tu CSV aquí o hacé clic para seleccionar
      </p>
      <p className="text-xs text-gray-400 mt-1">
        Archivo .csv con encabezados en la primera fila
      </p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="w-4 h-4"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
