import { SetupWizard } from "@/components/SetupWizard";

export default function Home() {
  return (
    <main className="min-h-screen py-10 px-4">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">INEC Certificados</h1>
          <p className="mt-2 text-gray-500">
            Generación y envío masivo de certificados desde Google Slides
          </p>
        </div>

        <SetupWizard />
      </div>
    </main>
  );
}
