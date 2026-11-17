import type { Language } from "@codesync/shared";

const LABELS: Record<Language, { label: string; className: string }> = {
  javascript: {
    label: "JavaScript",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
  },
  python: {
    label: "Python",
    className: "bg-sky-100 text-sky-900 dark:bg-sky-400/15 dark:text-sky-200",
  },
};

export function LanguageBadge({ language }: { language: Language }) {
  const { label, className } = LABELS[language];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>
  );
}
