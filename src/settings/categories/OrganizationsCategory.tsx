import { OrgSettings } from "../OrgSettings";

/** Settings › Organizations (signed in only). */
export function OrganizationsCategory({ onPendingCount }: Readonly<{ onPendingCount: (count: number) => void }>) {
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <OrgSettings onPendingCount={onPendingCount} />
    </section>
  );
}
