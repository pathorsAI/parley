import type { ReactNode } from "react";

/**
 * A step's "you're set" card, from the Figma signed-in frame: it fills the
 * dialog, and centres green pills (who or what is confirmed), a blue title and
 * a grey line over the blue fade and its line art. Used once signed in, and on
 * the organization step once the user is a member.
 */
export function ConfirmCard({
  pills,
  title,
  body,
  children,
}: Readonly<{
  pills: { key: string; icon: ReactNode; label: string }[];
  title: string;
  body: string;
  /** Anything that still needs doing here (a pending invitation), under the text. */
  children?: ReactNode;
}>) {
  return (
    <section className="relative flex min-h-fit flex-1 flex-col items-center justify-center overflow-hidden bg-linear-to-b from-[#e1f2fd] to-white p-5 dark:from-primary/15 dark:to-transparent">
      <div className="flex w-full flex-col items-center gap-6">
        <div className="flex flex-wrap justify-center gap-2">
          {pills.map((pill) => (
            <span
              key={pill.key}
              className="inline-flex items-center gap-2 rounded-full bg-[#d9f7e5] px-3 py-1 text-sm leading-[1.3] text-[#006a3b] dark:bg-success dark:text-success-foreground"
            >
              {pill.icon}
              {pill.label}
            </span>
          ))}
        </div>
        <div className="flex w-full flex-col gap-1 text-center text-sm">
          <p className="leading-relaxed font-medium text-primary">{title}</p>
          <p className="leading-[1.2] text-[#333]/70 dark:text-muted-foreground">{body}</p>
        </div>
        {children}
      </div>
      <img
        src="/onboarding/signedin-member-lines.svg"
        alt=""
        aria-hidden
        className="pointer-events-none absolute top-0 left-[-444px] h-[415px] w-[967px] max-w-none"
      />
    </section>
  );
}
