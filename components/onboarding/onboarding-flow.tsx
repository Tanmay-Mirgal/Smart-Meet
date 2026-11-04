"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CreateOrganization, useAuth, useOrganization } from "@clerk/nextjs";
import { Building2, CheckCircle2, ChevronRight, Languages, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createOrganizationAppearance } from "@/lib/clerk-appearance";
import {
  readStoredTranscriptionMode,
  storeTranscriptionMode,
  TRANSCRIPTION_MODE_OPTIONS,
  isTranscriptionMode,
} from "@/features/ai/lib/transcription-modes";
import type { TranscriptionMode } from "@/features/ai/hooks/use-transcription";
import { cn } from "@/lib/utils";

const USE_CASES = [
  { id: "product", title: "Product & Engineering", desc: "Sprint planning, design reviews, standups." },
  { id: "sales", title: "Sales & Marketing", desc: "Client pitches, campaign strategy, discovery." },
  { id: "leadership", title: "Executive Leadership", desc: "Board meetings, all-hands, strategic alignment." },
  { id: "consulting", title: "Consulting & Agencies", desc: "Client workshops, interviews, deliverables." },
] as const;

const STEPS = [
  { num: 1, label: "Use case", icon: Target },
  { num: 2, label: "Language", icon: Languages },
  { num: 3, label: "Workspace", icon: Building2 },
] as const;

export function OnboardingFlow() {
  const [step, setStep] = useState(1);
  const router = useRouter();
  const { isLoaded: isOrgLoaded, organization } = useOrganization();
  const { isLoaded: isAuthLoaded, userId } = useAuth();

  const [selectedUseCase, setSelectedUseCase] = useState<string | null>(null);
  const [language, setLanguage] = useState<TranscriptionMode>(
    () => readStoredTranscriptionMode() ?? "hindi_english_marathi",
  );

  useEffect(() => {
    if (isAuthLoaded && !userId) {
      router.push("/sign-in");
    }
  }, [isAuthLoaded, userId, router]);

  // An existing organization means onboarding is already done.
  useEffect(() => {
    if (isOrgLoaded && organization) {
      router.push("/dashboard");
    }
  }, [isOrgLoaded, organization, router]);

  if (!isAuthLoaded || !isOrgLoaded) {
    return (
      <div className="flex min-h-[60vh] w-full items-center justify-center">
        <div
          className="size-8 animate-spin rounded-full border-4 border-primary/30 border-t-primary"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (!userId || organization) {
    return null;
  }

  const handleLanguageContinue = () => {
    storeTranscriptionMode(language);
    setStep(3);
  };

  return (
    <div className="flex w-full justify-center animate-in fade-in duration-500">
      <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-border bg-card/80 p-6 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-12">
        {/* Progress */}
        <ol className="relative mb-12 flex items-center justify-between" aria-label="Onboarding progress">
          <div className="absolute top-5 right-10 left-10 -z-10 h-0.5 bg-border" aria-hidden="true" />
          <div
            className="absolute top-5 left-10 -z-10 h-0.5 bg-primary transition-all duration-500 ease-in-out"
            style={{ width: `calc((100% - 5rem) * ${(step - 1) / (STEPS.length - 1)})` }}
            aria-hidden="true"
          />
          {STEPS.map((s) => {
            const Icon = s.icon;
            const isActive = step === s.num;
            const isCompleted = step > s.num;
            return (
              <li
                key={s.num}
                aria-current={isActive ? "step" : undefined}
                className="relative z-10 flex flex-col items-center gap-2"
              >
                <span
                  className={cn(
                    "flex size-10 items-center justify-center rounded-full border-2 transition-all",
                    isActive && "border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/40",
                    isCompleted && "border-primary bg-primary/20 text-brand",
                    !isActive && !isCompleted && "border-border bg-background text-muted-foreground",
                  )}
                >
                  {isCompleted ? <CheckCircle2 className="size-5" /> : <Icon className="size-5" />}
                </span>
                <span
                  className={cn(
                    "text-xs font-bold tracking-tight",
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </span>
              </li>
            );
          })}
        </ol>

        {/* Step 1 — use case */}
        {step === 1 && (
          <div className="animate-in slide-in-from-right-4 fade-in space-y-8 duration-300">
            <div>
              <h2 className="mb-2 font-display text-2xl font-bold tracking-tight text-foreground">
                How will you use Meetup?
              </h2>
              <p className="text-sm font-medium text-muted-foreground">
                Pick the closest fit. You can run any kind of meeting later.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" role="group" aria-label="Use case">
              {USE_CASES.map((useCase) => {
                const selected = selectedUseCase === useCase.id;
                return (
                  <button
                    key={useCase.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedUseCase(useCase.id)}
                    className={cn(
                      "rounded-2xl border-2 p-5 text-left transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      selected
                        ? "border-primary bg-primary/10 shadow-lg shadow-primary/10"
                        : "border-border hover:border-primary/50 hover:bg-muted/50",
                    )}
                  >
                    <span className="mb-2 flex items-start justify-between gap-3">
                      <span className="text-sm font-bold text-foreground">{useCase.title}</span>
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-full border",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background",
                        )}
                      >
                        {selected && <CheckCircle2 className="size-3.5" />}
                      </span>
                    </span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">{useCase.desc}</span>
                  </button>
                );
              })}
            </div>

            <Button
              disabled={!selectedUseCase}
              onClick={() => setStep(2)}
              className="h-12 w-full rounded-xl text-base font-semibold"
            >
              Continue <ChevronRight className="ml-1 size-4" />
            </Button>
          </div>
        )}

        {/* Step 2 — language */}
        {step === 2 && (
          <div className="animate-in slide-in-from-right-4 fade-in space-y-8 duration-300">
            <div>
              <h2 className="mb-2 font-display text-2xl font-bold tracking-tight text-foreground">
                Spoken language
              </h2>
              <p className="text-sm font-medium text-muted-foreground">
                This is the default transcription mode in your meeting rooms. You can change it per
                meeting at any time.
              </p>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5">
              <label htmlFor="onboarding-language" className="mb-1 flex items-center gap-2 text-sm font-bold text-foreground">
                <Languages className="size-4 text-brand" />
                Transcription mode
              </label>
              <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
                Meetup tunes its speech recognition for the languages you pick.
              </p>
              <select
                id="onboarding-language"
                value={language}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isTranscriptionMode(value)) setLanguage(value);
                }}
                className="w-full rounded-xl border border-transparent bg-secondary p-3 text-sm font-medium text-foreground outline-none focus:ring-2 focus:ring-primary/30"
              >
                {TRANSCRIPTION_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-4">
              <Button variant="outline" onClick={() => setStep(1)} className="h-12 flex-1 rounded-xl">
                Back
              </Button>
              <Button onClick={handleLanguageContinue} className="h-12 flex-[2] rounded-xl text-base font-semibold">
                Continue <ChevronRight className="ml-1 size-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3 — organization */}
        {step === 3 && (
          <div className="animate-in slide-in-from-right-4 fade-in flex flex-col items-center space-y-8 text-center duration-300">
            <div>
              <h2 className="mb-2 font-display text-2xl font-bold tracking-tight text-foreground">
                Create your workspace
              </h2>
              <p className="mx-auto mb-6 max-w-md text-sm font-medium text-muted-foreground">
                Invite your team to collaborate on transcripts, action items and insights across your
                whole organization.
              </p>
            </div>

            <div className="mx-auto w-full max-w-md rounded-2xl border border-border bg-card p-2 shadow-sm">
              <CreateOrganization
                routing="hash"
                afterCreateOrganizationUrl="/dashboard"
                appearance={createOrganizationAppearance}
              />
            </div>

            <button
              type="button"
              onClick={() => setStep(2)}
              className="mt-4 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              Back to language
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
